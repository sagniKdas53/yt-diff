import { Op } from "sequelize";
import { PlaylistMetadata, PlaylistVideoMapping } from "../../db/models.ts";
import { MONITORED_TYPES } from "./types.ts";

/**
 * Playlists that exist for bookkeeping rather than as somewhere a file lives:
 * "None" holds videos nobody filed anywhere else, "init" is the first listing
 * pass's bucket. A file never belongs to either.
 */
const PSEUDO_PLAYLISTS = ["init", "None"];

export interface VideoPlaylistLocation {
  playlistUrl: string;
  saveDirectory: string;
}

/**
 * The real playlist a video belongs to, and the folder its files live in.
 *
 * One answer, deliberately: `resolveAndEnqueue` picks the folder a download
 * writes into and `/locate` reports the playlist a player link should open,
 * and a link that opened a different playlist than the file landed in would be
 * worse than no link at all. This used to be an unordered `findOne`, so a
 * video in three playlists landed in whichever row Postgres returned first —
 * and could land in a different folder on the next run of the same download.
 *
 * A monitored playlist wins over an unmonitored one, then the oldest mapping.
 * Oldest, because the earliest mapping is the playlist the video was filed
 * into first, which is the one a user means when they name it.
 */
export async function resolveVideoPlaylist(
  videoUrl: string,
): Promise<VideoPlaylistLocation | null> {
  const realPlaylist = { [Op.notIn]: PSEUDO_PLAYLISTS } as const;

  const monitored = await PlaylistVideoMapping.findOne({
    attributes: ["playlistUrl", "createdAt"],
    where: { videoUrl, playlistUrl: realPlaylist },
    include: [{
      model: PlaylistMetadata,
      required: true,
      attributes: ["playlistUrl"],
      where: { monitoringType: { [Op.in]: MONITORED_TYPES } },
    }],
    order: [["createdAt", "ASC"]],
  });

  const mapping = monitored ?? await PlaylistVideoMapping.findOne({
    attributes: ["playlistUrl", "createdAt"],
    where: { videoUrl, playlistUrl: realPlaylist },
    order: [["createdAt", "ASC"]],
  });

  if (!mapping) {
    return null;
  }

  const playlist = await PlaylistMetadata.findOne({
    where: { playlistUrl: mapping.playlistUrl },
  });

  return {
    playlistUrl: mapping.playlistUrl,
    saveDirectory: playlist?.saveDirectory ?? "",
  };
}
