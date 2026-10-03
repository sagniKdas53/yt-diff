import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { readdir, rm } from "../../utils/fs.ts";
import { json } from "../../utils/http.ts";
import { join } from "../../utils/path.ts";
import type { ListingRuntime } from "./listing.ts";
import type {
  DownloadProcessEntry,
  JobAction,
  JobActionRequestBody,
  JobActionResult,
  JobIdentity,
  JobKind,
  JobState,
  JobView,
  ListingProcessEntry,
  PausedJob,
  ProcessLike,
} from "./types.ts";

/**
 * The state table the download manager is built against, in one place.
 *
 * A job is queued, running or paused, and every action is answered from that
 * one fact. The distinction the whole design turns on is bytes: pausing keeps
 * them, cancelling throws them away. yt-dlp resumes from a `.part` with no
 * extra flags, so a pause costs one re-run and a resume costs nothing but
 * time, while a cancel is the user saying "I don't want this" — and leaving
 * half a video on disk would be the one outcome they did not ask for.
 */

/**
 * How long a signalled yt-dlp is given to exit on its own before it is killed.
 *
 * yt-dlp closes its files on SIGTERM, so this is normally not spent at all —
 * it is here for the run that does not, and short enough that a cancel stays
 * a click rather than a wait.
 */
const TERMINATION_GRACE_MS = 3_000;

/** Said when the action does not apply, which is why no files are reported. */
function notAllowed(
  id: string,
  action: JobAction,
  detail: string,
): JobActionResult {
  return { id, action, outcome: "not-allowed", partialDeleted: null, detail };
}

function notFound(id: string, action: JobAction): JobActionResult {
  return {
    id,
    action,
    outcome: "not-found",
    partialDeleted: null,
    detail: "That job is no longer running — it may have finished.",
  };
}

/**
 * The three states, derived from what the entry holds rather than stored.
 *
 * A download registers itself *before* it takes a slot, so "pending" there is
 * a job still waiting for one. A listing registers *after* acquiring, so its
 * "pending" is already working — numbering that as waiting would put a running
 * listing in the queue and shift every job behind it.
 */
function stateOf(record: JobIdentity, kind: JobKind): JobState {
  if (record.paused) return "paused";
  if (record.status === "pending" && kind === "download") return "queued";
  return "running";
}

function jobView(record: JobIdentity, kind: JobKind): JobView {
  // Field by field rather than spread: an entry also carries what a resume
  // needs — the item, the save path, the file name — and none of that is the
  // drawer's business.
  return {
    id: record.id,
    kind,
    url: record.url,
    title: record.title,
    state: stateOf(record, kind),
    queuePosition: record.queuePosition,
    progress: record.progress,
    itemsIndexed: record.itemsIndexed,
    startedAt: record.startedAt,
  };
}

/**
 * Numbers the jobs still waiting 1..n and zeroes everything already working.
 *
 * The entry's own `queuePosition` is a monotonic acceptance order, not a place
 * in line: it counts jobs that have since started, so reporting it as-is
 * would tell a waiting job it is fourth when two of the three ahead of it are
 * already running. Queued jobs keep the order they were accepted in; running
 * and paused jobs hold no slot and report 0.
 */
function numberQueued(views: JobView[]): JobView[] {
  const byAcceptance = [...views].sort((a, b) =>
    a.queuePosition - b.queuePosition
  );
  let waiting = 0;
  return byAcceptance.map((view) =>
    view.state === "queued"
      ? { ...view, queuePosition: ++waiting }
      : { ...view, queuePosition: 0 }
  );
}

/**
 * Everything the server currently knows about one kind of job.
 *
 * Paused jobs are read from their own map: they hold no process, so they have
 * no business in the process maps the cleanup job sweeps, but they are still
 * jobs the user can see and act on.
 */
function snapshot(
  entries: Iterable<JobIdentity>,
  kind: JobKind,
  pausedJobs: Map<string, PausedJob>,
): JobView[] {
  const views = Array.from(entries, (entry) => jobView(entry, kind));
  for (const job of pausedJobs.values()) {
    if (job.kind === kind) {
      views.push(jobView(job, kind));
    }
  }
  return numberQueued(views);
}

/**
 * True for one file's partial shapes and nothing else.
 *
 * Two downloads can share a save directory, so a wider glob — anything ending
 * in `.part`, or a scan of the folder — would take out a neighbour's bytes.
 */
function isPartialOf(name: string, fileName: string): boolean {
  return name === `${fileName}.part` ||
    name === `${fileName}.ytdl` ||
    name.startsWith(`${fileName}.part-Frag`);
}

