import { Op, type WhereOptions } from "sequelize";
import { config } from "../../config.ts";
import { PlaylistVideoMapping, VideoMetadata } from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { json } from "../../utils/http.ts";
import { resolveVideoPlaylist } from "./download-location.ts";

export interface LocateRequestBody {
  videoUrl: string;
  /** The page size the caller is paging `/getsub` with. */
  pageSize?: number;
  /** `/getsub`'s downloaded-first ordering, which pages differently. */
  sortDownloaded?: boolean;
}

/** Where a video should be opened, and which page of that list it is on. */
export interface VideoLocation {
  videoUrl: string;
  /** Null when the video belongs to no real playlist; open it under Unlisted. */
  playlistUrl: string | null;
  page: number | null;
}

/**
 * Finds the list a video should be opened in, and its page within it.
 *
 * The player link the bot sends names a playlist and a video, and the player
 * only opens `v=` when the row is on the page it has loaded — silently
 * dropping it otherwise. That is why the page is part of the answer rather
 * than something the caller works out from a count: the ordering `/getsub`
 * uses is not position order when the list is sorted downloaded-first, and
 * re-deriving it in the caller is how the two drift apart.
 *
 * `playlistUrl` comes from the same helper `resolveAndEnqueue` uses to pick
 * the folder the file was written into, so the link opens the list the
 * download actually landed in.
 */
export async function locateVideo(
  videoUrl: string,
  options: { pageSize?: number; sortDownloaded?: boolean } = {},
): Promise<VideoLocation> {
  const location = await resolveVideoPlaylist(videoUrl);
  const targetPlaylistUrl = location?.playlistUrl ?? "None";

  const mapping = await PlaylistVideoMapping.findOne({
    attributes: ["id", "positionInPlaylist"],
    include: [{
      model: VideoMetadata,
      attributes: ["downloadStatus"],
      required: false,
    }],
    where: { videoUrl, playlistUrl: targetPlaylistUrl },
  });
  if (!mapping) {
    // The video belongs to no list or no row records where it sits, so the
    // page it opens on is unknown. Page 0 would be a claim, not a fact: the
    // player would open the front of the list and quietly drop `v=`.
    return {
      videoUrl,
      playlistUrl: location ? location.playlistUrl : null,
      page: null,
    };
  }
  const mappingId = mapping.id;
  const position = mapping.positionInPlaylist;
  const pageSize = options.pageSize && options.pageSize > 0
    ? Math.floor(options.pageSize)
    : config.chunkSize;

  const index = options.sortDownloaded
    ? await downloadedFirstIndex(
      targetPlaylistUrl,
      mappingId,
      position,
      !!mapping.video_metadatum?.downloadStatus,
    )
    : await PlaylistVideoMapping.count({
      where: beforeMapping(targetPlaylistUrl, position, mappingId),
    });

  return {
    videoUrl,
    playlistUrl: location ? location.playlistUrl : null,
    page: Math.floor(index / pageSize),
  };
}

/**
 * A row's index under `/getsub`'s downloaded-first ordering: every downloaded
 * entry in playlist position order, then every entry not yet downloaded.
 *
 * Counting rather than reading the page is the whole point — a list can hold
 * tens of thousands of entries, and the row is found by how many entries sort
 * ahead of it, not by walking them.
 */
async function downloadedFirstIndex(
  playlistUrl: string,
  mappingId: string,
  position: number,
  isDownloaded: boolean,
): Promise<number> {
  const countDownloaded = (where: WhereOptions) =>
    PlaylistVideoMapping.count({
      where,
      include: [{
        model: VideoMetadata,
        required: true,
        where: { downloadStatus: true },
      }],
    });

  const before = beforeMapping(playlistUrl, position, mappingId);

  if (isDownloaded) {
    return await countDownloaded(before);
  }

  const totalDownloaded = await countDownloaded({ playlistUrl });
  const ahead = await PlaylistVideoMapping.count({ where: before });
  const downloadedAhead = await countDownloaded(before);

  return totalDownloaded + ahead - downloadedAhead;
}

/**
 * The rows that sort strictly before one mapping under `/getsub`'s order.
 *
 * `/getsub` orders by `positionInPlaylist` then `id`, because the `"None"`
 * pseudo-playlist assigns the same position to every unlisted video. Counting
 * only smaller positions would treat such a tied group as entirely equal, so a
 * target on a page boundary could be counted onto a different page than the
 * one `/getsub` actually returns it on.
 */
function beforeMapping(
  playlistUrl: string,
  position: number,
  mappingId: string,
): WhereOptions {
  return {
    playlistUrl,
    [Op.or]: [
      { positionInPlaylist: { [Op.lt]: position } },
      { positionInPlaylist: position, id: { [Op.lt]: mappingId } },
    ],
  };
}

/** The HTTP shape of `locateVideo`. */
export async function processLocateRequest(
  requestBody: LocateRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  try {
    json(
      response,
      200,
      await locateVideo(requestBody.videoUrl, {
        pageSize: requestBody.pageSize,
        sortDownloaded: requestBody.sortDownloaded,
      }),
    );
  } catch (error) {
    logger.error("Locate request failed", {
      videoUrl: requestBody.videoUrl,
      error: (error as Error).message,
    });
    json(response, 500, { error: "Could not locate that video." });
  }
}
