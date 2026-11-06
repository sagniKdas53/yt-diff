import { Op, type Order, type WhereOptions } from "sequelize";
import { VideoMetadata } from "../../db/models.ts";

/**
 * The one definition of how `/getsub` orders a list, shared with `/locate`,
 * which counts pages against it. Keeping both here is what stops the two
 * disagreeing about which page a row is on.
 *
 * A real playlist runs in position order. Unlisted runs the other way,
 * newest first: its positions are real (Phase 0a found them never
 * contradicting `createdAt`), and a few tie, so the mapping `id` breaks the
 * tie in the same direction. The attribute is unqualified because Sequelize
 * treats a Model in `order` as an association, not as the main model.
 */
function isNewestFirst(playlistUrl: string): boolean {
  return playlistUrl === "None";
}

export function listOrder(
  playlistUrl: string,
  sortDownloaded: boolean,
): Order {
  const direction = isNewestFirst(playlistUrl) ? "DESC" : "ASC";
  const byPosition: Order = [["positionInPlaylist", direction], [
    "id",
    direction,
  ]];
  return sortDownloaded
    ? [[VideoMetadata, "downloadStatus", "DESC"], ...byPosition]
    : byPosition;
}

/**
 * The mappings that sort strictly before one mapping under `listOrder`.
 * Counting only strictly-earlier positions would treat a tied group as equal,
 * so a target on a page boundary could land on a different page than the one
 * `/getsub` returns it on.
 */
export function rowsBefore(
  playlistUrl: string,
  position: number,
  mappingId: string,
): WhereOptions {
  const before = isNewestFirst(playlistUrl) ? Op.gt : Op.lt;
  return {
    playlistUrl,
    [Op.or]: [
      { positionInPlaylist: { [before]: position } },
      { positionInPlaylist: position, id: { [before]: mappingId } },
    ],
  };
}
