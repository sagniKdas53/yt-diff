// deno-lint-ignore-file no-explicit-any
import { Op } from "sequelize";
import { Model } from "sequelize";
import { config } from "../../config.ts";
import {
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import { hasEphemeralThumbnails, normalizeUrl } from "../../utils/url.ts";
import { truncateText } from "./process-manager.ts";
import type {
  ParsedStreamItem,
  PlaylistMappingCreate,
  PlaylistMappingUpdate,
  StreamedItemData,
  StreamingVideoProcessingResult,
  VideoUpsertData,
} from "./types.ts";

/**
 * The three writes one ingested chunk produces, committed together.
 *
 * They used to run unwrapped, back to back: a failure between them left videos
 * upserted with their mappings missing, or positions half-shifted. This runs
 * once per chunk, per playlist, on every scheduled update, so "rare" was doing
 * a lot of work in that sentence.
 *
 * The renumber also used to be a hand-built
 * `SET "positionInPlaylist" = CASE WHEN "id" = '<uuid>' THEN <n> … END` — the
 * one place in the pipeline that left the ORM. Every row in `mappingsToUpdate`
 * already exists, so an upsert keyed on the primary key lands on the
 * `DO UPDATE` branch for all of them; the untouched columns are carried
 * through so the insert half of the statement stays well-formed.
 */
export async function persistStreamingChunk(
  writes: {
    videosToUpsert: VideoUpsertData[];
    mappingsToCreate: PlaylistMappingCreate[];
    mappingsToUpdate: PlaylistMappingUpdate[];
  },
): Promise<void> {
  const { videosToUpsert, mappingsToCreate, mappingsToUpdate } = writes;

  if (
    videosToUpsert.length === 0 && mappingsToCreate.length === 0 &&
    mappingsToUpdate.length === 0
  ) {
    return;
  }

  await sequelize.transaction(async (transaction) => {
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
          transaction,
        },
      );
    }

    if (mappingsToCreate.length > 0) {
      await PlaylistVideoMapping.bulkCreate(
        mappingsToCreate as any,
        { transaction },
      );
    }

    if (mappingsToUpdate.length > 0) {
      await PlaylistVideoMapping.bulkCreate(
        mappingsToUpdate.map((m) => ({
          id: m.instance.getDataValue("id"),
          videoUrl: m.instance.getDataValue("videoUrl"),
          playlistUrl: m.instance.getDataValue("playlistUrl"),
          positionInPlaylist: m.position,
          createdAt: m.instance.getDataValue("createdAt"),
          updatedAt: new Date(),
        })) as any,
        {
          updateOnDuplicate: ["positionInPlaylist", "updatedAt"],
          conflictAttributes: ["id"],
          transaction,
        },
      );
    }
  });
}

/**
 * Turns one chunk of yt-dlp JSON lines into database rows.
 *
 * Parse, diff against what is already on record, and hand the writes to
 * `persistStreamingChunk`. The diff decides, per item, whether an existing
 * mapping merely moved (update), is genuinely new (create), or — outside any
 * playlist, where duplicates are not allowed — drifted to another position
 * (move). Inside a real playlist duplicates are allowed: YouTube permits the
 * same video at several positions, so each occurrence gets its own mapping.
 */
export async function processStreamingVideoInformation(
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

  await persistStreamingChunk({
    videosToUpsert,
    mappingsToCreate,
    mappingsToUpdate,
  });

  return result;
}
