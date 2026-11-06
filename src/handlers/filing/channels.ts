import { literal, Op, type Order, QueryTypes } from "sequelize";
import { config } from "../../config.ts";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoFiling,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";
import type { HttpResponseLike } from "../../transport/http.ts";
import { json } from "../../utils/http.ts";
import { normalizeUrl } from "../../utils/url.ts";
import { withPlaylistCreateLock } from "../pipeline/playlist-records.ts";
import type { PlaylistHandlerDependencies } from "../playlists/types.ts";
import { AUTO_PREFIX } from "./rules.ts";

// ---------------------------------------------------------------------------
// /getplay by kind
// ---------------------------------------------------------------------------

export type PlaylistKind = "playlist" | "channel";

/**
 * Which playlist rows a list shows.
 *
 * No kind is the old behaviour: every row that holds a place in the list.
 * Channels are listed at any sortOrder, because the filing job's channels sit
 * at -1 to stay out of Reindex all and the Playlists list.
 */
export function playlistKindWhere(kind: PlaylistKind | undefined) {
  if (kind === "channel") {
    return {
      kind: "channel",
      playlistUrl: { [Op.notIn]: ["None", "init"] },
    };
  }
  if (kind === "playlist") {
    return { kind: "playlist", sortOrder: { [Op.gte]: 0 } };
  }
  return { sortOrder: { [Op.gte]: 0 } };
}

/**
 * The URL a channel row would be monitored by: the most common channel URL
 * among its videos, which is what Monitor channel renames the key to. SQL
 * text so the list and the promotion agree on one answer.
 */
const channelUrlOf = (playlistUrl: string) =>
  `(SELECT v."channelUrl" FROM playlist_video_mappings cm
     JOIN video_metadata v ON v."videoUrl" = cm."videoUrl"
     WHERE cm."playlistUrl" = ${playlistUrl} AND v."channelUrl" IS NOT NULL
     GROUP BY v."channelUrl" ORDER BY COUNT(*) DESC, v."channelUrl" LIMIT 1)`;

const SELF = `"playlist_metadata"."playlistUrl"`;

/**
 * Extra columns on every /getplay row. Counts are cast, because Postgres
 * returns bigint as a string and the response says number. "Activity" is the
 * newest video row, not the newest mapping: every filed mapping carries the
 * sweep's timestamp, and counting it would put every channel at "just now".
 * There is no limit-with-join here, so the table alias holds.
 */
export const PLAYLIST_LIST_COLUMNS: Array<
  [ReturnType<typeof literal>, string]
> = [
  [
    literal(
      `(SELECT COUNT(*)::int FROM playlist_video_mappings cm WHERE cm."playlistUrl" = ${SELF})`,
    ),
    "videoCount",
  ],
  [
    literal(
      `(SELECT MAX(v."createdAt") FROM playlist_video_mappings cm
          JOIN video_metadata v ON v."videoUrl" = cm."videoUrl"
          WHERE cm."playlistUrl" = ${SELF})`,
    ),
    "latestAddedAt",
  ],
  [
    literal(
      `CASE WHEN "playlist_metadata"."kind" <> 'channel' THEN NULL
              WHEN ${SELF} LIKE '${AUTO_PREFIX}%' THEN ${channelUrlOf(SELF)}
              ELSE ${SELF} END`,
    ),
    "channelUrl",
  ],
];

/** Channels come newest activity first, unless the caller asked for a sort. */
export const CHANNEL_ACTIVITY_ORDER: Order = [
  [literal(`"latestAddedAt"`), "DESC NULLS LAST"],
  ["playlistUrl", "ASC"],
];

// ---------------------------------------------------------------------------
// Monitor channel
// ---------------------------------------------------------------------------

export interface ChannelRow {
  playlistUrl: string;
  origin: "user" | "auto";
  /** The most common channel URL among its videos, if any has one. */
  channelUrl: string | null;
}

export interface ChannelStore {
  find(playlistUrl: string): Promise<ChannelRow | null>;
  /**
   * Turns an auto channel into the playlist at `channelUrl`. Renames it, or
   * folds it into one that already has that URL. Atomic, and run inside the
   * playlist create lock.
   */
  promote(autoUrl: string, channelUrl: string): Promise<{ merged: boolean }>;
}

