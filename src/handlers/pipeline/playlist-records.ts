import { config } from "../../config.ts";
import { PlaylistMetadata } from "../../db/models.ts";
import { logger } from "../../logger.ts";
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
 * Probes yt-dlp for a playlist's title, then creates the row.
 *
 * With --ignore-errors, yt-dlp skips broken items and emits JSON only for
 * accessible ones, so the first line that arrives is the first usable one and
 * its playlist_title is all this probe wants.
 *
 * Both drains and the exit status are awaited together. This used to be
 * three detached IIFEs inside a `new Promise`, where the one waiting on
 * the exit status read a variable another one wrote — correct only for as
 * long as yt-dlp happened to flush stdout before exiting, and silently
 * yielding a URL-derived title when it did not.
 */
export async function addPlaylist(
  deps: PlaylistRecordDependencies,
  playlistUrl: string,
  monitoringType: string,
): Promise<PlaylistMetadata> {
  const { launchYtDlp, streamLines, streamTextChunks } = deps;
  const { process: titleProcess } = launchYtDlp({
    url: playlistUrl,
    flags: [
      "--playlist-items",
      "1:5",
      "--ignore-errors",
      "--dump-json",
      "--no-download",
    ],
    reason: "Trying to get playlist title",
  });

  const readFirstLine = async (): Promise<string | null> => {
    for await (const line of streamLines(titleProcess.stdout)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  };

  const drainStderr = async () => {
    for await (const data of streamTextChunks(titleProcess.stderr)) {
      logger.error(`Error getting playlist title: ${data}`);
    }
  };

  const [firstValidLine, , status] = await Promise.all([
    readFirstLine(),
    drainStderr().catch(() => {
      // Best-effort: a stderr read that fails must not lose the title.
    }),
    titleProcess.status,
  ]);
  const { code } = status;

  let playlistTitle = "";
  if (firstValidLine) {
    // Exit code 1 is expected under --ignore-errors when some items failed
    // and others succeeded, so the exit code is not consulted here: one
    // usable line is the whole success condition.
    try {
      const jsonData = JSON.parse(firstValidLine);
      if (jsonData) {
        playlistTitle = jsonData.playlist_title || jsonData.title || "";
      }
    } catch (e) {
      logger.error("Failed to parse playlist title JSON", {
        firstValidLine,
        error: e as Error,
      });
    }
  } else {
    // Every probed item failed, or nothing in the first 5 entries is
    // accessible. Fall back to a title derived from the URL.
    logger.warn(
      "No valid items found in first 5 entries, using URL-derived title",
      { url: playlistUrl, exitCode: code },
    );
  }

  if (!playlistTitle || playlistTitle.toString().trim() === "NA") {
    playlistTitle = urlToTitle(playlistUrl);
  }

  playlistTitle = truncateText(playlistTitle, config.maxTitleLength);

  logger.debug(`Creating playlist with title: ${playlistTitle}`, {
    url: playlistUrl,
    pid: titleProcess.pid,
    code,
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
