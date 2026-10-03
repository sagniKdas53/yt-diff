import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { readdir, rm } from "../../utils/fs.ts";
import { json } from "../../utils/http.ts";
import { basename, dirname, join } from "../../utils/path.ts";
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
 * jobs the user can see and act on. `resuming` is the same idea for a job that
 * has been accepted and has not started — it is in neither map yet either.
 */
function snapshot(
  entries: Iterable<JobIdentity>,
  kind: JobKind,
  pausedJobs: Map<string, PausedJob>,
  resuming: Iterable<PausedJob> = [],
): JobView[] {
  const views = Array.from(entries, (entry) => jobView(entry, kind));
  for (const job of pausedJobs.values()) {
    if (job.kind === kind) {
      views.push(jobView(job, kind));
    }
  }
  for (const job of resuming) {
    // Its state is stated rather than derived. `stateOf` reads a listing's
    // "pending" as already working, which is right for a registered entry and
    // exactly wrong for one that has not registered: this job is waiting for
    // the run it replaced, so it is queued, and queued is what puts a Cancel
    // button — and only a Cancel button — on it.
    views.push({ ...jobView(job, kind), state: "queued" });
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
  job: PausedJob,
): Promise<boolean> {
  // The destination is the whole path yt-dlp named before it started, so the
  // folder is its own directory rather than one assembled from a save path and
  // a file name that arrived too late to be useful.
  const destination = job.destination ?? null;
  const folder = destination ? dirname(destination) : job.savePath ?? undefined;
  const fileName = destination ? basename(destination) : job.fileName;

  if (!folder || !fileName) {
    logger.warn("Could not locate a job's partial files", {
      jobId,
      savePath: job.savePath,
      destination,
    });
    return false;
  }

  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    logger.error("Could not read a job's folder to clear its partials", {
      jobId,
      savePath: folder,
      error: (error as Error).message,
    });
    return false;
  }

  const removed: string[] = [];
  for (const name of names.filter((name) => isPartialOf(name, fileName))) {
    const path = join(folder, name);
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
  /**
   * Re-runs a paused listing under its own id.
   *
   * Awaitable on purpose. A listing registers itself only once it holds a
   * semaphore slot, so between the resume being accepted and the run being
   * findable in `listProcesses` the job is held only by the caller — which is
   * the window a cancel has to keep working through.
   */
  resumeListing: (job: PausedJob) => Promise<unknown>;
  /**
   * Marks a listing as cancelled while its run is still queued for a slot.
   *
   * Separate from the tombstone because the run outlives it: once the run is
   * parked on the semaphore there is no entry to find and no process to
   * signal, and only the run itself can still say no.
   */
  abandonListing: (id: string) => void;
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
    abandonListing,
    downloadProcesses,
    listProcesses,
    listingRuntime,
    pausedJobs,
    resumeDownload,
    resumeListing,
  } = deps;

  /**
   * Listing runs a pause stopped but did not wait for, by flight key.
   *
   * SIGTERM stops yt-dlp; it does not stop the run wrapped around it, which
   * still has the chunk in flight to finish writing. The single-flight key that
   * run held is released at pause time so a resume cannot join it, which means
   * nothing else is holding the promise — so a resume arriving before it
   * settles would start a second run of the same playlist, and with
   * `maxListings` above 1 the free slot is available to it. Two runs reading
   * the same unmapped video can both decide it needs a mapping, and the second
   * insert is the duplicate this map exists to prevent.
   *
   * Entries are dropped as soon as the run settles, so an absent key means the
   * run is already over and a resume can start at once.
   */
  const retiringListings = new Map<string, Promise<void>>();

  /**
   * Listing resumes waiting for a retiring run, by job id.
   *
   * Held so a job that has been accepted but not started is still a job: it
   * reports in the listing snapshot as queued, and a cancel finds it. Entries
   * leave when the wait ends, one way or the other.
   */
  const deferredResumes = new Map<string, PausedJob>();

  /**
   * True when something else already holds this listing's single-flight key.
   *
   * A pause releases the key so a resume cannot join the run it is killing.
   * That leaves the key free for anyone else, and a plain `/list` for the same
   * URL, monitoring type and scheduled-update state takes it straight back. The
   * resume then joins *that* run instead of starting one of its own, so the id
   * the user is tracking is never registered and the listing they paused never
   * resumes — told "resumed", then gone from the drawer.
   *
   * Only the in-flight map, never `retiringListings`: that map holding the key
   * is this job's own paused run on its way out, which is exactly the case a
   * resume is meant to wait for.
   */
  function flightKeyTaken(job: PausedJob): boolean {
    return job.kind === "listing" && job.flightKey !== undefined &&
      listingRuntime.inFlight.has(job.flightKey);
  }

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
      destination: entry.destination ?? null,
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
      flightKey: entry.flightKey,
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
   * Waits for a signalled process to actually be gone, and says whether it is.
   *
   * The exit code is not what is being waited for; the file handles are. A
   * cancel deletes the partial file the process was writing to, and deleting it
   * while yt-dlp still has it open lets a last buffered write put it straight
   * back — the one outcome a cancel is not allowed to produce. SIGTERM is what
   * yt-dlp exits on, so this normally returns at once; the escalation is for the
   * case where it does not, and it is bounded so a cancel can never hang.
   *
   * False means the handles may still be open, which is why the caller must not
   * touch the partial file. Sending SIGKILL makes a process unlikely to still be
   * writing, not certain, and the difference between the two is the difference
   * between "cancelled" and "cancelled, and the bytes may reappear".
   */
  async function awaitExit(
    id: string,
    process: NonNullable<ProcessLike["spawnedProcess"]>,
  ): Promise<boolean> {
    // A listing's process is only ever a `kill` handle, so there is nothing
    // to wait on for one — and nothing it could be writing a partial with.
    const status = (process as { status?: Promise<Deno.CommandStatus> }).status;
    if (!status) return true;

    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        // A rejected status is a process this could not account for, which is
        // the same thing as one that has not been shown to have exited.
        status.then(() => true, () => false),
        // Settles either way once the grace period is up, so a process that
        // takes no notice of SIGKILL cannot hold a cancel open forever. What
        // is being waited for is the handles closing, and after SIGKILL there
        // is nothing further this can usefully do about them.
        new Promise<boolean>((resolve) => {
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
            resolve(false);
          }, TERMINATION_GRACE_MS);
        }),
      ]);
    } catch (error) {
      logger.warn("Could not read a job's exit status", {
        id,
        error: (error as Error).message,
      });
      return false;
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
      // listing the playlist again. Read before releasing it — after the
      // `forget` there is no handle left on the run at all.
      const retiring = listingRuntime.inFlight.current(entry.flightKey);
      listingRuntime.inFlight.forget(entry.flightKey);
      if (retiring !== undefined) {
        // Normalised so the resume waiting on it is never skipped by a throw
        // out of the run being replaced, and dropped on settle so the key is
        // absent — and a resume free to start — the moment it is really over.
        const settled: Promise<void> = retiring.then(
          () => undefined,
          () => undefined,
        );
        retiringListings.set(entry.flightKey, settled);
        void settled.then(() => {
          if (retiringListings.get(entry.flightKey) === settled) {
            retiringListings.delete(entry.flightKey);
          }
        });
      }
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
    if (deferredResumes.has(id)) {
      // It is there — the snapshot is calling it queued — so this is an
      // invalid transition rather than a job that does not exist. Same answer
      // a queued entry gets, and for the same reason: nothing is running to
      // stop yet.
      return notAllowed(
        id,
        "pause",
        "That job has not started yet, so there is nothing to pause.",
      );
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
      if (live) {
        return notAllowed(id, "resume", "That job is not paused.");
      }
      // A resume already waiting to start is in neither map, so the check above
      // cannot see it. It is queued, though, and the queue is not paused.
      return deferredResumes.has(id)
        ? notAllowed(id, "resume", "That job is already on its way back.")
        : notFound(id, "resume");
    }

    // Checked before the paused job is dropped, because dropping it is the one
    // thing here that cannot be undone. `resumeDownload` goes through the same
    // duplicate filter a fresh submission does, and that filter silently
    // discards an item whose URL is already queued or running — so a resume
    // that raced a second request for the same video would answer "resumed"
    // with no download behind it and no paused job to fall back on. The user
    // would watch a job vanish from the drawer and never come back.
    if (
      job.kind === "download" &&
      Array.from(downloadProcesses.values()).some((process) =>
        process.url === job.url &&
        ["running", "pending"].includes(process.status)
      )
    ) {
      return notAllowed(
        id,
        "resume",
        "Another download for that video is already queued or running, so this one is still paused.",
      );
    }

    // The listing counterpart, and for the same reason: checked while the paused
    // record is still there to keep. The deferral below checks again before it
    // starts, because a `/list` can take the key during the wait as well.
    if (flightKeyTaken(job)) {
      return notAllowed(
        id,
        "resume",
        "Another listing for this request is already queued or running, so this one is still paused.",
      );
    }

    pausedJobs.delete(id);

    if (job.kind === "download") {
      // No window: a download registers itself before it takes a slot, so it is
      // findable from the moment it is accepted.
      resumeDownload(job);
      logger.info("Resumed a paused job", { id, kind: job.kind, url: job.url });
      return { id, action: "resume", outcome: "resumed", partialDeleted: null };
    }

    // Held until the run settles, not until it is asked to start. A listing
    // registers itself only once it holds a semaphore slot, so from here until
    // then it is in neither map: the drawer's row would vanish on the click, and
    // a cancel sent into that gap would answer `not-found` while the listing
    // went ahead and started anyway. Reporting it as queued is what puts a
    // Cancel — and only a Cancel — on it.
    deferredResumes.set(id, job);

    const retiring = job.flightKey === undefined
      ? undefined
      : retiringListings.get(job.flightKey);
    logger.info(
      retiring === undefined
        ? "A resumed listing is waiting for a slot"
        : "A resumed listing waits for the run it replaced to finish",
      { id, url: job.url },
    );

    /**
     * Starts the run, unless something in the meantime has taken it away.
     *
     * Both reasons leave `deferredResumes` without an entry, which is how the
     * handler below knows not to claim a resume that did not happen.
     */
    const startWhenSafe = (): Promise<unknown> | undefined => {
      // A cancel that took the entry while this waited stops it here, before it
      // ever reaches the semaphore.
      if (!deferredResumes.has(id)) {
        return undefined;
      }
      // A `/list` for the same request took the key during the wait. Joining it
      // would resume nothing under this id, so the job goes back to paused —
      // the answer the guard above gives when it is caught earlier, and the
      // only one that does not leave a job the user cannot see or cancel.
      if (flightKeyTaken(job)) {
        deferredResumes.delete(id);
        pausedJobs.set(id, job);
        logger.info(
          "A listing resume was withdrawn: that request is already being listed",
          { id, url: job.url },
        );
        return undefined;
      }
      return resumeListing(job);
    };

    void Promise.resolve(
      retiring === undefined ? startWhenSafe() : retiring.then(startWhenSafe),
    ).then(
      () => {
        // Deleting on the run's own settlement: it registers the job before it
        // resolves, so by then the entry is redundant, and if it gave up first
        // there is no job left for the entry to stand for. A cancel that took
        // it in between finds nothing to delete, which is how a cancelled
        // resume knows not to claim it started.
        if (!deferredResumes.delete(id)) {
          return;
        }
        logger.info("Resumed a paused job", {
          id,
          kind: job.kind,
          url: job.url,
        });
      },
      (error: unknown) => {
        deferredResumes.delete(id);
        logger.error("A resumed listing failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );

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
      if (!await awaitExit(entry.id, entry.spawnedProcess)) {
        // Not deleted on purpose. The process was sent SIGKILL and has not been
        // seen to leave, so it may still hold the partial open — and deleting
        // under an open handle is how a cancelled download grows its .part
        // back. The job is stopped either way; what is unconfirmed is whether
        // the bytes are gone, which is what this says.
        return {
          id,
          action: "cancel",
          outcome: "cancelled",
          partialDeleted: false,
          detail:
            "That job was stopped, but it did not confirm it had exited, so its partial file was left where it was.",
        };
      }
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
      if (paused.kind === "listing") {
        // Same reason as a running listing above, and without this the paused
        // job falls through to the download path, which reports a partial file
        // it never had — telling the user a listing could not be located on a
        // disk it never wrote to.
        logger.info("Cancelled a paused listing; nothing to delete", {
          id,
          url: paused.url,
        });
        return {
          id,
          action: "cancel",
          outcome: "cancelled",
          partialDeleted: false,
        };
      }
      return await cancelledDownload(id, paused);
    }

    const deferred = deferredResumes.get(id);
    if (deferred !== undefined) {
      // Two stages, two stops. If the run is still waiting on the run it
      // replaced, it has not been asked to start and the delete alone is enough.
      // If it has, it is parked on the semaphore with nothing to find it by, so
      // the abandon mark is what it reads and declines on — without which the
      // cancel would be accepted and the listing would begin anyway the moment a
      // slot freed. Either way there is no process to signal and no bytes to
      // delete: a listing writes rows, and this one had not started any.
      deferredResumes.delete(id);
      abandonListing(id);
      logger.info("Cancelled a listing that had not started again yet", {
        id,
        url: deferred.url,
      });
      return {
        id,
        action: "cancel",
        outcome: "cancelled",
        partialDeleted: false,
      };
    }

    return notFound(id, "cancel");
  }

  async function cancelledDownload(
    id: string,
    job: PausedJob,
  ): Promise<JobActionResult> {
    const partialDeleted = await deletePartials(id, job);
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
      snapshot(
        listProcesses.values(),
        "listing",
        pausedJobs,
        deferredResumes.values(),
      ),
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
