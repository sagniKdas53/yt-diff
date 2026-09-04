import { PlaylistMetadata, PlaylistVideoMapping } from "../../db/models.ts";
import { logger } from "../../logger.ts";
import {
  extractPlaylistId,
  isChannelUrl,
  isYouTubeApiConfigured,
  isYouTubeUrl,
  resolveChannelUploadsPlaylistId,
} from "../youtube-api.ts";
import { Semaphore } from "./semaphore.ts";
import { config } from "../../config.ts";
import { ListingProcessError, playlistRegex } from "./types.ts";
import type {
  ListingItem,
  ListingProcessEntry,
  ListingResult,
  ManagedProcess,
  PipelineHandlerDependencies,
} from "./types.ts";
import { ProcessExitCodes } from "./types.ts";
import { isSiteXDotCom, normalizeUrl } from "../../utils/url.ts";
import type { ProcessStatus, ProcessStatusOptions } from "./process-manager.ts";
import { chunkPlaylistLines, type PlaylistChunk } from "./chunks.ts";
import { createYtDlpLauncher, type YtDlpLauncher } from "./ytdlp.ts";
import { fetchPlaylistItemsChunked } from "../youtube-api.ts";
import { processStreamingVideoInformation } from "./ingest-chunk.ts";
import { addPlaylist } from "./playlist-records.ts";

/**
 * Everything the listing flow needs that outlives a single call.
 *
 * This used to be closure state inside one 1,600-line factory: a semaphore,
 * a yt-dlp launcher, and the process manager's two mutators, captured by
 * twenty nested functions. It is now an explicit parameter, so every function
 * below is a plain export a test can call without building the rest of the
 * pipeline. The sort-order counter and its invalidation hook — the last
 * genuinely mutable closure state — are gone entirely; see
 * `playlist-records.ts` for where that value comes from now.
 */
export interface ListingRuntime {
  safeEmit: PipelineHandlerDependencies["safeEmit"];
  launchYtDlp: YtDlpLauncher;
  streamLines: PipelineHandlerDependencies["streamLines"];
  streamTextChunks: PipelineHandlerDependencies["streamTextChunks"];
  listProcesses: Map<string, ListingProcessEntry>;
  semaphore: Semaphore;
  updateProcessActivity: (processKey: string, isStdout?: boolean) => void;
  setProcessStatus: (
    processKey: string,
    status: ProcessStatus,
    options?: ProcessStatusOptions,
  ) => boolean;
}

/**
 * Assembles the runtime from the pipeline's shared dependencies.
 *
 * Pure wiring — nothing here closes over mutable state, and nothing the
 * functions below do depends on this being the only runtime in the process.
 */
export function createListingRuntime(
  deps: PipelineHandlerDependencies,
  listProcesses: Map<string, ListingProcessEntry>,
  processManager: {
    updateProcessActivity: (processKey: string, isStdout?: boolean) => void;
    setProcessStatus: (
      processKey: string,
      status: ProcessStatus,
      options?: ProcessStatusOptions,
    ) => boolean;
  },
): ListingRuntime {
  const {
    safeEmit,
    buildSiteArgs,
    spawnPythonProcess,
    streamTextChunks,
    streamLines,
  } = deps;

  return {
    safeEmit,
    launchYtDlp: createYtDlpLauncher({ buildSiteArgs, spawnPythonProcess }),
    streamLines,
    streamTextChunks,
    listProcesses,
    semaphore: new Semaphore(config.queue.maxListings, "ListingSemaphore"),
    updateProcessActivity: processManager.updateProcessActivity,
    setProcessStatus: processManager.setProcessStatus,
  };
}

/** True listing backlog: items holding a slot plus those parked in the queue. */
export function getListingQueueDepth(rt: ListingRuntime): number {
  return rt.listProcesses.size + rt.semaphore.pendingCount;
}

/**
 * Drives every item through the semaphore concurrently and logs the outcomes.
 */
