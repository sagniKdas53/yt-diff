import he from "he";
import { Op } from "sequelize";
import type { Model } from "sequelize";
import { config } from "../../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { json } from "../../utils/http.ts";
import { normalizeUrl } from "../../utils/url.ts";
import { join } from "../../utils/path.ts";
import type { ListingItem, ListingRequestBody } from "./types.ts";

/**
 * Where a video's downloaded files live, if it has any.
 *
 * Reads a raw model row rather than an instance of a typed class because the
 * ingest path upserts through `bulkCreate`, whose results come back as plain
 * models — the same shape the request path reads here.
 */
export function buildDownloadLocation(videoEntry: Model): string | null {
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

/** The best label available for a video row, for messages and logs. */
export function getVideoDisplayLabel(videoEntry: Model): string {
  const title = videoEntry.getDataValue("title") as string | null;
  const videoUrl = videoEntry.getDataValue("videoUrl") as string | null;
  const videoId = videoEntry.getDataValue("videoId") as string | null;
  return title || videoUrl || videoId || "video";
}

export interface PlaylistMention {
  playlistUrl: string;
  title: string;
  positionInPlaylist: number;
  sortOrder: number;
}

/**
 * Every real playlist that already contains this video, ordered the way the
 * UI lists playlists — by sort order, then position, then title.
 */
export async function getExistingPlaylistMentions(
  videoUrl: string,
): Promise<PlaylistMention[]> {
  const mappings = await PlaylistVideoMapping.findAll({
    where: {
      videoUrl,
      playlistUrl: { [Op.ne]: "None" },
    },
    attributes: ["playlistUrl", "positionInPlaylist"],
  });

  const playlistUrls = [
    ...new Set(
      mappings.map((mapping) => mapping.getDataValue("playlistUrl") as string),
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
    .map((mapping): PlaylistMention | null => {
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
    .filter((mention): mention is PlaylistMention => mention !== null)
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

/**
 * Fallback identity match for a URL the exact-key lookup missed.
 *
 * Normalization may not have collapsed every duplicate spelling, so this
 * tries the last meaningful path segment (or `?v=`) as a videoId scoped to
 * the same domain core. A hit means the row already exists under its
 * canonical URL, and that URL is what gets used.
 */
async function findVideoByFallbackIdentity(
  normalizedUrl: string,
): Promise<VideoMetadata | null> {
  try {
    const parsedFallback = new URL(normalizedUrl);
    // Build a hostname-scoped LIKE pattern (covers www/non-www/subdomains).
    const domainCore = parsedFallback.hostname
      .replace(/^www\./, "")
      .replace(/^m\./, "");
    const pathParts = parsedFallback.pathname.split("/").filter(Boolean);
    // Use the last meaningful path segment as a candidate videoId.
    const candidateId = pathParts.at(-1) ||
      parsedFallback.searchParams.get("v") || "";
    if (!candidateId || !domainCore) {
      return null;
    }
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
    }
    return byId;
  } catch {
    // Malformed URL, skip fallback silently
    return null;
  }
}

export interface ListingRequestContext {
  safeEmit: (event: string, payload: unknown) => void;
  /** Starts the listing pass; resolves when every item has finished or failed. */
  enqueue: (
    items: ListingItem[],
    chunkSize: number,
    isScheduledUpdate: boolean,
  ) => Promise<unknown>;
  /** True backlog: items holding a slot plus those parked in the FIFO queue. */
  queueDepth: () => number;
}

/**
 * The POST /list handler: decide what each submitted URL already is, then
 * enqueue only what genuinely needs a listing pass.
 *
 * A URL can arrive as three things. A known playlist whose monitoring type
 * changed becomes a playlist item; one with unchanged monitoring is skipped.
 * A known video is answered inline — either it is already in the None
 * pseudo-playlist and the caller is told where, or a mapping is appended and
 * the caller is told that too, both without spawning anything. Anything else
 * is undetermined and goes to yt-dlp.
 */
export async function processListingRequest(
  ctx: ListingRequestContext,
  requestBody: ListingRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  try {
    const { safeEmit } = ctx;
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
        videoEntry = await findVideoByFallbackIdentity(normalizedUrl);
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
    const queueDepthBefore = ctx.queueDepth();

    void ctx.enqueue(itemsToList, chunkSize, false);

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
