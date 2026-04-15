import he from "he";
import { Model, Op } from "sequelize";
import { config } from "../../config.ts";
import { VideoMetadata, PlaylistMetadata, PlaylistVideoMapping } from "../../db/models.ts";
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
import { playlistRegex } from "./types.ts";
import type {
  ListingRequestBody, ListingItem, ListingResult, ListingProcessEntry,
  StreamedItemData, ParsedStreamItem, StreamingVideoProcessingResult,
  VideoUpsertData, PlaylistMappingCreate, PlaylistMappingUpdate,
  PipelineHandlerDependencies, ManagedProcess
} from "./types.ts";
import { generateCorsHeaders, MIME_TYPES } from "../../utils/http.ts";
import { urlToTitle, truncateText, isSiteXDotCom, hasEphemeralThumbnails, normalizeUrl } from "./process-manager.ts";

export function createListingFlow(
  deps: PipelineHandlerDependencies,
  listProcesses: Map<string, ListingProcessEntry>,
  processManager: {
    updateProcessActivity: (processKey: string, isStdout?: boolean) => void;
  }
) {
  const { safeEmit, buildSiteArgs, spawnPythonProcess, streamTextChunks, streamLines } = deps;
  const jsonMimeType = MIME_TYPES[".json"];
  const ListingSemaphore = new Semaphore(config.queue.maxListings, "ListingSemaphore");
  let pendingPlaylistSortCounter: number | null = null;
  let pendingPlaylistSortCounterPromise: Promise<number> | null = null;

  const { updateProcessActivity } = processManager;

  async function processListingRequest(
    requestBody: ListingRequestBody,
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      if (!requestBody.urlList) {
        throw new Error("URL list is required");
      }

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
          if ((playlistEntry as any).monitoringType === monitoringType) {
            logger.debug("Playlist monitoring hasn't changed so skipping", {
              url: normalizedUrl,
            });
            safeEmit("listing-playlist-skipped-because-same-monitoring", {
              message: `Playlist ${
                (playlistEntry as any).title
              } is already being monitored with type ${monitoringType}, skipping.`,
            });
            continue;
          } else {
            logger.debug("Playlist monitoring has changed", {
              url: normalizedUrl,
            });
            itemsToList.push({
              url: normalizedUrl,
              type: "playlist",
              previousMonitoringType: (playlistEntry as any).monitoringType,
              currentMonitoringType: monitoringType,
              reason: "Monitoring type changed",
            });
          }
        }

        const videoEntry = await VideoMetadata.findOne({
          where: { videoUrl: normalizedUrl },
        });
        if (videoEntry) {
          logger.debug("Video found in database", { url: normalizedUrl });
          if ((videoEntry as any).downloadStatus) {
            logger.debug("Video already downloaded", { url: normalizedUrl });
            const existingMapping = await PlaylistVideoMapping.findOne({
              where: {
                videoUrl: normalizedUrl,
                playlistUrl: "None",
              },
            });

            if (existingMapping) {
              safeEmit("listing-single-item-complete", {
                url: normalizedUrl,
                type: "video",
                title: (videoEntry as any).title,
                status: "completed",
                processedChunks: 1,
                seekSubListTo: (existingMapping as any).positionInPlaylist,
                alreadyExisted: true,
              });
              continue;
            }

            safeEmit("listing-video-skipped-because-downloaded", {
              message: `Video ${
                (videoEntry as any).title
              } is already downloaded, skipping.`,
            });
            continue;
          } else {
            logger.debug("Video not downloaded yet, updating status", {
              url: normalizedUrl,
            });
            itemsToList.push({
              url: normalizedUrl,
              type: "undownloaded",
              currentMonitoringType: "N/A",
              reason: "Video not downloaded yet",
            });
          }
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

      void listItemsConcurrently(itemsToList, chunkSize, false);

      logger.debug("Listing processes started", {
        itemCount: itemsToList.length,
      });

      response.writeHead(200, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "success",
        message: "Listing initiated",
        items: itemsToList,
      }));
    } catch (error) {
      logger.error("Failed to process URL list", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      response.writeHead(500, generateCorsHeaders(jsonMimeType));
      response.end(JSON.stringify({
        status: "error",
        message: he.escape((error as Error).message),
      }));
    }
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
      items.map((item) => listWithSemaphore(item, chunkSize, isScheduledUpdate)),
    );

    try {
      listingResults.forEach((result) => {
        if (result.status === "completed") {
          logger.info(
            `Listed ${result.title || result.playlistTitle} successfully`,
          );
        } else {
          logger.error(`Failed to list ${result.title}: ${JSON.stringify(result)}`);
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
    logger.debug(`isScheduledUpdate: ${resolvedIsScheduledUpdate}`, {
      item: JSON.stringify(item),
      isScheduledUpdate,
    });
    const { url: videoUrl, currentMonitoringType } = item;
    let itemType = item.type;

    try {
      if (!resolvedIsScheduledUpdate) {
        safeEmit("listing-started", {
          url: videoUrl,
          type: itemType,
          status: "started",
        });
      }

      const isPlaylist = playlistRegex.test(videoUrl) || itemType === "playlist";
      itemType = isPlaylist && !isSiteXDotCom(videoUrl) ? "playlist" : "unlisted";

      let playlistTitle = "";
      let seekPlaylistListTo = 0;

      if (itemType === "playlist") {
        const existingPlaylist = await PlaylistMetadata.findOne({
          where: { playlistUrl: videoUrl },
        });
        if (existingPlaylist) {
          logger.debug("Playlist already exists in database", { url: videoUrl });
          if (
            existingPlaylist.getDataValue("monitoringType") ===
              currentMonitoringType && !resolvedIsScheduledUpdate
          ) {
            return handleEmptyResponse(videoUrl);
          } else if (
            existingPlaylist.getDataValue("monitoringType") !==
              currentMonitoringType
          ) {
            logger.debug("Playlist monitoring has changed", { url: videoUrl });
            await existingPlaylist.update({
              monitoringType: ["Refresh", "Full"].includes(currentMonitoringType)
                ? "N/A"
                : currentMonitoringType,
              lastUpdatedByScheduler: resolvedIsScheduledUpdate ||
                  ["Refresh", "Full"].includes(currentMonitoringType)
                ? Date.now()
                : existingPlaylist.getDataValue("lastUpdatedByScheduler"),
            });
            logger.debug("Playlist monitoring type updated", { url: videoUrl });
          } else if (resolvedIsScheduledUpdate) {
            await existingPlaylist.update({
              monitoringType: currentMonitoringType === "Full"
                ? "N/A"
                : existingPlaylist.getDataValue("monitoringType"),
              lastUpdatedByScheduler: Date.now(),
            });
          }
          playlistTitle = existingPlaylist.getDataValue("title");
          seekPlaylistListTo = (existingPlaylist as any).sortOrder;
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
          playlistTitle = (newPlaylist as any).title;
          seekPlaylistListTo = (newPlaylist as any).sortOrder;
        }

        return await handlePlaylistStreaming({
          videoUrl,
          chunkSize,
          isScheduledUpdate: resolvedIsScheduledUpdate,
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

  async function handlePlaylistStreaming(
    item: {
      videoUrl: string;
      chunkSize: number;
      isScheduledUpdate: boolean;
      playlistTitle: string;
      seekPlaylistListTo: number;
      processKey: string;
      monitoringType: string;
    },
  ): Promise<ListingResult> {
    const {
      videoUrl,
      chunkSize,
      isScheduledUpdate,
      playlistTitle,
      seekPlaylistListTo,
      processKey,
      monitoringType,
    } = item;

    let processedChunks = 0;

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
          return await handlePlaylistViaApi({
            ...item,
            playlistId,
          });
        } catch (apiError) {
          logger.warn(
            "YouTube API failed, falling back to yt-dlp",
            { url: videoUrl, error: (apiError as Error).message },
          );
        }
      }
    }

    if (monitoringType === "Full" || monitoringType === "Refresh") {
      const deletedCount = await PlaylistVideoMapping.destroy({
        where: { playlistUrl: videoUrl },
      });
      logger.info(
        `Cleared ${deletedCount} existing mapping(s) before ${monitoringType} re-index`,
        { url: videoUrl },
      );
    }

    let startIndex = 1;
    if (monitoringType === "End") {
      const lastVideo = await PlaylistVideoMapping.findOne({
        where: { playlistUrl: videoUrl },
        order: [["positionInPlaylist", "DESC"]],
        attributes: ["positionInPlaylist"],
      });

      const maxPosition = lastVideo
        ? lastVideo.getDataValue("positionInPlaylist")
        : 0;
      if (maxPosition > 0) {
        startIndex = Math.max(1, maxPosition - chunkSize + 1);
      }
    }

    let chunkItems: string[] = [];
    let absoluteIndexCount = startIndex - 1;
    let consecutiveDuplicateChunks = 0;
    let processSucceeded = false;
    let error: Error | undefined;
    let ytDlpProcess: ManagedProcess;

    try {
      const streamProcessor = streamPlayListItems(videoUrl, processKey, startIndex);
      ytDlpProcess = streamProcessor.process;

      for await (const line of streamProcessor.iterator) {
        absoluteIndexCount++;
        chunkItems.push(line);

        if (chunkItems.length >= chunkSize) {
          const result = await processStreamingVideoInformation(
            chunkItems,
            videoUrl,
            absoluteIndexCount - chunkSize + 1,
            isScheduledUpdate,
            monitoringType,
          );

          processedChunks++;
          chunkItems = [];
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

          if (
            result.alreadyExistedCount === chunkSize && monitoringType === "Start"
          ) {
            consecutiveDuplicateChunks++;
            if (consecutiveDuplicateChunks >= 2) {
              ytDlpProcess.kill("SIGTERM");
              break;
            }
          } else {
            consecutiveDuplicateChunks = 0;
          }
        }
      }

      if (chunkItems.length > 0) {
        await processStreamingVideoInformation(
          chunkItems,
          videoUrl,
          absoluteIndexCount - chunkItems.length + 1,
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
      } else if (processedChunks === 0) {
        if (monitoringType === "End" && startIndex > 1) {
          throw new Error(
            "End mode index returned empty due to likely deletions.",
          );
        } else {
          return handleEmptyResponse(videoUrl);
        }
      }
      processSucceeded = true;
    } catch (e) {
      error = e as Error;
    }

    if (
      !processSucceeded && error &&
      error.message !== "Process exited with code null" &&
      error.message !== "Process exited with code 143"
    ) {
      return handleListingError(error, videoUrl, "playlist");
    }

    return completePlaylistListing(
      videoUrl,
      processedChunks,
      playlistTitle,
      seekPlaylistListTo,
      isScheduledUpdate,
    );
  }

  async function handlePlaylistViaApi(
    item: {
      videoUrl: string;
      chunkSize: number;
      isScheduledUpdate: boolean;
      playlistTitle: string;
      seekPlaylistListTo: number;
      processKey: string;
      monitoringType: string;
      playlistId: string;
    },
  ): Promise<ListingResult> {
    const {
      videoUrl,
      chunkSize,
      isScheduledUpdate,
      playlistTitle,
      seekPlaylistListTo,
      processKey,
      monitoringType,
      playlistId,
    } = item;

    let processedChunks = 0;

    logger.info("Starting YouTube API listing for playlist", {
      url: videoUrl,
      playlistId,
    });

    // For Full/Refresh modes, clear existing mappings before re-indexing
    if (monitoringType === "Full" || monitoringType === "Refresh") {
      const deletedCount = await PlaylistVideoMapping.destroy({
        where: { playlistUrl: videoUrl },
      });
      logger.info(
        `Cleared ${deletedCount} existing mapping(s) before ${monitoringType} re-index (API path)`,
        { url: videoUrl },
      );
    }

    // Update process status to "running" for the cleanup job
    const processEntry = listProcesses.get(processKey);
    if (processEntry) {
      processEntry.status = "running";
      processEntry.lastActivity = Date.now();
      processEntry.lastStdoutActivity = Date.now();
      listProcesses.set(processKey, processEntry);
    }

    try {
      let hasItems = false;
      let consecutiveDuplicateChunks = 0;

      // Stream chunks progressively from the YouTube API
      for await (
        const { items: chunkItems, chunkStartIndex, totalExpected }
          of fetchPlaylistItemsChunked(playlistId, chunkSize)
      ) {
        hasItems = true;

        const result = await processStreamingVideoInformation(
          chunkItems,
          videoUrl,
          chunkStartIndex,
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

        // Early termination for "Start" mode if all items already exist
        if (
          result.alreadyExistedCount === chunkItems.length &&
          monitoringType === "Start"
        ) {
          consecutiveDuplicateChunks++;
          if (consecutiveDuplicateChunks >= 2) {
            logger.info(
              "YouTube API path: 2 consecutive duplicate chunks, stopping early",
              { url: videoUrl, processedChunks },
            );
            break;
          }
        } else {
          consecutiveDuplicateChunks = 0;
        }

        // Log progress every 10 chunks
        if (processedChunks % 10 === 0) {
          logger.info("YouTube API processing progress", {
            url: videoUrl,
            processedChunks,
            totalExpected,
          });
        }
      }

      if (!hasItems) {
        return handleEmptyResponse(videoUrl);
      }

      // Mark process as completed
      if (processEntry) {
        processEntry.status = "completed";
        processEntry.lastActivity = Date.now();
        listProcesses.set(processKey, processEntry);
      }

      return completePlaylistListing(
        videoUrl,
        processedChunks,
        playlistTitle,
        seekPlaylistListTo,
        isScheduledUpdate,
      );
    } catch (error) {
      logger.error("YouTube API listing failed", {
        url: videoUrl,
        playlistId,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      // Mark process as failed
      if (processEntry) {
        processEntry.status = "failed";
        processEntry.lastActivity = Date.now();
        listProcesses.set(processKey, processEntry);
      }

      throw error; // Re-throw so the caller can fall back to yt-dlp
    }
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
            ? (JSON.parse(chunkItems[0]).webpage_url ||
              JSON.parse(chunkItems[0]).url || "")
            : "",
          playlistUrl,
        },
      });

      let newStartIndex: number;
      if (existingMapping) {
        newStartIndex = existingMapping.getDataValue("positionInPlaylist") as number;
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

    const processArgs = [
      "--playlist-start",
      startIndex.toString(),
      "--dump-json",
      "--no-download",
      videoUrl,
    ];

    const siteArgs = buildSiteArgs(videoUrl, config);
    if (siteArgs.length > 0) {
      processArgs.unshift(...siteArgs);
    }

    const fullCommandString = [
      "yt-dlp",
      ...processArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)),
    ].join(" ");

    logger.debug(`Starting streaming listing for ${videoUrl}`, {
      url: videoUrl,
      fullCommand: fullCommandString,
    });

    const listProcess = spawnPythonProcess(processArgs);
    const processEntry = listProcesses.get(processKey);

    if (processEntry) {
      const now = Date.now();
      processEntry.spawnedProcess = listProcess;
      processEntry.status = "running";
      processEntry.spawnTimeStamp = now;
      processEntry.lastActivity = now;
      processEntry.lastStdoutActivity = now;
      listProcesses.set(processKey, processEntry);
    } else {
      throw new Error(`Process entry not found: ${processKey}`);
    }

    void (async () => {
      for await (const data of streamTextChunks(listProcess.stderr)) {
        logger.error("List process error", {
          error: data,
          pid: listProcess.pid,
        });
        updateProcessActivity(processKey);
      }
    })();

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

        const exitCode = listProcess.killed ? null : (await listProcess.status).code;
        const isAllowedError = exitCode === 1 && linesYielded > 0;

        if (!listProcess.killed && exitCode !== 0 && !isAllowedError) {
          const processEntryInt = listProcesses.get(processKey);
          if (processEntryInt) {
            processEntryInt.status = "failed";
            processEntryInt.lastActivity = Date.now();
            listProcesses.set(processKey, processEntryInt);
          }
          throw new Error(`Process exited with code ${exitCode}`);
        } else {
          const processEntryInt = listProcesses.get(processKey);
          if (processEntryInt) {
            processEntryInt.status = "completed";
            processEntryInt.lastActivity = Date.now();
            listProcesses.set(processKey, processEntryInt);
          }
        }
      } catch (error) {
        const processEntryInt = listProcesses.get(processKey);
        if (processEntryInt) {
          processEntryInt.status = "errored";
          processEntryInt.lastActivity = Date.now();
          listProcesses.set(processKey, processEntryInt);
        }
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
          const videoUrl = itemData.webpage_url || itemData.url || "";
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
      const existingMapping = existingMappingsMap.get(`${videoUrl}|${absoluteIndex}`);

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
        approximateSize: approxSize === "NA" ? -1 : parseInt(String(approxSize)),
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
        deduplicatedVideos as unknown as Array<Record<string, unknown>>,
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
        mappingsToCreate as unknown as Array<Record<string, unknown>>,
      );
    }

    if (mappingsToUpdate.length > 0) {
      await Promise.all(
        mappingsToUpdate.map((m) =>
          m.instance.update({ positionInPlaylist: m.position })
        ),
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

  function handleListingError(error: Error, videoUrl: string, itemType: string) {
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
    isScheduledUpdate: boolean,
  ) {
    logger.info("Playlist listing completed", {
      url: videoUrl,
      processedChunks,
      playlistTitle,
      seekPlaylistListTo,
    });

    if (!isScheduledUpdate) {
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

  async function addPlaylist(playlistUrl: string, monitoringType: string) {
    let playlistTitle = "";
    if (pendingPlaylistSortCounter === null) {
      if (pendingPlaylistSortCounterPromise === null) {
        pendingPlaylistSortCounterPromise = PlaylistMetadata.findOne({
          order: [["sortOrder", "DESC"]],
          attributes: ["sortOrder"],
          limit: 1,
        }).then((lastPlaylist: Model | null) => {
          const initialValue = lastPlaylist !== null
            ? (lastPlaylist as any).sortOrder + 1
            : 0;
          pendingPlaylistSortCounter = initialValue;
          return initialValue;
        });
      }
      await pendingPlaylistSortCounterPromise;
    }
    const nextPlaylistIndex = pendingPlaylistSortCounter!++;

    const processArgs = [
      "--playlist-end",
      "1",
      "--dump-json",
      "--no-download",
      playlistUrl,
    ];

    const siteArgs = buildSiteArgs(playlistUrl, config);
    if (siteArgs.length > 0) {
      processArgs.unshift(...siteArgs);
    }

    const titleProcess = spawnPythonProcess(processArgs);

    logger.debug("Trying to get playlist title", {
      url: playlistUrl,
      fullCommand: [
        "yt-dlp",
        ...processArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)),
      ].join(" "),
    });

    return new Promise((resolve, reject) => {
      void (async () => {
        for await (const data of streamTextChunks(titleProcess.stdout)) {
          playlistTitle += data;
        }
      })();

      void (async () => {
        for await (const data of streamTextChunks(titleProcess.stderr)) {
          logger.error(`Error getting playlist title: ${data}`);
        }
      })();

      void (async () => {
        const { code } = await titleProcess.status;
        try {
          if (code !== 0) {
            throw new Error("Failed to get playlist title");
          }

          try {
            const jsonData = JSON.parse(playlistTitle.toString().trim());
            if (jsonData) {
              playlistTitle = jsonData.playlist_title || jsonData.title ||
                playlistTitle;
            }
          } catch (e) {
            logger.error("Failed to parse playlist title JSON", {
              playlistTitle,
              error: e as Error,
            });
          }

          if (!playlistTitle || playlistTitle.toString().trim() === "NA") {
            playlistTitle = urlToTitle(playlistUrl);
          }

          playlistTitle = truncateText(playlistTitle, config.maxTitleLength);

          logger.debug(`Creating playlist with title: ${playlistTitle}`, {
            url: playlistUrl,
            pid: titleProcess.pid,
            code: code,
            monitoringType: monitoringType,
            lastUpdatedByScheduler: Date.now(),
          });

          const [playlist, created] = await PlaylistMetadata.findOrCreate({
            where: { playlistUrl: playlistUrl },
            defaults: {
              title: playlistTitle.trim(),
              monitoringType: monitoringType,
              saveDirectory: playlistTitle.trim(),
              sortOrder: nextPlaylistIndex,
              lastUpdatedByScheduler: Date.now(),
            },
          });

          if (!created) {
            logger.warn("Playlist already exists", { url: playlistUrl });
          }

          resolve(playlist);
        } catch (error) {
          logger.error("Failed to create playlist", {
            url: playlistUrl,
            error: (error as Error).message,
          });
          reject(error);
        }
      })().catch(reject);
    });
  }

  function resetPendingPlaylistSortCounter() {
    pendingPlaylistSortCounter = null;
    pendingPlaylistSortCounterPromise = null;
  }


  return { processListingRequest, listItemsConcurrently, resetPendingPlaylistSortCounter };
}