export async function listItemsConcurrently(
  rt: ListingRuntime,
  items: ListingItem[],
  chunkSize: number,
  isScheduledUpdate: boolean,
): Promise<ListingResult[]> {
  logger.trace(
    `Listing ${items.length} items concurrently (chunk size: ${chunkSize})`,
  );

  if (items.length === 0) {
    logger.trace("No items to list");
    return [];
  }

  rt.semaphore.setMaxConcurrent(config.queue.maxListings);

  const listingResults = await Promise.all(
    items.map((item) =>
      listWithSemaphore(rt, item, chunkSize, isScheduledUpdate)
    ),
  );

  try {
    listingResults.forEach((result) => {
      if (result.status === "completed") {
        logger.info(
          `Listed ${result.title || result.playlistTitle} successfully`,
        );
      } else {
        logger.error(
          `Failed to list ${result.title}: ${JSON.stringify(result)}`,
        );
      }
    });
  } catch (error) {
    logger.error("Failed to log listing results", {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
  }

  return listingResults;
}

async function listWithSemaphore(
  rt: ListingRuntime,
  item: ListingItem,
  chunkSize: number,
  isScheduledUpdate: boolean,
): Promise<ListingResult> {
  logger.trace(`Starting listing with semaphore: ${JSON.stringify(item)}`);

  await rt.semaphore.acquire();

  try {
    const { url: videoUrl, type: itemType, currentMonitoringType } = item;
    const now = Date.now();
    const listEntry: ListingProcessEntry = {
      url: videoUrl,
      type: itemType,
      monitoringType: currentMonitoringType,
      spawnType: "list",
      lastActivity: now,
      lastStdoutActivity: now,
      spawnTimeStamp: now,
      status: "pending",
    };

    const entryKey = `pending_${videoUrl}_${Date.now()}`;
    rt.listProcesses.set(entryKey, listEntry);

    const result = await executeListing(
      rt,
      item,
      entryKey,
      chunkSize,
      item.isScheduledUpdate === true || isScheduledUpdate,
    );

    listEntry.spawnedProcess = null;

    logger.trace("Listing completed", {
      result: JSON.stringify(result),
      listEntry: JSON.stringify(listEntry),
    });

    if (rt.listProcesses.has(entryKey)) {
      rt.listProcesses.delete(entryKey);
    }

    return result;
  } finally {
    rt.semaphore.release();
  }
}

export async function executeListing(
  rt: ListingRuntime,
  item: ListingItem,
  processKey: string,
  chunkSize: number,
  isScheduledUpdate: boolean = false,
): Promise<ListingResult> {
  const resolvedIsScheduledUpdate = isScheduledUpdate ||
    item.isScheduledUpdate === true;
  // Per-playlist progress: on for interactive listings, and for scheduled
  // ones that explicitly opt in (batch re-index). Chunk-level emits stay
  // gated on isScheduledUpdate alone so a batch stays per-playlist only.
  const shouldEmitProgress = !resolvedIsScheduledUpdate ||
    item.emitProgress === true;
  logger.debug(`isScheduledUpdate: ${resolvedIsScheduledUpdate}`, {
    item: JSON.stringify(item),
    isScheduledUpdate,
  });
  const { url: videoUrl, currentMonitoringType } = item;
  let itemType = item.type;

  try {
    if (shouldEmitProgress) {
      rt.safeEmit("listing-started", {
        url: videoUrl,
        type: itemType,
        status: "started",
      });
    }

    const isPlaylist = playlistRegex.test(videoUrl) ||
      itemType === "playlist";
    itemType = isPlaylist && !isSiteXDotCom(videoUrl) ? "playlist" : "unlisted";

    let playlistTitle = "";
    let seekPlaylistListTo = 0;

    if (itemType === "playlist") {
      const existingPlaylist = await PlaylistMetadata.findOne({
        where: { playlistUrl: videoUrl },
      });
      if (existingPlaylist) {
        logger.debug("Playlist already exists in database", {
          url: videoUrl,
        });
        if (
          existingPlaylist.monitoringType ===
            currentMonitoringType && !resolvedIsScheduledUpdate
        ) {
          return handleEmptyResponse(rt, videoUrl);
        } else if (
          existingPlaylist.monitoringType !==
            currentMonitoringType
        ) {
          logger.debug("Playlist monitoring has changed", { url: videoUrl });
          await existingPlaylist.update({
            monitoringType: ["Refresh", "Full"].includes(currentMonitoringType)
              ? "N/A"
              : currentMonitoringType,
            lastUpdatedByScheduler: resolvedIsScheduledUpdate ||
                ["Refresh", "Full"].includes(currentMonitoringType)
              ? new Date()
              : existingPlaylist.lastUpdatedByScheduler,
          });
          logger.debug("Playlist monitoring type updated", { url: videoUrl });
        } else if (resolvedIsScheduledUpdate) {
          await existingPlaylist.update({
            monitoringType: currentMonitoringType === "Full"
              ? "N/A"
              : existingPlaylist.monitoringType,
            lastUpdatedByScheduler: new Date(),
          });
        }
        playlistTitle = existingPlaylist.title;
        seekPlaylistListTo = existingPlaylist.sortOrder;
      } else {
        logger.debug("Playlist not found in database, adding to database", {
          url: videoUrl,
        });
        const newPlaylist = await addPlaylist(
          rt,
          videoUrl,
          ["Refresh", "Full"].includes(currentMonitoringType)
            ? "N/A"
            : currentMonitoringType,
          // So the title probe is tracked against this listing's entry rather
          // than running untracked, which is how a wedged one stayed
          // invisible to the cleanup job.
          processKey,
        );
        playlistTitle = newPlaylist.title;
        seekPlaylistListTo = newPlaylist.sortOrder;
      }

      return await handlePlaylistStreaming(rt, {
        videoUrl,
        chunkSize,
        isScheduledUpdate: resolvedIsScheduledUpdate,
        shouldEmitProgress,
        playlistTitle,
        seekPlaylistListTo,
        processKey,
        monitoringType: currentMonitoringType,
      });
    }

    return await handleSingleVideoStreaming(rt, {
      videoUrl,
      itemType,
      isScheduledUpdate: resolvedIsScheduledUpdate,
      processKey,
    });
  } catch (error) {
    return handleListingError(rt, error as Error, videoUrl, itemType);
  }
}

/**
 * Where chunks come from, and what this source's failures mean.
 *
 * The two listing paths — yt-dlp's line stream and the YouTube Data API —
 * were line-for-line duplicates of one algorithm apart from these four
 * things. They are now the only things each path states.
 */
interface PlaylistChunkSource {
  chunks: AsyncIterable<PlaylistChunk>;
  /** Stops production when the consumer breaks out early. */
  stop?(): void;
  /** What an entirely empty run means here. May throw, and is caught. */
  onEmpty(): ListingResult;
  /**
   * What a failure means here. Returning `null` says the run finished rather
   * than failed, and the driver completes normally — which is how a listing
   * this code deliberately killed reports the items it did ingest. Throwing
   * propagates, which is how the API path asks its caller to fall back.
   */
  onError(error: Error): ListingResult | null;
  /** Per-chunk hook for source-specific progress logging. */
  onChunkDone?(processedChunks: number): void;
}

/** Common to both paths: a re-index starts from an empty mapping table. */
async function clearMappingsForReindex(
  videoUrl: string,
  monitoringType: string,
) {
  if (monitoringType !== "Full" && monitoringType !== "Refresh") return;

  const deletedCount = await PlaylistVideoMapping.destroy({
    where: { playlistUrl: videoUrl },
  });
  logger.info(
    `Cleared ${deletedCount} existing mapping(s) before ${monitoringType} re-index`,
    { url: videoUrl },
  );
}

/**
 * Drives one playlist listing to completion, whatever produced the chunks.
 *
 * Everything here was written twice: ingest the chunk, count it, refresh the
 * process's liveness clock, emit a progress frame, and stop early once two
 * consecutive chunks turn out to be entirely items already on record. The
 * two copies had drifted — one compared the duplicate count against the
 * configured chunk size and the other against the chunk actually received,
 * which differ on a final partial chunk.
 */
async function consumePlaylistChunks(
  rt: ListingRuntime,
  source: PlaylistChunkSource,
  item: {
    videoUrl: string;
    isScheduledUpdate: boolean;
    shouldEmitProgress: boolean;
    playlistTitle: string;
    seekPlaylistListTo: number;
    processKey: string;
    monitoringType: string;
  },
): Promise<ListingResult> {
  const {
    videoUrl,
    isScheduledUpdate,
    shouldEmitProgress,
    playlistTitle,
    seekPlaylistListTo,
    processKey,
    monitoringType,
  } = item;

  let processedChunks = 0;
  let consecutiveDuplicateChunks = 0;

  try {
    for await (const chunk of source.chunks) {
      const result = await processStreamingVideoInformation(
        chunk.items,
        videoUrl,
        chunk.startIndex,
        isScheduledUpdate,
        monitoringType,
      );

      processedChunks++;
      rt.updateProcessActivity(processKey, true);

      if (!isScheduledUpdate) {
        rt.safeEmit("listing-playlist-chunk-complete", {
          url: videoUrl,
          type: "playlist-chunk",
          status: "chunk-completed",
          processedChunks,
          playlistTitle,
          seekPlaylistListTo,
        });
      }

      source.onChunkDone?.(processedChunks);

      // "Start" walks a playlist from the top looking for what is new, so
      // two chunks running with nothing new in them means the walk has
      // reached ground already covered.
      if (
        monitoringType === "Start" &&
        result.alreadyExistedCount === chunk.items.length
      ) {
        consecutiveDuplicateChunks++;
        if (consecutiveDuplicateChunks >= 2) {
          logger.info(
            "Two consecutive chunks were entirely known items; stopping early",
            { url: videoUrl, processedChunks },
          );
          source.stop?.();
          break;
        }
      } else {
        consecutiveDuplicateChunks = 0;
      }
    }

    if (processedChunks === 0) {
      return source.onEmpty();
    }
  } catch (error) {
    const handled = source.onError(error as Error);
    if (handled) return handled;
  }

  // Reached whether the run ended naturally or was stopped early: in both
  // cases the process is done and the cleanup job should be able to reap it.
  // The early-stop path used to leave the entry at "running" until the idle
  // timeout noticed.
  rt.setProcessStatus(processKey, "completed");

  return completePlaylistListing(
    rt,
    videoUrl,
    processedChunks,
    playlistTitle,
    seekPlaylistListTo,
    shouldEmitProgress,
  );
}

/**
 * Where a "Start" listing resumes from.
 *
 * "End" walks the tail, so it rewinds one chunk from the last position on
 * record rather than starting at the top. Every other mode starts at 1.
 */
async function resolveStartIndex(
  videoUrl: string,
  chunkSize: number,
  monitoringType: string,
): Promise<number> {
  if (monitoringType !== "End") return 1;

  const lastVideo = await PlaylistVideoMapping.findOne({
    where: { playlistUrl: videoUrl },
    order: [["positionInPlaylist", "DESC"]],
    attributes: ["positionInPlaylist"],
  });

  const maxPosition = lastVideo
    ? lastVideo.getDataValue("positionInPlaylist")
    : 0;
  return maxPosition > 0 ? Math.max(1, maxPosition - chunkSize + 1) : 1;
}

/**
 * Errors that mean "we stopped this ourselves", not "this listing failed".
 *
 * Reads the exit code off the typed error rather than matching the message:
 * the producer appends `: <reason>` whenever yt-dlp wrote to stderr, so a
 * SIGTERM-with-stderr used to slip past a string comparison and surface to
 * the user as a listing failure.
 */
function isDeliberateTermination(error: Error): boolean {
  return error instanceof ListingProcessError &&
    error.isDeliberateTermination;
}

export async function handlePlaylistStreaming(
  rt: ListingRuntime,
  item: {
    videoUrl: string;
    chunkSize: number;
    isScheduledUpdate: boolean;
    shouldEmitProgress: boolean;
    playlistTitle: string;
    seekPlaylistListTo: number;
    processKey: string;
    monitoringType: string;
  },
): Promise<ListingResult> {
  const { videoUrl, chunkSize, processKey, monitoringType } = item;

  logger.info("Starting streaming listing for playlist", { url: videoUrl });

  // If YouTube API is configured and this is a YouTube URL, always use the API
  if (isYouTubeApiConfigured() && isYouTubeUrl(videoUrl)) {
    // Try extracting playlist ID directly, or resolve channel URL to uploads playlist
    let playlistId = extractPlaylistId(videoUrl);
    if (!playlistId && isChannelUrl(videoUrl)) {
      playlistId = await resolveChannelUploadsPlaylistId(videoUrl);
    }
    if (playlistId) {
      try {
        logger.info(
          "Routing to YouTube API path",
          { url: videoUrl, playlistId },
        );
        return await handlePlaylistViaApi(rt, { ...item, playlistId });
      } catch (apiError) {
        logger.warn(
          "YouTube API failed, falling back to yt-dlp",
          { url: videoUrl, error: (apiError as Error).message },
        );
      }
    }
  }

  await clearMappingsForReindex(videoUrl, monitoringType);
  const startIndex = await resolveStartIndex(
    videoUrl,
    chunkSize,
    monitoringType,
  );

  const streamProcessor = streamPlayListItems(
    rt,
    videoUrl,
    processKey,
    startIndex,
  );

  return await consumePlaylistChunks(rt, {
    chunks: chunkPlaylistLines(
      streamProcessor.iterator,
      chunkSize,
      startIndex,
    ),
    stop: () => streamProcessor.process.kill("SIGTERM"),
    onEmpty: () => {
      // A tail walk that starts past the top and finds nothing is not an
      // empty playlist — the positions it was told about are gone.
      if (monitoringType === "End" && startIndex > 1) {
        throw new Error(
          "End mode index returned empty due to likely deletions.",
        );
      }
      return handleEmptyResponse(rt, videoUrl);
    },
    onError: (error) =>
      isDeliberateTermination(error)
        ? null
        : handleListingError(rt, error, videoUrl, "playlist"),
  }, item);
}

async function handlePlaylistViaApi(
  rt: ListingRuntime,
  item: {
    videoUrl: string;
    chunkSize: number;
    isScheduledUpdate: boolean;
    shouldEmitProgress: boolean;
    playlistTitle: string;
    seekPlaylistListTo: number;
    processKey: string;
    monitoringType: string;
    playlistId: string;
  },
): Promise<ListingResult> {
  const { videoUrl, chunkSize, processKey, monitoringType, playlistId } = item;

  logger.info("Starting YouTube API listing for playlist", {
    url: videoUrl,
    playlistId,
  });

  await clearMappingsForReindex(videoUrl, monitoringType);

  // Tell the cleanup job this key is live work, not a stalled entry. The
  // yt-dlp path gets this from spawning; there is no process here to do it.
  rt.setProcessStatus(processKey, "running", { stdout: true });

  let totalExpected = 0;

  async function* apiChunks(): AsyncGenerator<PlaylistChunk> {
    for await (
      const page of fetchPlaylistItemsChunked(playlistId, chunkSize)
    ) {
      totalExpected = page.totalExpected;
      yield { items: page.items, startIndex: page.chunkStartIndex };
    }
  }

  return await consumePlaylistChunks(rt, {
    chunks: apiChunks(),
    onEmpty: () => handleEmptyResponse(rt, videoUrl),
    onError: (error) => {
      logger.error("YouTube API listing failed", {
        url: videoUrl,
        playlistId,
        error: error.message,
        stack: error.stack,
      });
      rt.setProcessStatus(processKey, "failed");
      // Rethrown rather than reported: the caller uses this to decide
      // whether to fall back to yt-dlp.
      throw error;
    },
    onChunkDone: (processedChunks) => {
      if (processedChunks % 10 === 0) {
        logger.info("YouTube API processing progress", {
          url: videoUrl,
          processedChunks,
          totalExpected,
        });
      }
    },
  }, item);
}

async function handleSingleVideoStreaming(
  rt: ListingRuntime,
  item: {
    videoUrl: string;
    itemType: string;
    isScheduledUpdate: boolean;
    processKey: string;
  },
): Promise<ListingResult> {
  const { videoUrl, itemType, isScheduledUpdate, processKey } = item;
  const playlistUrl = "None";

  if (itemType === "undownloaded") {
    return {
      url: videoUrl,
      title: "Video",
      status: "unchanged",
      processedChunks: 0,
    };
  }

  try {
    const streamProcessor = streamPlayListItems(rt, videoUrl, processKey);
    const chunkItems: string[] = [];

    for await (const line of streamProcessor.iterator) {
      chunkItems.push(line);
    }

    if (chunkItems.length === 0) {
      return handleEmptyResponse(rt, videoUrl);
    }

    const existingMapping = await PlaylistVideoMapping.findOne({
      where: {
        videoUrl: chunkItems.length === 1
          ? normalizeUrl(
            JSON.parse(chunkItems[0]).webpage_url ||
              JSON.parse(chunkItems[0]).url || "",
          )
          : "",
        playlistUrl,
      },
    });

    let newStartIndex: number;
    if (existingMapping) {
      newStartIndex = existingMapping.getDataValue(
        "positionInPlaylist",
      ) as number;
    } else {
      const lastVideo = await PlaylistVideoMapping.findOne({
        where: { playlistUrl },
        order: [["positionInPlaylist", "DESC"]],
        attributes: ["positionInPlaylist"],
        limit: 1,
      });
      newStartIndex = lastVideo
        ? lastVideo.getDataValue("positionInPlaylist") + 1
        : 1;
    }

    const result = await processStreamingVideoInformation(
      chunkItems,
      playlistUrl,
      newStartIndex,
      isScheduledUpdate,
    );

    if (result.count === 1) {
      rt.safeEmit("listing-single-item-complete", {
        url: videoUrl,
        type: itemType,
        title: result.title,
        status: "completed",
        processedChunks: 1,
        seekSubListTo: newStartIndex,
        alreadyExisted: result.alreadyExistedCount > 0,
        duplicateScope: result.alreadyExistedCount > 0 ? "none" : undefined,
      });
      return {
        url: videoUrl,
        title: result.title,
        status: "completed",
        processedChunks: 1,
      };
    }

    return {
      url: videoUrl,
      title: result.title,
      status: "completed",
      processedChunks: result.count,
    };
  } catch (error) {
    return handleListingError(rt, error as Error, videoUrl, itemType);
  }
}

/**
 * Spawns the yt-dlp listing subprocess and wraps its stdout as a line
 * iterator that classifies the exit.
 *
 * Fatal if the process entry is gone by the time the child is up: the
 * subprocess is running and nothing would ever reap it.
 */
export function streamPlayListItems(
  rt: ListingRuntime,
  videoUrl: string,
  processKey: string,
  startIndex: number = 1,
): { process: ManagedProcess; iterator: AsyncGenerator<string> } {
  logger.trace("Starting streaming fetch for items", {
    url: videoUrl,
    processKey,
    startIndex,
  });

  const { process: listProcess } = rt.launchYtDlp({
    url: videoUrl,
    flags: [
      "--playlist-start",
      startIndex.toString(),
      "--dump-json",
      "--no-download",
    ],
    reason: `Starting streaming listing for ${videoUrl}`,
  });

  if (
    !rt.setProcessStatus(processKey, "running", {
      spawnedProcess: listProcess,
    })
  ) {
    throw new Error(`Process entry not found: ${processKey}`);
  }

  // Retain the last yt-dlp diagnostic so a failure can report *why* rather
  // than only an exit code ("No video could be found in this tweet" is far
  // more actionable than "Process exited with code 1").
  let lastStderr = "";
  const stderrDrained = (async () => {
    for await (const data of rt.streamTextChunks(listProcess.stderr)) {
      logger.error("List process error", {
        error: data,
        pid: listProcess.pid,
      });
      const trimmed = data.trim();
      if (trimmed) {
        lastStderr = trimmed;
      }
      rt.updateProcessActivity(processKey);
    }
  })().catch(() => {
    // Draining stderr is best-effort; never let it mask the real failure.
  });

  /** Last stderr line, normalised for use in an error message. */
  function stderrReason(): string {
    const line = lastStderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
    return line.replace(/^ERROR:\s*/i, "").slice(0, 300);
  }

  async function* lineIterator() {
    let linesYielded = 0;
    try {
      for await (const line of rt.streamLines(listProcess.stdout)) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          rt.updateProcessActivity(processKey, true);
          linesYielded++;
          yield trimmed;
        }
      }

      const exitCode = listProcess.killed
        ? null
        : (await listProcess.status).code;
      const isAllowedError = exitCode === ProcessExitCodes.PARTIAL_ERROR &&
        linesYielded > 0;

      if (
        !listProcess.killed && exitCode !== ProcessExitCodes.SUCCESS &&
        !isAllowedError
      ) {
        rt.setProcessStatus(processKey, "failed");
        // The exit code travels as a field; the message keeps its original
        // shape and appends the reason when yt-dlp gave one.
        await stderrDrained;
        throw new ListingProcessError(exitCode, stderrReason());
      } else {
        rt.setProcessStatus(processKey, "completed");
      }
    } catch (error) {
      rt.setProcessStatus(processKey, "errored");
      if (!listProcess.killed) {
        listProcess.kill();
      }
      throw error;
    }
  }

  return {
    process: listProcess,
    iterator: lineIterator(),
  };
}