export function createDbChannelStore(): ChannelStore {
  return {
    async find(playlistUrl) {
      const [row] = await sequelize.query<ChannelRow>(
        `SELECT p."playlistUrl", p."origin",
                ${channelUrlOf(`p."playlistUrl"`)} AS "channelUrl"
         FROM playlist_metadata p WHERE p."playlistUrl" = :playlistUrl`,
        { replacements: { playlistUrl }, type: QueryTypes.SELECT },
      );
      return row ?? null;
    },

    // The whole promotion is one transaction inside the create lock, released
    // only after the commit. The sortOrder it hands out is read under that
    // lock, so a playlist being created at the same moment can't read the same
    // MAX. The rename leans on ON UPDATE CASCADE for the mappings and the
    // filing rows; if a database were missing it, the transaction would fail
    // whole instead of leaving a half-renamed channel.
    promote(autoUrl, channelUrl) {
      return withPlaylistCreateLock(() =>
        sequelize.transaction(async (transaction) => {
          const target = await PlaylistMetadata.findByPk(channelUrl, {
            transaction,
          });

          if (target) {
            // Children move first, and the auto row goes last. Deleting it
            // first would null every filing row (ON DELETE SET NULL) and
            // cascade away its mappings, and the next sweep would read each
            // as "you removed it" and lock the video into Archive.
            await sequelize.query(
              `DELETE FROM playlist_video_mappings a
               WHERE a."playlistUrl" = :autoUrl AND EXISTS (
                 SELECT 1 FROM playlist_video_mappings t
                 WHERE t."playlistUrl" = :channelUrl
                   AND t."videoUrl" = a."videoUrl")`,
              { replacements: { autoUrl, channelUrl }, transaction },
            );
            await PlaylistVideoMapping.update(
              { playlistUrl: channelUrl },
              { where: { playlistUrl: autoUrl }, transaction },
            );
            await VideoFiling.update(
              { playlistUrl: channelUrl },
              { where: { playlistUrl: autoUrl }, transaction },
            );
            await PlaylistMetadata.destroy({
              where: { playlistUrl: autoUrl, origin: "auto" },
              transaction,
            });
            return { merged: true };
          }

          const last = await PlaylistMetadata.findOne({
            order: [["sortOrder", "DESC"]],
            attributes: ["sortOrder"],
            transaction,
          });
          // monitoringType stays "N/A" on purpose: the listing that follows
          // sets it, and a row already holding the requested type makes that
          // listing return early without indexing anything.
          await PlaylistMetadata.update(
            {
              playlistUrl: channelUrl,
              origin: "user",
              sortOrder: last !== null ? last.sortOrder + 1 : 0,
            },
            { where: { playlistUrl: autoUrl }, transaction },
          );
          return { merged: false };
        })
      );
    },
  };
}

/** A usable channel URL, in the form a listing request would key it by. */
function normalizedChannelUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return normalizeUrl(raw);
}

export function createChannelHandlers(
  deps: PlaylistHandlerDependencies,
  store: ChannelStore = createDbChannelStore(),
) {
  async function processMonitorChannelRequest(
    requestBody: { playlistUrl: string; monitoringType: string },
    response: HttpResponseLike,
  ): Promise<void> {
    try {
      const { playlistUrl, monitoringType } = requestBody;

      const row = await store.find(playlistUrl);
      if (!row) {
        json(response, 404, { error: "Channel not found" });
        return;
      }
      if (row.origin !== "auto") {
        json(response, 400, { error: "That channel is already monitorable" });
        return;
      }

      // The URL comes from scraped metadata, so it is checked before it
      // becomes a key.
      const channelUrl = row.channelUrl === null
        ? null
        : normalizedChannelUrl(row.channelUrl);
      if (channelUrl === null) {
        json(response, 400, {
          error: "No usable channel URL is stored for this channel",
        });
        return;
      }

      const { merged } = await store.promote(playlistUrl, channelUrl);
      logger.info("Promoted an auto channel", {
        from: playlistUrl,
        to: channelUrl,
        merged,
      });

      // Through the normal listing path, not awaited: a channel can take
      // minutes. A rejection here must not escape, or it takes the process
      // down.
      void deps.listItemsConcurrently(
        [{
          url: channelUrl,
          type: "playlist",
          currentMonitoringType: monitoringType,
          reason: "Monitor channel",
        }],
        config.chunkSize,
        false,
      ).catch((error: Error) => {
        logger.error("Listing after Monitor channel failed", {
          url: channelUrl,
          error: error.message,
        });
      });

      json(response, 200, { playlistUrl: channelUrl });
    } catch (error) {
      logger.error("Monitor channel failed", {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      json(response, 500, {
        error: "Could not start monitoring that channel.",
      });
    }
  }

  return { processMonitorChannelRequest };
}