/**
 * Deletes what yt-dlp writes beside an unfinished transfer.
 *
 * Exactly three shapes, all keyed on the one file name this job reported: the
 * `.part` itself, the `.part-FragN` fragments of a fragmented download, and
 * the `.ytdl` sidecar it resumes from.
 *
 * @returns Whether the deletion ran. False when the file name never arrived:
 * guessing at partials by scanning the directory is worse than leaving bytes
 * the reaper will clean up.
 */
async function deletePartials(
  jobId: string,
  savePath: string | undefined,
  fileName: string | null | undefined,
): Promise<boolean> {
  if (!savePath || !fileName) {
    logger.warn("Could not locate a job's partial files", {
      jobId,
      savePath,
      fileName,
    });
    return false;
  }

  let names: string[];
  try {
    names = await readdir(savePath);
  } catch (error) {
    logger.error("Could not read a job's folder to clear its partials", {
      jobId,
      savePath,
      error: (error as Error).message,
    });
    return false;
  }

  const removed: string[] = [];
  for (const name of names.filter((name) => isPartialOf(name, fileName))) {
    const path = join(savePath, name);
    try {
      await rm(path);
      removed.push(path);
    } catch (error) {
      logger.error("Could not delete a partial file", {
        jobId,
        path,
        error: (error as Error).message,
      });
    }
  }

  logger.info("Cleared a job's partial files", {
    jobId,
    fileName,
    paths: removed.join(", "),
  });
  return true;
}

export interface JobControlDependencies {
  downloadProcesses: Map<string, DownloadProcessEntry>;
  listProcesses: Map<string, ListingProcessEntry>;
  listingRuntime: ListingRuntime;
  /** Jobs stopped on request, and the state they are waiting in. */
  pausedJobs: Map<string, PausedJob>;
  /** Re-enters the download queue under a paused job's own id. */
  resumeDownload: (job: PausedJob) => void;
  /** Re-runs a paused listing under its own id. */
  resumeListing: (job: PausedJob) => void;
}

/** What the routes, the drawer and the tests can ask of a job. */
export interface JobControl {
  /** The downloads `/queuestatus` reports as `queue`. */
  getQueueSnapshot: () => JobView[];
  /** The playlist listings `/queuestatus` reports as `listings`. */
  getListingSnapshot: () => JobView[];
  pauseJob: (id: string) => JobActionResult;
  resumeJob: (id: string) => JobActionResult;
  cancelJob: (id: string) => Promise<JobActionResult>;
}

function findById<T extends JobIdentity>(
  entries: Map<string, T>,
  id: string,
): { key: string; entry: T } | null {
  for (const [key, entry] of entries) {
    if (entry.id === id) return { key, entry };
  }
  return null;
}

/** The fields every job record carries, whichever kind of job it is. */
function pausedIdentity(
  entry: JobIdentity,
): Omit<JobIdentity, "itemsIndexed"> {
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    status: entry.status,
    paused: true,
    queuePosition: entry.queuePosition,
    startedAt: entry.startedAt,
    progress: entry.progress,
  };
}

