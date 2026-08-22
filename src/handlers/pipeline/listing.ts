// deno-lint-ignore-file no-explicit-any
import he from "he";
import { Model, Op } from "sequelize";
import { config } from "../../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import {
  extractPlaylistId,
  fetchPlaylistItemsChunked,
  isChannelUrl,
  isYouTubeApiConfigured,
  isYouTubeUrl,
  resolveChannelUploadsPlaylistId,
} from "../youtube-api.ts";
import { Semaphore } from "./semaphore.ts";
import {
  ListingProcessError,
  playlistRegex,
  ProcessExitCodes,
} from "./types.ts";
import type {
  ListingItem,
  ListingProcessEntry,
  ListingRequestBody,
  ListingResult,
  ManagedProcess,
  ParsedStreamItem,
  PipelineHandlerDependencies,
  PlaylistMappingCreate,
  PlaylistMappingUpdate,
  StreamedItemData,
  StreamingVideoProcessingResult,
  VideoUpsertData,
} from "./types.ts";
import { json } from "../../utils/http.ts";
import { truncateText, urlToTitle } from "./process-manager.ts";
import { join } from "../../utils/path.ts";
import {
  hasEphemeralThumbnails,
  isSiteXDotCom,
  normalizeUrl,
} from "../../utils/url.ts";
import type { ProcessStatus, ProcessStatusOptions } from "./process-manager.ts";
import { chunkPlaylistLines, type PlaylistChunk } from "./chunks.ts";
import { createYtDlpLauncher } from "./ytdlp.ts";

