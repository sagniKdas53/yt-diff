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
 * Where this item sits in the playlist, in the source's own numbering.
 *
 * Counting emitted lines is only correct when the source emits every item, and
 * it does not: yt-dlp skips whatever it cannot extract — private, deleted,
 * age-gated — and says so on stderr while stdout simply carries on. Every item
 * after a skipped one then lands one position short, and the shortfall
 * accumulates.
 *
 * Observed on `iwara.tv/profile/muta81/videos` on 2026-09-04: five private
 * uploads at the top, so the sixth video was stored at position 1, and by the
 * eighth chunk the offset had grown to 38. Re-listing renumbered the whole
 * playlist every time an upload became visible, and `resolveStartIndex` fed
 * those emission-order numbers to `--playlist-start`, which reads them as
 * source positions — two different coordinate systems, one variable.
 *
 * `playlist_index` is what the source says, so it is what gets stored. The
 * counting expression remains for anything that does not report one: the
 * single-video path, and the pseudo-playlist that has no positions to speak of.
 */
function positionOf(
  itemData: StreamedItemData,
  chunkStartIndex: number,
  index: number,
): number {
  const reported = itemData.playlist_index;
  return typeof reported === "number" && Number.isFinite(reported) &&
      reported > 0
    ? reported
    : chunkStartIndex + index;
}

/**
 * Turns one chunk of yt-dlp JSON lines into database rows.
 *
 * Parse, diff against what is already on record, and hand the writes to
 * `persistStreamingChunk`. Per item, one unconsumed mapping row for the same
 * video URL is consumed: an exact-position row is fast-skipped, a row at
 * another position is moved to the observed one (and reported in
 * `result.moves` so the caller can tell a shift from genuinely new videos),
 * and an occurrence with no row left creates a new mapping. That last case
 * covers both new videos and legitimate duplicates — YouTube permits the same
 * video at several positions, so the second occurrence in a chunk finds an
 * empty queue and gets its own mapping. Outside any playlist ("None"), where
 * duplicates are not allowed, the single queued row is always reused.
 */
export async function processStreamingVideoInformation(
  responseItems: string[],
  playlistUrl: string,
  chunkStartIndex: number,
  isUpdate: boolean,
  monitoringType?: string,
  consumedMappings: Set<string> = new Set(),
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
    moves: [],
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
  // One queue of unconsumed mapping rows per video URL.
  //
  // The old code keyed rows by `videoUrl|positionInPlaylist` and, for real
  // playlists, created a fresh mapping whenever the position differed — so a
  // prepend that shifted every index down duplicated the whole playlist, and
  // the `Start` early-exit (which counts fully-known chunks) never fired.
  // Consuming one queued row per observed occurrence instead turns a shift
  // into a position update, while a second occurrence with an empty queue
  // still creates the extra row that legitimate YouTube duplicates need.
  // Rows are queued in ascending position order so a chunk containing the
  // same URL twice deterministically consumes the earliest row first.
  const availableMappingsByUrl = new Map<string, Model[]>(
    (() => {
      const grouped = new Map<string, Model[]>();
      const ordered = existingMappings
        .filter((mapping) => {
          const id = mapping.getDataValue("id") as string;
          const videoUrl = mapping.getDataValue("videoUrl") as string;
          const position = mapping.getDataValue("positionInPlaylist") as number;
          return !consumedMappings.has(`id:${id}`) &&
            !consumedMappings.has(`position:${videoUrl}|${position}`);
        })
        .sort((left, right) =>
          (left.getDataValue("positionInPlaylist") as number) -
          (right.getDataValue("positionInPlaylist") as number)
        );
      for (const mapping of ordered) {
        const videoUrl = mapping.getDataValue("videoUrl") as string;
        const queue = grouped.get(videoUrl);
        if (queue) {
          queue.push(mapping);
        } else {
          grouped.set(videoUrl, [mapping]);
        }
      }
      return grouped;
    })(),
  );

  /** Removes and returns the queued row at exactly `position`, if any. */
  function takeMappingAt(videoUrl: string, position: number): Model | null {
    const queue = availableMappingsByUrl.get(videoUrl);
    if (!queue) return null;
    const index = queue.findIndex(
      (mapping) =>
        (mapping.getDataValue("positionInPlaylist") as number) === position,
    );
    if (index === -1) return null;
    const [mapping] = queue.splice(index, 1);
    if (queue.length === 0) availableMappingsByUrl.delete(videoUrl);
    return mapping ?? null;
  }

  /** Removes and returns the earliest queued row for `videoUrl`, if any. */
  function takeEarliestMapping(videoUrl: string): Model | null {
    const queue = availableMappingsByUrl.get(videoUrl);
    if (!queue || queue.length === 0) return null;
    const mapping = queue.shift() as Model;
    if (queue.length === 0) availableMappingsByUrl.delete(videoUrl);
    return mapping;
  }

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
      : positionOf(itemData, chunkStartIndex, index);

    // An exact queued row means this occurrence is already on record where
    // the source says it is: fast-skip it (except under Refresh, which
    // deliberately re-evaluates everything).
    const exactMapping = takeMappingAt(videoUrl, absoluteIndex);
    if (exactMapping) {
      consumedMappings.add(`id:${exactMapping.getDataValue("id") as string}`);
    }
    if (
      monitoringType !== "Refresh" &&
      existingVideo && exactMapping
    ) {
      result.alreadyExistedCount++;
      result.count++;
      result.title = existingVideo.getDataValue("title");
      continue;
    }
    // A Refresh run that landed on its exact row still consumes it (so a
    // duplicate occurrence behind it is not mistaken for the same row), but
    // falls through to refresh the metadata below.
    const movedMapping = exactMapping ?? takeEarliestMapping(videoUrl);
    if (movedMapping) {
      consumedMappings.add(`id:${movedMapping.getDataValue("id") as string}`);
      const oldPosition = movedMapping.getDataValue(
        "positionInPlaylist",
      ) as number;
      if (oldPosition !== absoluteIndex) {
        mappingsToUpdate.push({
          instance: movedMapping,
          position: absoluteIndex,
        });
        result.moves.push({
          videoUrl,
          mappingId: movedMapping.getDataValue("id") as string,
          oldPosition,
          newPosition: absoluteIndex,
        });
      }
      // A moved-but-known video is still a known video for the caller's
      // early-exit accounting: without this, a prepended-to playlist never
      // produces a fully-known chunk and the walk duplicates everything.
      if (monitoringType !== "Refresh" && existingVideo) {
        result.alreadyExistedCount++;
      }
    } else {
      // No unconsumed row for this URL in this playlist: this occurrence is
      // genuinely new. In real playlists that includes the legitimate second
      // occurrence of a duplicated video (the first consumed the only queued
      // row); in "None" it is a first-time add.
      mappingsToCreate.push({
        videoUrl: videoUrl,
        playlistUrl: playlistUrl,
        positionInPlaylist: absoluteIndex,
      });
      // The inserted row has no id until the database write completes. Its
      // source position is stable, so reserve that occurrence for subsequent
      // chunks in this listing and prevent it from being reused as a move.
      consumedMappings.add(`position:${videoUrl}|${absoluteIndex}`);
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
