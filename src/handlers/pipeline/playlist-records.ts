import { config } from "../../config.ts";
import { PlaylistMetadata } from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { ProcessStatus, ProcessStatusOptions } from "./process-manager.ts";
import { truncateText, urlToTitle } from "./process-manager.ts";
import type { StreamLines, StreamTextChunks } from "./types.ts";
import type { YtDlpLauncher } from "./ytdlp.ts";

/**
 * Everything the playlist-title probe needs from the listing runtime.
 *
 * Declared here rather than imported wholesale so this module's surface is
 * exactly what it uses — and so a test can stub a launcher without building
 * the rest of the pipeline.
 */
export interface PlaylistRecordDependencies {
  launchYtDlp: YtDlpLauncher;
  streamLines: StreamLines;
  streamTextChunks: StreamTextChunks;
  /**
   * Registers the probe against the caller's process entry, so the stale
   * process cleaner can see and kill it. Optional: a test stubbing a launcher
   * has no process map to register against.
   */
  setProcessStatus?: (
    processKey: string,
    status: ProcessStatus,
    options?: ProcessStatusOptions,
  ) => boolean;
}

/**
 * Serializes playlist creation within this process.
 *
 * The next sort order is read from the database (`MAX(sortOrder) + 1`) rather
 * than kept in an in-memory counter, which is what lets two creations run
 * concurrently without handing both the same number: each waits for the
 * previous create to finish before reading the tail.
 *
 * This promise chain replaces three pieces of closure state the old factory
 * carried — the counter, its one-shot initialization promise, and the create
 * lock — plus the reset hook that had to be called after every deletion
 * reshuffled the sort orders. Reading at write time has nothing to invalidate.
 */
let playlistCreateChain: Promise<unknown> = Promise.resolve();

/**
 * Flags for the cheap probe: one flat entry, one JSON object.
 *
 * `--flat-playlist` stops yt-dlp resolving the individual videos, which is the
 * only reason this probe ever produced hundreds of kilobytes of format tables,
 * storyboards and HTTP headers to read one string out of. The playlist's own
 * title is on the object `--dump-single-json` prints.
 */
const FLAT_TITLE_PROBE_FLAGS = [
  "--flat-playlist",
  "--playlist-items",
  "1",
  "--dump-single-json",
  "--no-download",
];

/**
 * Flags for the fallback probe: up to five real items, first usable one wins.
 *
 * Extractors that expose no playlist-level title still put `playlist_title` on
 * each entry, so this is what answers when the flat probe comes back blank.
 * With `--ignore-errors` yt-dlp skips broken items, so the first line to
 * arrive is the first accessible one.
 */
const ITEM_TITLE_PROBE_FLAGS = [
  "--playlist-items",
  "1:5",
  "--ignore-errors",
  "--dump-json",
  "--no-download",
];

/** How long a killed probe gets to exit before SIGKILL. */
const PROBE_KILL_GRACE_MS = 5_000;

/** What one title probe produced. */
interface TitleProbeOutcome {
  /** First non-empty stdout line, or null when the probe produced none. */
  line: string | null;
  exitCode: number | null;
  pid: number;
  /** True when the deadline, not yt-dlp, ended the probe. */
  timedOut: boolean;
}

/**
 * Runs one yt-dlp title probe and stops it, whatever happens.
 *
 * The probe wants exactly one line, and everything here exists so that wanting
 * one line cannot wedge the pipeline. On 2026-09-04 it did: the reader
 * returned after the first item's JSON, left the rest of stdout unread, and
 * the fifth item's 600 KB filled the kernel pipe buffer. yt-dlp blocked in
 * `write()` forever, `process.status` never resolved, and the listing
 * semaphore — one slot, held by this call — stayed held for an hour.
 *
 * Three things now make that impossible, in order of how quickly they act:
 * leaving the read loop cancels stdout (see `streamTextChunks`), which closes
 * the pipe the child is blocked on; the probe is then killed outright, since
 * one line is the whole job; and a deadline kills anything still alive after
 * `config.queue.titleProbeTimeout`, escalating to SIGKILL. The process is also
 * registered against the caller's process entry, so the stale-process cleaner
 * can see it rather than finding an untracked `pending` row it will not touch.
 */
async function probePlaylistTitle(
  deps: PlaylistRecordDependencies,
  playlistUrl: string,
  flags: string[],
  reason: string,
  processKey?: string,
): Promise<TitleProbeOutcome> {
  const { launchYtDlp, streamLines, streamTextChunks, setProcessStatus } = deps;
  const { process: titleProcess } = launchYtDlp({
    url: playlistUrl,
    flags,
    reason,
  });

  if (processKey) {
    setProcessStatus?.(processKey, "running", {
      spawnedProcess: titleProcess,
    });
  }

  let stopped = false;
  const stopProbe = () => {
    if (stopped) return;
    stopped = true;
    titleProcess.kill("SIGTERM");
  };

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    logger.warn("Playlist title probe timed out, terminating it", {
      url: playlistUrl,
      pid: titleProcess.pid,
      timeoutMs: config.queue.titleProbeTimeout,
    });
    stopProbe();
    killTimer = setTimeout(
      () => titleProcess.kill("SIGKILL"),
      PROBE_KILL_GRACE_MS,
    );
  }, config.queue.titleProbeTimeout);

  const readFirstLine = async (): Promise<string | null> => {
    try {
      for await (const line of streamLines(titleProcess.stdout)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) return trimmed;
      }
      return null;
    } finally {
      // Whether a line arrived or the stream ended, nothing further is read
      // from this process — so it does not get to keep writing.
      stopProbe();
    }
  };

  const drainStderr = async () => {
    for await (const data of streamTextChunks(titleProcess.stderr)) {
      logger.error(`Error getting playlist title: ${data}`);
    }
  };

  try {
    const [line, , status] = await Promise.all([
      readFirstLine(),
      drainStderr().catch(() => {
        // Best-effort: a stderr read that fails must not lose the title.
      }),
      titleProcess.status,
    ]);
    return { line, exitCode: status.code, pid: titleProcess.pid, timedOut };
  } finally {
    clearTimeout(deadline);
    if (killTimer !== undefined) clearTimeout(killTimer);
    stopProbe();
  }
}