function handleEmptyResponse(rt: ListingRuntime, videoUrl: string) {
  rt.safeEmit("listing-error", {
    url: videoUrl,
    error: "No items found",
  });

  return {
    url: videoUrl,
    title: "Video",
    status: "failed",
    error: "No items found",
  };
}

function handleListingError(
  rt: ListingRuntime,
  error: Error,
  videoUrl: string,
  itemType: string,
) {
  logger.error("Listing failed", {
    url: videoUrl,
    error: error.message,
    stack: error.stack,
  });
  rt.safeEmit("listing-error", {
    url: videoUrl,
    error: error.message,
  });
  return {
    url: videoUrl,
    title: itemType === "playlist" ? "Playlist" : "Video",
    status: "failed",
    error: error.message,
  };
}

function completePlaylistListing(
  rt: ListingRuntime,
  videoUrl: string,
  processedChunks: number,
  playlistTitle: string,
  seekPlaylistListTo: number,
  shouldEmitProgress: boolean,
) {
  logger.info("Playlist listing completed", {
    url: videoUrl,
    processedChunks,
    playlistTitle,
    seekPlaylistListTo,
  });

  if (shouldEmitProgress) {
    rt.safeEmit("listing-playlist-complete", {
      url: videoUrl,
      type: "playlist",
      status: "completed",
      processedChunks,
      playlistTitle,
      seekPlaylistListTo,
    });
  }

  return {
    url: videoUrl,
    type: "Playlist",
    status: "completed",
    processedChunks,
    playlistTitle,
    seekPlaylistListTo,
  };
}