export function createJobControl(deps: JobControlDependencies): JobControl {
  const {
    downloadProcesses,
    listProcesses,
    listingRuntime,
    pausedJobs,
    resumeDownload,
    resumeListing,
  } = deps;

  /**
   * What a resume needs, read off a download entry.
   *
   * A pure read, so a cancel can use the same shape without leaving the job
   * behind: only a pause stores what it returns, because only a pause is
   * something the job comes back from.
   */
  function pausedDownload(entry: DownloadProcessEntry): PausedJob {
    return {
      ...pausedIdentity(entry),
      kind: "download",
      itemsIndexed: null,
      item: entry.item,
      savePath: entry.savePath,
      fileName: entry.fileName ?? null,
    };
  }

  /** The same, for a listing: no bytes, but how far the index got. */
  function pausedListing(entry: ListingProcessEntry): PausedJob {
    return {
      ...pausedIdentity(entry),
      kind: "listing",
      // Rows are the listing's progress; it transfers nothing.
      progress: null,
      itemsIndexed: entry.itemsIndexed,
      item: entry.item,
      chunkSize: entry.chunkSize,
      isScheduledUpdate: entry.isScheduledUpdate,
    };
  }

  function terminate(
    id: string,
    process: NonNullable<ProcessLike["spawnedProcess"]>,
  ) {
    try {
      process.kill("SIGTERM");
    } catch (error) {
      logger.warn("Could not signal a job's process", {
        id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Waits for a signalled process to actually be gone.
   *
   * The exit code is not what is being waited for; the file handles are. A
   * cancel deletes the partial file the process was writing to, and deleting it
   * while yt-dlp still has it open lets a last buffered write put it straight
   * back — the one outcome a cancel is not allowed to produce. SIGTERM is what
   * yt-dlp exits on, so this normally returns at once; the escalation is for
   * the case where it does not, and it is bounded so a cancel can never hang.
   */
  async function awaitExit(
    id: string,
    process: NonNullable<ProcessLike["spawnedProcess"]>,
  ): Promise<void> {
    // A listing's process is only ever a `kill` handle, so there is nothing
    // to wait on for one — and nothing it could be writing a partial with.
    const status = (process as { status?: Promise<Deno.CommandStatus> }).status;
    if (!status) return;

    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        status,
        // Resolves either way once the grace period is up, so a process that
        // takes no notice of SIGKILL cannot hold a cancel open forever. What
        // is being waited for is the handles closing, and after SIGKILL there
        // is nothing further this can usefully do about them.
        new Promise<void>((resolve) => {
          grace = setTimeout(() => {
            logger.warn("A signalled job did not exit; sending SIGKILL", {
              id,
            });
            try {
              process.kill("SIGKILL");
            } catch (error) {
              logger.warn("Could not SIGKILL a job's process", {
                id,
                error: (error as Error).message,
              });
            }
            resolve();
          }, TERMINATION_GRACE_MS);
        }),
      ]);
    } catch (error) {
      logger.warn("Could not read a job's exit status", {
        id,
        error: (error as Error).message,
      });
    } finally {
      // Cleared rather than unref'd. While this is waiting the loop is held on
      // purpose, and a pending timer that does not count would let the runtime
      // call the wait over before the process is.
      if (grace !== undefined) clearTimeout(grace);
    }
  }

  /**
   * Stops a running job and keeps what it had already fetched.
   *
   * The process goes, and so does the entry: a paused job holds no slot, and a
   * map the cleanup job sweeps on staleness clocks would reap it while the
   * user is still deciding what to do with it.
   */
  function pauseJob(id: string): JobActionResult {
    const download = findById(downloadProcesses, id);
    if (download) {
      const { key, entry } = download;
      if (!entry.spawnedProcess) {
        return notAllowed(
          id,
          "pause",
          "That job has not started yet, so there is nothing to pause.",
        );
      }
      // Marked on the entry itself, not just on the copy kept for the resume:
      // the run being abandoned still holds this object and is about to see
      // its process exit on a SIGTERM, which is the same signal a cancellation
      // sends. This is the one thing that tells the two apart, and without it
      // a pause writes "process was killed" onto the video and tells the UI
      // the download failed.
      entry.paused = true;
      const paused = pausedDownload(entry);
      pausedJobs.set(paused.id, paused);
      downloadProcesses.delete(key);
      terminate(entry.id, entry.spawnedProcess);
      logger.info("Paused a download; its partial files are kept", {
        id,
        url: entry.url,
      });
      return { id, action: "pause", outcome: "paused", partialDeleted: false };
    }

    const listing = findById(listProcesses, id);
    if (listing) {
      const { key, entry } = listing;
      if (!entry.spawnedProcess) {
        return notAllowed(
          id,
          "pause",
          "That job has not started yet, so there is nothing to pause.",
        );
      }
      // Released before the kill: the run being abandoned is still in flight,
      // and a resume arriving before it settles would join it instead of
      // listing the playlist again.
      listingRuntime.inFlight.forget(entry.flightKey);
      entry.paused = true;
      const paused = pausedListing(entry);
      pausedJobs.set(paused.id, paused);
      listProcesses.delete(key);
      terminate(entry.id, entry.spawnedProcess);
      logger.info("Paused a listing; its partial index is kept", {
        id,
        url: entry.url,
      });
      return { id, action: "pause", outcome: "paused", partialDeleted: false };
    }

    if (pausedJobs.has(id)) {
      return notAllowed(id, "pause", "That job is already paused.");
    }
    return notFound(id, "pause");
  }

  /**
   * Puts a paused job back in the queue under the id it was paused as.
   *
   * A queued or running job answers `not-allowed` rather than `not-found`:
   * it is right there, the caller is simply acting on a poll that has since
   * gone stale.
   */
  function resumeJob(id: string): JobActionResult {
    const job = pausedJobs.get(id);
    if (!job) {
      const live = findById(downloadProcesses, id) ??
        findById(listProcesses, id);
      return live
        ? notAllowed(id, "resume", "That job is not paused.")
        : notFound(id, "resume");
    }

    pausedJobs.delete(id);
    if (job.kind === "download") {
      resumeDownload(job);
    } else {
      resumeListing(job);
    }
    logger.info("Resumed a paused job", { id, kind: job.kind, url: job.url });

    // Null rather than false: nothing was deleted, because nothing was asked
    // to be.
    return { id, action: "resume", outcome: "resumed", partialDeleted: null };
  }

  /**
   * Stops a job for good and throws away what it had fetched.
   *
   * Queued work is free to drop — it has no process and no bytes — while a
   * running or paused download has to be cleaned off the disk, which is the
   * whole difference between cancelling a queue and cancelling a transfer.
   */
  async function cancelJob(id: string): Promise<JobActionResult> {
    const download = findById(downloadProcesses, id);
    if (download) {
      const { key, entry } = download;

      if (!entry.spawnedProcess) {
        // The flag is what the download reads when its slot finally comes
        // round; without it a dropped request would still go on to start.
        entry.cancelled = true;
        downloadProcesses.delete(key);
        logger.info("Dropped a queued download; nothing to delete", {
          id,
          url: entry.url,
        });
        return {
          id,
          action: "cancel",
          outcome: "cancelled",
          partialDeleted: false,
        };
      }

      const job = pausedDownload(entry);
      downloadProcesses.delete(key);
      terminate(entry.id, entry.spawnedProcess);
      await awaitExit(entry.id, entry.spawnedProcess);
      return await cancelledDownload(id, job);
    }

    const listing = findById(listProcesses, id);
    if (listing) {
      const { key, entry } = listing;
      if (entry.spawnedProcess) {
        terminate(entry.id, entry.spawnedProcess);
      }
      listingRuntime.inFlight.forget(entry.flightKey);
      listProcesses.delete(key);
      logger.info("Cancelled a listing; its partial index is kept", {
        id,
        url: entry.url,
      });
      // A listing writes rows, not files: there is nothing on disk to delete.
      return {
        id,
        action: "cancel",
        outcome: "cancelled",
        partialDeleted: false,
      };
    }

    const paused = pausedJobs.get(id);
    if (paused) {
      pausedJobs.delete(id);
      return await cancelledDownload(id, paused);
    }

    return notFound(id, "cancel");
  }

  async function cancelledDownload(
    id: string,
    job: PausedJob,
  ): Promise<JobActionResult> {
    const partialDeleted = await deletePartials(id, job.savePath, job.fileName);
    return {
      id,
      action: "cancel",
      outcome: "cancelled",
      partialDeleted,
      // Honest about the one case where the bytes are still there, rather
      // than claiming a clean slate the disk does not agree with.
      ...(partialDeleted ? {} : {
        detail:
          "The partial file for that job could not be located, so nothing was deleted.",
      }),
    };
  }

  return {
    getQueueSnapshot: () =>
      snapshot(downloadProcesses.values(), "download", pausedJobs),
    getListingSnapshot: () =>
      snapshot(listProcesses.values(), "listing", pausedJobs),
    pauseJob,
    resumeJob,
    cancelJob,
  };
}

export interface JobActionHandlers {
  pauseJob: (id: string) => JobActionResult;
  resumeJob: (id: string) => JobActionResult;
  cancelJob: (id: string) => Promise<JobActionResult>;
}

/**
 * `POST /jobaction` — pause, resume or cancel one job by id.
 *
 * The outcome is in the body rather than in the status code because "that does
 * not apply to the state it is in" is a normal answer: the UI offers pause
 * only on a running job, so reaching `not-allowed` means the poll it acted on
 * was stale. A client that shows the sentence then needs no error branch, and
 * one that does not can ignore it.
 */
export async function processJobActionRequest(
  handlers: JobActionHandlers,
  requestBody: JobActionRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  try {
    const result = requestBody.action === "pause"
      ? handlers.pauseJob(requestBody.id)
      : requestBody.action === "resume"
      ? handlers.resumeJob(requestBody.id)
      : await handlers.cancelJob(requestBody.id);

    json(response, 200, { status: "success" as const, ...result });
  } catch (error) {
    logger.error("Job action failed", {
      id: requestBody.id,
      action: requestBody.action,
      error: (error as Error).message,
    });
    json(response, 500, { error: "Could not run that job action." });
  }
}