/**
 * Reads a title out of one probe line, tolerating anything but valid JSON.
 *
 * `playlist_title` first, and that order matters per probe: the per-item probe
 * dumps videos, whose `title` is the video's and whose `playlist_title` is the
 * one wanted. The flat probe dumps the playlist itself, which carries only
 * `title` — so the same expression reads both.
 */
function titleFromProbeLine(line: string): string {
  try {
    const jsonData = JSON.parse(line);
    if (!jsonData) return "";
    return jsonData.playlist_title || jsonData.title || "";
  } catch (e) {
    logger.error("Failed to parse playlist title JSON", {
      firstValidLine: line,
      error: e as Error,
    });
    return "";
  }
}

/**
 * Probes yt-dlp for a playlist's title, then creates the row.
 *
 * Two probes, cheapest first. `--flat-playlist` answers for anything with a
 * playlist page of its own and costs one small JSON object; the per-item probe
 * runs only when that comes back with no usable title, and is skipped when the
 * flat probe timed out — a site slow enough to miss the deadline is not one to
 * ask a heavier question of. A URL-derived title is the floor.
 *
 * The exit code is not consulted for either probe: 1 is what `--ignore-errors`
 * returns when some items failed and others did not, so one usable line is the
 * whole success condition.
 */
export async function addPlaylist(
  deps: PlaylistRecordDependencies,
  playlistUrl: string,
  monitoringType: string,
  processKey?: string,
): Promise<PlaylistMetadata> {
  let probe = await probePlaylistTitle(
    deps,
    playlistUrl,
    FLAT_TITLE_PROBE_FLAGS,
    "Trying to get playlist title",
    processKey,
  );
  let playlistTitle = probe.line ? titleFromProbeLine(probe.line) : "";

  if (!playlistTitle && !probe.timedOut) {
    logger.debug(
      "Flat playlist probe yielded no title, retrying against the items",
      { url: playlistUrl, exitCode: probe.exitCode },
    );
    probe = await probePlaylistTitle(
      deps,
      playlistUrl,
      ITEM_TITLE_PROBE_FLAGS,
      "Retrying playlist title against the first items",
      processKey,
    );
    playlistTitle = probe.line ? titleFromProbeLine(probe.line) : "";
  }

  if (!playlistTitle) {
    logger.warn("No playlist title could be probed, using URL-derived title", {
      url: playlistUrl,
      exitCode: probe.exitCode,
      timedOut: probe.timedOut,
    });
  }

  if (!playlistTitle || playlistTitle.toString().trim() === "NA") {
    playlistTitle = urlToTitle(playlistUrl);
  }

  playlistTitle = truncateText(playlistTitle, config.maxTitleLength);

  logger.debug(`Creating playlist with title: ${playlistTitle}`, {
    url: playlistUrl,
    pid: probe.pid,
    code: probe.exitCode,
    monitoringType,
    lastUpdatedByScheduler: Date.now(),
  });

  try {
    return await createPlaylistRecord(
      playlistUrl,
      playlistTitle.trim(),
      monitoringType,
    );
  } catch (error) {
    logger.error("Failed to create playlist", {
      url: playlistUrl,
      error: (error as Error).message,
    });
    throw error;
  }
}

/**
 * Creates the playlist row if it does not exist, with the next sort order.
 *
 * The sort order used to be handed out from an in-memory counter seeded once
 * from the database, which then had to be told when the database changed:
 * deleting a playlist decremented every later row's sort order, so a reset
 * hook had to run or the counter would hand out numbers that collided with
 * existing rows. Reading `MAX(sortOrder) + 1` inside the serialized create
 * gives the same sequence with no invalidation step, because the value comes
 * from the same table the deletion just reshuffled.
 */
export async function createPlaylistRecord(
  playlistUrl: string,
  playlistTitle: string,
  monitoringType: string,
): Promise<PlaylistMetadata> {
  const previousCreate = playlistCreateChain;
  let releaseCreateLock!: () => void;
  playlistCreateChain = new Promise<void>((resolve) => {
    releaseCreateLock = resolve;
  });

  await previousCreate;

  try {
    const lastPlaylist = await PlaylistMetadata.findOne({
      order: [["sortOrder", "DESC"]],
      attributes: ["sortOrder"],
      limit: 1,
    });
    const nextPlaylistIndex = lastPlaylist !== null
      ? lastPlaylist.sortOrder + 1
      : 0;

    const [playlist, created] = await PlaylistMetadata.findOrCreate({
      where: { playlistUrl: playlistUrl },
      defaults: {
        playlistUrl: playlistUrl,
        title: playlistTitle,
        monitoringType: monitoringType,
        saveDirectory: truncateText(playlistTitle, 30),
        sortOrder: nextPlaylistIndex,
        lastUpdatedByScheduler: new Date(),
      },
    });

    if (!created) {
      logger.warn("Playlist already exists", { url: playlistUrl });
    }

    return playlist;
  } finally {
    releaseCreateLock();
  }
}