export function createListingFlow(
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
) {
  const {
    safeEmit,
    buildSiteArgs,
    spawnPythonProcess,
    streamTextChunks,
    streamLines,
  } = deps;
  const ListingSemaphore = new Semaphore(
    config.queue.maxListings,
    "ListingSemaphore",
  );
  let pendingPlaylistSortCounter: number | null = null;
  let pendingPlaylistSortCounterPromise: Promise<number> | null = null;
  let pendingPlaylistCreatePromise: Promise<void> = Promise.resolve();

  const { updateProcessActivity, setProcessStatus } = processManager;
  const launchYtDlp = createYtDlpLauncher({
    buildSiteArgs,
    spawnPythonProcess,
  });

  function buildDownloadLocation(videoEntry: Model): string | null {
    const saveDirectory = videoEntry.getDataValue("saveDirectory") as
      | string
      | null;
    const fileName = videoEntry.getDataValue("fileName") as string | null;

    if (!saveDirectory && !fileName) {
      return null;
    }

    if (fileName) {
      return join(config.saveLocation, saveDirectory ?? "", fileName);
    }

    return join(config.saveLocation, saveDirectory ?? "");
  }

  function getVideoDisplayLabel(videoEntry: Model): string {
    const title = videoEntry.getDataValue("title") as string | null;
    const videoUrl = videoEntry.getDataValue("videoUrl") as string | null;
    const videoId = videoEntry.getDataValue("videoId") as string | null;
    return title || videoUrl || videoId || "video";
  }

  async function getExistingPlaylistMentions(videoUrl: string): Promise<
    Array<{
      playlistUrl: string;
      title: string;
      positionInPlaylist: number;
      sortOrder: number;
    }>
  > {
    const mappings = await PlaylistVideoMapping.findAll({
      where: {
        videoUrl,
        playlistUrl: { [Op.ne]: "None" },
      },
      attributes: ["playlistUrl", "positionInPlaylist"],
    });

    const playlistUrls = [
      ...new Set(
        mappings.map((mapping) =>
          mapping.getDataValue("playlistUrl") as string
        ),
      ),
    ];

    if (playlistUrls.length === 0) {
      return [];
    }

    const playlists = await PlaylistMetadata.findAll({
      where: {
        playlistUrl: { [Op.in]: playlistUrls },
      },
      attributes: ["playlistUrl", "title", "sortOrder"],
    });

    const playlistByUrl = new Map<string, {
      title: string;
      sortOrder: number;
    }>(
      playlists.map((playlist) => [
        playlist.getDataValue("playlistUrl") as string,
        {
          title: playlist.getDataValue("title") as string,
          sortOrder: playlist.getDataValue("sortOrder") as number,
        },
      ]),
    );

    return mappings
      .map((mapping) => {
        const playlistUrl = mapping.getDataValue("playlistUrl") as string;
        const playlist = playlistByUrl.get(playlistUrl);
        if (!playlist) {
          return null;
        }

        return {
          playlistUrl,
          title: playlist.title,
          positionInPlaylist: mapping.getDataValue(
            "positionInPlaylist",
          ) as number,
          sortOrder: playlist.sortOrder,
        };
      })
      .filter((playlist): playlist is {
        playlistUrl: string;
        title: string;
        positionInPlaylist: number;
        sortOrder: number;
      } => playlist !== null)
      .sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }
        if (left.positionInPlaylist !== right.positionInPlaylist) {
          return left.positionInPlaylist - right.positionInPlaylist;
        }
        return left.title.localeCompare(right.title);
      });
  }

  async function processListingRequest(
    requestBody: ListingRequestBody,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      const chunkSize = Math.max(
        config.chunkSize,
        +(requestBody.chunkSize ?? config.chunkSize),
      );
      const monitoringType = requestBody.monitoringType ?? "N/A";
      const itemsToList: ListingItem[] = [];
      const uniqueUrls = new Set();

      logger.trace("Processing URL list", {
        urlCount: requestBody.urlList.length,
        chunkSize,
        monitoringType,
      });

      for (const url of requestBody.urlList) {
        const normalizedUrl = normalizeUrl(url);
        if (uniqueUrls.has(normalizedUrl)) {
          continue;
        }

        logger.debug("Checking URL in database", { url: normalizedUrl });

        const playlistEntry = await PlaylistMetadata.findOne({
          where: { playlistUrl: normalizedUrl },
        });

        if (playlistEntry) {
          logger.debug("Playlist found in database", { url: normalizedUrl });
          if (playlistEntry.monitoringType === monitoringType) {
            logger.debug("Playlist monitoring hasn't changed so skipping", {
              url: normalizedUrl,
            });
            safeEmit("listing-playlist-skipped-because-same-monitoring", {
              message:
                `Playlist ${playlistEntry.title} is already being monitored with type ${monitoringType}, skipping.`,
            });
            continue;
          } else {
            logger.debug("Playlist monitoring has changed", {
              url: normalizedUrl,
            });
            itemsToList.push({
              url: normalizedUrl,
              type: "playlist",
              previousMonitoringType: playlistEntry.monitoringType,
              currentMonitoringType: monitoringType,
              reason: "Monitoring type changed",
            });
          }
        }

        let videoEntry = await VideoMetadata.findOne({
          where: { videoUrl: normalizedUrl },
        });

        // Fallback: if not found by exact URL, try by videoId scoped to same domain.
        // This catches duplicate URL forms that normalization may have missed.
        if (!videoEntry) {
          try {
            const parsedFallback = new URL(normalizedUrl);
            // Build a hostname-scoped LIKE pattern (covers www/non-www/subdomains).
            const domainCore = parsedFallback.hostname
              .replace(/^www\./, "")
              .replace(/^m\./, "");
            const pathParts = parsedFallback.pathname.split("/").filter(
              Boolean,
            );
            // Use the last meaningful path segment as a candidate videoId.
            const candidateId = pathParts.at(-1) ||
              parsedFallback.searchParams.get("v") || "";
            if (candidateId && domainCore) {
              const byId = await VideoMetadata.findOne({
                where: {
                  videoId: candidateId,
                  videoUrl: { [Op.iLike]: `%${domainCore}%` },
                },
              });
              if (byId) {
                logger.info("videoId fallback matched duplicate URL form", {
                  inputUrl: normalizedUrl,
                  canonicalUrl: byId.getDataValue("videoUrl"),
                  videoId: candidateId,
                });
                // Treat the existing canonical URL as the effective URL.
                videoEntry = byId;
              }
            }
          } catch {
            // Malformed URL, skip fallback silently
          }
        }

        if (videoEntry) {
          logger.debug("Video found in database", { url: normalizedUrl });
          const canonicalUrl = videoEntry.getDataValue("videoUrl") as string;
          const [existingMapping, lastNoneMapping, existingPlaylists] =
            await Promise.all([
              PlaylistVideoMapping.findOne({
                where: {
                  videoUrl: canonicalUrl,
                  playlistUrl: "None",
                },
                order: [["positionInPlaylist", "ASC"]],
              }),
              PlaylistVideoMapping.findOne({
                where: {
                  playlistUrl: "None",
                },
                order: [["positionInPlaylist", "DESC"]],
                attributes: ["positionInPlaylist"],
              }),
              getExistingPlaylistMentions(canonicalUrl),
            ]);
          const downloadLocation = buildDownloadLocation(videoEntry);
          const firstExistingPlaylist = existingPlaylists[0] ?? null;
          const displayLabel = getVideoDisplayLabel(videoEntry);

          if (existingMapping) {
            safeEmit("listing-single-item-complete", {
              url: canonicalUrl,
              type: "video",
              title: videoEntry.title,
              itemLabel: displayLabel,
              status: "completed",
              processedChunks: 1,
              seekSubListTo: existingMapping.positionInPlaylist,
              alreadyExisted: true,
              duplicateScope: "none",
              downloadLocation,
              existingPlaylists,
            });
            continue;
          }

          const newPosition = lastNoneMapping
            ? (lastNoneMapping.getDataValue("positionInPlaylist") as number) + 1
            : 1;

          await PlaylistVideoMapping.create({
            videoUrl: canonicalUrl,
            playlistUrl: "None",
            positionInPlaylist: newPosition,
          });

          safeEmit("listing-single-item-complete", {
            url: canonicalUrl,
            type: "video",
            title: videoEntry.title,
            itemLabel: displayLabel,
            status: "completed",
            processedChunks: 1,
            seekSubListTo: newPosition,
            alreadyExisted: false,
            addedFromDownloaded: Boolean(videoEntry.downloadStatus),
            addedFromExisting: true,
            downloadLocation,
            existingPlaylists,
            sourcePlaylist: firstExistingPlaylist,
          });
          continue;
        }

        if (!playlistEntry && !videoEntry) {
          logger.debug("URL not found in database, adding to list", {
            url: normalizedUrl,
          });
          itemsToList.push({
            url: normalizedUrl,
            type: "undetermined",
            currentMonitoringType: monitoringType,
            reason: "URL not found in database",
          });
        }

        uniqueUrls.add(normalizedUrl);
      }

      // Read the backlog before enqueuing so the client can tell the user how
      // many items are already ahead of the ones it just submitted.
      const queueDepthBefore = getListingQueueDepth();

      void listItemsConcurrently(itemsToList, chunkSize, false);

      logger.debug("Listing processes started", {
        itemCount: itemsToList.length,
        queueDepthBefore,
      });

      json(response, 200, {
        status: "success",
        message: "Listing initiated",
        items: itemsToList,
        queueDepthBefore,
      });
    } catch (error) {
      logger.error("Failed to process URL list", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      json(response, 500, {
        status: "error",
        message: he.escape((error as Error).message),
      });
    }
  }

  /**
   * True listing backlog: items holding a semaphore slot plus those parked in
   * the FIFO queue. listProcesses alone undercounts badly, because entries are
   * only registered after acquire() succeeds — during a batch re-index with
   * MAX_LISTINGS=1 that would report 1 regardless of how many are waiting.
   */
  function getListingQueueDepth(): number {
    return listProcesses.size + ListingSemaphore.pendingCount;
  }

  async function listItemsConcurrently(
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

    ListingSemaphore.setMaxConcurrent(config.queue.maxListings);

    const listingResults = await Promise.all(
      items.map((item) =>
        listWithSemaphore(item, chunkSize, isScheduledUpdate)
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
    item: ListingItem,
    chunkSize: number,
    isScheduledUpdate: boolean,
  ): Promise<ListingResult> {
    logger.trace(`Starting listing with semaphore: ${JSON.stringify(item)}`);

    await ListingSemaphore.acquire();

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
      listProcesses.set(entryKey, listEntry);

      const result = await executeListing(
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

      if (listProcesses.has(entryKey)) {
        listProcesses.delete(entryKey);
      }

      return result;
    } finally {
      ListingSemaphore.release();
    }
  }

  async function executeListing(
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
        safeEmit("listing-started", {
          url: videoUrl,
          type: itemType,
          status: "started",
        });
      }

      const isPlaylist = playlistRegex.test(videoUrl) ||
        itemType === "playlist";
      itemType = isPlaylist && !isSiteXDotCom(videoUrl)
        ? "playlist"
        : "unlisted";

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
            return handleEmptyResponse(videoUrl);
          } else if (
            existingPlaylist.monitoringType !==
              currentMonitoringType
          ) {
            logger.debug("Playlist monitoring has changed", { url: videoUrl });
            await existingPlaylist.update({
              monitoringType:
                ["Refresh", "Full"].includes(currentMonitoringType)
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
            videoUrl,
            ["Refresh", "Full"].includes(currentMonitoringType)
              ? "N/A"
              : currentMonitoringType,
          );
          playlistTitle = newPlaylist.title;
          seekPlaylistListTo = newPlaylist.sortOrder;
        }

        return await handlePlaylistStreaming({
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

      return await handleSingleVideoStreaming({
        videoUrl,
        itemType,
        isScheduledUpdate: resolvedIsScheduledUpdate,
        processKey,
      });
    } catch (error) {
      return handleListingError(error as Error, videoUrl, itemType);
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
        updateProcessActivity(processKey, true);

        if (!isScheduledUpdate) {
          safeEmit("listing-playlist-chunk-complete", {
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
    setProcessStatus(processKey, "completed");

    return completePlaylistListing(
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

  async function handlePlaylistStreaming(
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
          return await handlePlaylistViaApi({ ...item, playlistId });
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
      videoUrl,
      processKey,
      startIndex,
    );

    return await consumePlaylistChunks({
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
        return handleEmptyResponse(videoUrl);
      },
      onError: (error) =>
        isDeliberateTermination(error)
          ? null
          : handleListingError(error, videoUrl, "playlist"),
    }, item);
  }

  async function handlePlaylistViaApi(
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
    const { videoUrl, chunkSize, processKey, monitoringType, playlistId } =
      item;

    logger.info("Starting YouTube API listing for playlist", {
      url: videoUrl,
      playlistId,
    });

    await clearMappingsForReindex(videoUrl, monitoringType);

    // Tell the cleanup job this key is live work, not a stalled entry. The
    // yt-dlp path gets this from spawning; there is no process here to do it.
    setProcessStatus(processKey, "running", { stdout: true });

    let totalExpected = 0;

    async function* apiChunks(): AsyncGenerator<PlaylistChunk> {
      for await (
        const page of fetchPlaylistItemsChunked(playlistId, chunkSize)
      ) {
        totalExpected = page.totalExpected;
        yield { items: page.items, startIndex: page.chunkStartIndex };
      }
    }

    return await consumePlaylistChunks({
      chunks: apiChunks(),
      onEmpty: () => handleEmptyResponse(videoUrl),
      onError: (error) => {
        logger.error("YouTube API listing failed", {
          url: videoUrl,
          playlistId,
          error: error.message,
          stack: error.stack,
        });
        setProcessStatus(processKey, "failed");
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
      const streamProcessor = streamPlayListItems(videoUrl, processKey);
      const chunkItems: string[] = [];

      for await (const line of streamProcessor.iterator) {
        chunkItems.push(line);
      }

      if (chunkItems.length === 0) {
        return handleEmptyResponse(videoUrl);
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
        safeEmit("listing-single-item-complete", {
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
      return handleListingError(error as Error, videoUrl, itemType);
    }
  }

  function streamPlayListItems(
    videoUrl: string,
    processKey: string,
    startIndex: number = 1,
  ): { process: ManagedProcess; iterator: AsyncGenerator<string> } {
    logger.trace("Starting streaming fetch for items", {
      url: videoUrl,
      processKey,
      startIndex,
    });

    const { process: listProcess } = launchYtDlp({
      url: videoUrl,
      flags: [
        "--playlist-start",
        startIndex.toString(),
        "--dump-json",
        "--no-download",
      ],
      reason: `Starting streaming listing for ${videoUrl}`,
    });

    // Fatal if the entry is gone: the subprocess is running and nothing would
    // ever reap it.
    if (
      !setProcessStatus(processKey, "running", {
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
      for await (const data of streamTextChunks(listProcess.stderr)) {
        logger.error("List process error", {
          error: data,
          pid: listProcess.pid,
        });
        const trimmed = data.trim();
        if (trimmed) {
          lastStderr = trimmed;
        }
        updateProcessActivity(processKey);
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
        for await (const line of streamLines(listProcess.stdout)) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            updateProcessActivity(processKey, true);
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
          setProcessStatus(processKey, "failed");
          // The exit code travels as a field; the message keeps its original
          // shape and appends the reason when yt-dlp gave one.
          await stderrDrained;
          throw new ListingProcessError(exitCode, stderrReason());
        } else {
          setProcessStatus(processKey, "completed");
        }
      } catch (error) {
        setProcessStatus(processKey, "errored");
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

  async function processStreamingVideoInformation(
    responseItems: string[],
    playlistUrl: string,
    chunkStartIndex: number,
    isUpdate: boolean,
    monitoringType?: string,
  ): Promise<StreamingVideoProcessingResult> {
    logger.trace("Processing video information chunk", {
      playlistUrl,
      chunkStartIndex,
      isUpdate,
      itemCount: responseItems.length,
    });

    const result: StreamingVideoProcessingResult = {
      count: 0,
      title: "",
      responseUrl: playlistUrl,
      alreadyExistedCount: 0,
    };

    const parsedItems = responseItems.map(
      (item, index): ParsedStreamItem | null => {
        try {
          const itemData = JSON.parse(item) as StreamedItemData;
          // Normalize the URL from yt-dlp so it matches the canonical PK form.
          // This ensures that yt-dlp's webpage_url and a user-pasted URL with
          // a trailing slug (e.g. iwara) or noise params (e.g. YouTube list=)
          // both resolve to the same videoUrl primary key.
          const rawUrl = itemData.webpage_url || itemData.url || "";
          const videoUrl = normalizeUrl(rawUrl);
          const onlineThumbnail = hasEphemeralThumbnails(videoUrl)
            ? null
            : (itemData.thumbnail || null);

          delete itemData.formats;
          delete itemData.requested_formats;
          delete itemData.thumbnails;
          delete itemData.subtitles;
          delete itemData.automatic_captions;

          return { itemData, videoUrl, index, onlineThumbnail };
        } catch (e) {
          logger.error("Failed to parse JSON from stream", {
            item,
            error: e as Error,
          });
          return null;
        }
      },
    ).filter((item): item is NonNullable<typeof item> => item !== null);

    if (parsedItems.length === 0) {
      return result;
    }

    const videoUrls = parsedItems.map((parsedItem) => parsedItem.videoUrl);
    const [existingVideos, existingMappings] = await Promise.all([
      VideoMetadata.findAll({ where: { videoUrl: { [Op.in]: videoUrls } } }),
      PlaylistVideoMapping.findAll({
        where: {
          videoUrl: { [Op.in]: videoUrls },
          playlistUrl: playlistUrl,
        },
      }),
    ]);

    const existingVideosMap = new Map<string, Model>(
      existingVideos.map((video) => [
        video.getDataValue("videoUrl") as string,
        video,
      ]),
    );
    const existingMappingsMap = new Map<string, Model>(
      existingMappings.map((mapping) => [
        `${mapping.getDataValue("videoUrl")}|${
          mapping.getDataValue("positionInPlaylist")
        }`,
        mapping,
      ]),
    );
    const existingMappingsByUrl = new Map<string, Model>(
      existingMappings.map((mapping) => [
        mapping.getDataValue("videoUrl") as string,
        mapping,
      ]),
    );

    const videosToUpsert: VideoUpsertData[] = [];
    const mappingsToCreate: PlaylistMappingCreate[] = [];
    const mappingsToUpdate: PlaylistMappingUpdate[] = [];

    for (const { itemData, videoUrl, index, onlineThumbnail } of parsedItems) {
      const title = itemData.title || "";
      const videoId = itemData.id || "";
      const approxSize = itemData.filesize_approx || "NA";
      const existingVideo = existingVideosMap.get(videoUrl);
      const absoluteIndex = playlistUrl === "None"
        ? chunkStartIndex
        : chunkStartIndex + index;
      const existingMapping = existingMappingsMap.get(
        `${videoUrl}|${absoluteIndex}`,
      );

      if (
        monitoringType !== "Refresh" &&
        existingVideo && existingMapping &&
        existingMapping.getDataValue("positionInPlaylist") === absoluteIndex
      ) {
        result.alreadyExistedCount++;
        result.count++;
        result.title = existingVideo.getDataValue("title");
        continue;
      }

      const videoData: VideoUpsertData = {
        videoUrl: videoUrl,
        videoId: videoId.trim(),
        title: truncateText(
          title === "NA" ? videoId.trim() : title,
          config.maxTitleLength,
        ),
        approximateSize: approxSize === "NA"
          ? -1
          : parseInt(String(approxSize)),
        downloadStatus: existingVideo
          ? Boolean(existingVideo.getDataValue("downloadStatus"))
          : false,
        isAvailable: ![
          "[Deleted video]",
          "[Private video]",
          "[Unavailable video]",
        ].includes(title),
        onlineThumbnail: onlineThumbnail,
        raw_metadata: itemData,
      };

      videosToUpsert.push(videoData);

      if (!existingMapping) {
        if (playlistUrl === "None") {
          // "None" is the pseudo-playlist for unlisted/unplaylisted videos.
          // Duplicates are NOT allowed here — if the video already has a mapping,
          // update its position instead of creating a new one.
          const driftedMapping = existingMappingsByUrl.get(videoUrl);
          if (
            driftedMapping &&
            driftedMapping.getDataValue("positionInPlaylist") !== absoluteIndex
          ) {
            mappingsToUpdate.push({
              instance: driftedMapping,
              position: absoluteIndex,
            });
          } else if (!driftedMapping) {
            mappingsToCreate.push({
              videoUrl: videoUrl,
              playlistUrl: playlistUrl,
              positionInPlaylist: absoluteIndex,
            });
          }
        } else {
          // Real playlists: duplicates ARE allowed. YouTube allows the same video
          // at multiple positions in a playlist, so we must create a separate
          // mapping for each occurrence. Do NOT look for drifted mappings to update.
          mappingsToCreate.push({
            videoUrl: videoUrl,
            playlistUrl: playlistUrl,
            positionInPlaylist: absoluteIndex,
          });
        }
      } else if (
        existingMapping.getDataValue("positionInPlaylist") !== absoluteIndex
      ) {
        mappingsToUpdate.push({
          instance: existingMapping,
          position: absoluteIndex,
        });
      }

      result.count++;
      result.title = videoData.title;
      logger.debug("Processed video item in memory", {
        videoUrl,
        title: videoData.title,
        playlistUrl,
        index: absoluteIndex,
      });
    }

    if (videosToUpsert.length > 0) {
      const deduplicatedVideos = [
        ...new Map(
          videosToUpsert.map((video) => [video.videoUrl, video]),
        ).values(),
      ];
      await VideoMetadata.unscoped().bulkCreate(
        deduplicatedVideos as any,
        {
          updateOnDuplicate: [
            "videoId",
            "title",
            "approximateSize",
            "isAvailable",
            "updatedAt",
            "onlineThumbnail",
            "raw_metadata",
          ],
        },
      );
    }

    if (mappingsToCreate.length > 0) {
      await PlaylistVideoMapping.bulkCreate(
        mappingsToCreate as any,
      );
    }

    if (mappingsToUpdate.length > 0) {
      const cases = mappingsToUpdate
        .map((m) =>
          `WHEN "id" = '${m.instance.getDataValue("id")}' THEN ${m.position}`
        )
        .join(" ");
      const ids = mappingsToUpdate
        .map((m) => `'${m.instance.getDataValue("id")}'`)
        .join(", ");
      await sequelize.query(
        `UPDATE playlist_video_mappings SET "positionInPlaylist" = CASE ${cases} END WHERE "id" IN (${ids})`,
      );
    }

    return result;
  }

  function handleEmptyResponse(videoUrl: string) {
    safeEmit("listing-error", {
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
    error: Error,
    videoUrl: string,
    itemType: string,
  ) {
    logger.error("Listing failed", {
      url: videoUrl,
      error: error.message,
      stack: error.stack,
    });
    safeEmit("listing-error", {
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
      safeEmit("listing-playlist-complete", {
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

  async function addPlaylist(
    playlistUrl: string,
    monitoringType: string,
  ): Promise<PlaylistMetadata> {
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

    // With --ignore-errors, yt-dlp skips broken items and emits JSON only for
    // accessible ones, so the first line that arrives is the first usable one
    // and its playlist_title is all this probe wants.
    //
    // Both drains and the exit status are awaited together. This used to be
    // three detached IIFEs inside a `new Promise`, where the one waiting on
    // the exit status read a variable another one wrote — correct only for as
    // long as yt-dlp happened to flush stdout before exiting, and silently
    // yielding a URL-derived title when it did not.
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

  async function ensurePendingPlaylistSortCounterInitialized() {
    if (pendingPlaylistSortCounter !== null) {
      return pendingPlaylistSortCounter;
    }

    // Initialize once from DB, then keep handing out sort orders from memory.
    if (pendingPlaylistSortCounterPromise === null) {
      pendingPlaylistSortCounterPromise = PlaylistMetadata.findOne({
        order: [["sortOrder", "DESC"]],
        attributes: ["sortOrder"],
        limit: 1,
      }).then((lastPlaylist: PlaylistMetadata | null) => {
        const initialValue = lastPlaylist !== null
          ? lastPlaylist.sortOrder + 1
          : 0;
        pendingPlaylistSortCounter = initialValue;
        return initialValue;
      });
    }

    return await pendingPlaylistSortCounterPromise;
  }

  async function createPlaylistRecord(
    playlistUrl: string,
    playlistTitle: string,
    monitoringType: string,
  ) {
    const previousCreatePromise = pendingPlaylistCreatePromise;
    let releaseCreateLock!: () => void;
    pendingPlaylistCreatePromise = new Promise<void>((resolve) => {
      releaseCreateLock = resolve;
    });

    await previousCreatePromise;

    try {
      await ensurePendingPlaylistSortCounterInitialized();

      const nextPlaylistIndex = pendingPlaylistSortCounter!;
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

      if (created) {
        pendingPlaylistSortCounter = nextPlaylistIndex + 1;
      } else {
        logger.warn("Playlist already exists", { url: playlistUrl });
      }

      return playlist;
    } finally {
      releaseCreateLock();
    }
  }

  function resetPendingPlaylistSortCounter() {
    pendingPlaylistSortCounter = null;
    pendingPlaylistSortCounterPromise = null;
  }

  return {
    processListingRequest,
    listItemsConcurrently,
    resetPendingPlaylistSortCounter,
    getListingQueueDepth,
  };
}
