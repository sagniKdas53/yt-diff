import { Op, QueryTypes } from "sequelize";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoFiling,
} from "../../db/models.ts";
import { MONITORED_TYPES } from "../pipeline/types.ts";
import { coreHostname } from "../pipeline/dedup.ts";
import {
  type KnownPlaylist,
  type PlacementKind,
  UNKNOWN_OWNER,
  type UnlistedRow,
} from "./place.ts";
import { AUTO_PREFIX } from "./rules.ts";
import type {
  FilingGroup,
  FilingStore,
  UndoCandidates,
  UndoPlan,
} from "./sweep.ts";

interface UnlistedSqlRow {
  videoUrl: string;
  site: string;
  channelKey: string | null;
  channelName: string | null;
  channelHandle: string | null;
  durationSeconds: number | null;
  addedAt: Date;
  realPlaylistUrl: string | null;
  filedPlacement: PlacementKind | null;
  filedPlaylistUrl: string | null;
  filedLocked: boolean | null;
  hasFiledMapping: boolean;
}

/**
 * One row per Unlisted video that has facets.
 *
 * `realPlaylistUrl` follows `resolveVideoPlaylist`'s rule (monitored first,
 * then the oldest mapping) but skips negative positions: those are the job's
 * own filed mappings, and counting them would make a filed video look like it
 * had always been in a real playlist.
 */
const UNLISTED_SQL = `
  SELECT n."videoUrl", v."site", v."channelKey", v."channelName",
         v."channelHandle", v."durationSeconds", n."addedAt",
         rp."playlistUrl" AS "realPlaylistUrl",
         f."placement" AS "filedPlacement",
         f."playlistUrl" AS "filedPlaylistUrl",
         f."locked" AS "filedLocked",
         (f."playlistUrl" IS NOT NULL AND EXISTS (
            SELECT 1 FROM playlist_video_mappings fm
            WHERE fm."videoUrl" = n."videoUrl"
              AND fm."playlistUrl" = f."playlistUrl")) AS "hasFiledMapping"
  FROM (
    SELECT "videoUrl", MIN("createdAt") AS "addedAt"
    FROM playlist_video_mappings
    WHERE "playlistUrl" = 'None'
    GROUP BY "videoUrl"
  ) n
  JOIN video_metadata v ON v."videoUrl" = n."videoUrl"
  LEFT JOIN video_filing f ON f."videoUrl" = n."videoUrl"
  LEFT JOIN LATERAL (
    SELECT pm."playlistUrl"
    FROM playlist_video_mappings pm
    JOIN playlist_metadata p ON p."playlistUrl" = pm."playlistUrl"
    WHERE pm."videoUrl" = n."videoUrl"
      AND pm."playlistUrl" NOT IN ('None', 'init')
      AND pm."positionInPlaylist" >= 0
    ORDER BY (p."monitoringType" IN (:monitored)) DESC,
             pm."createdAt" ASC, pm."id" ASC
    LIMIT 1
  ) rp ON TRUE
  WHERE v."site" IS NOT NULL
  ORDER BY n."addedAt", n."videoUrl"`;

/** The path segments of a playlist URL, for matching an uploader's handle. */
function urlSegments(playlistUrl: string): string[] {
  try {
    return new URL(playlistUrl).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

export function createDbFilingStore(): FilingStore {
  return {
    async countWithoutFacets() {
      const [row] = await sequelize.query<{ n: string }>(
        `SELECT COUNT(DISTINCT m."videoUrl") AS n
         FROM playlist_video_mappings m
         JOIN video_metadata v ON v."videoUrl" = m."videoUrl"
         WHERE m."playlistUrl" = 'None' AND v."site" IS NULL`,
        { type: QueryTypes.SELECT },
      );
      return Number(row.n);
    },

    async loadUnlisted(): Promise<UnlistedRow[]> {
      const rows = await sequelize.query<UnlistedSqlRow>(UNLISTED_SQL, {
        type: QueryTypes.SELECT,
        replacements: { monitored: MONITORED_TYPES },
      });
      return rows.map((r) => ({
        videoUrl: r.videoUrl,
        site: r.site,
        channelKey: r.channelKey,
        channelName: r.channelName,
        channelHandle: r.channelHandle,
        durationSeconds: r.durationSeconds === null
          ? null
          : Number(r.durationSeconds),
        addedAt: new Date(r.addedAt),
        realPlaylistUrl: r.realPlaylistUrl,
        filing: r.filedPlacement === null ? null : {
          placement: r.filedPlacement,
          playlistUrl: r.filedPlaylistUrl,
          locked: Boolean(r.filedLocked),
        },
        hasFiledMapping: Boolean(r.hasFiledMapping),
      }));
    },

    async loadPlaylists(): Promise<KnownPlaylist[]> {
      const rows = await PlaylistMetadata.findAll({
        attributes: ["playlistUrl", "monitoringType", "createdAt"],
        where: { playlistUrl: { [Op.notIn]: ["None", "init"] } },
        raw: true,
      });
      return rows.map((p) => {
        const isAuto = p.playlistUrl.startsWith(AUTO_PREFIX);
        return {
          playlistUrl: p.playlistUrl,
          site: isAuto ? "" : coreHostname(p.playlistUrl),
          urlSegments: isAuto ? [] : urlSegments(p.playlistUrl),
          monitored: MONITORED_TYPES.includes(p.monitoringType),
          createdAt: new Date(p.createdAt),
        };
      });
    },

    async loadOwnerCounts() {
      const rows = await sequelize.query<
        { playlistUrl: string; owner: string; n: number }
      >(
        `SELECT pm."playlistUrl", COALESCE(v."channelKey", :unknown) AS owner,
                COUNT(*)::int AS n
         FROM playlist_video_mappings pm
         JOIN playlist_metadata p ON p."playlistUrl" = pm."playlistUrl"
         JOIN video_metadata v ON v."videoUrl" = pm."videoUrl"
         WHERE p."kind" = 'playlist' AND p."origin" = 'user'
           AND pm."playlistUrl" NOT IN ('None', 'init')
         GROUP BY 1, 2`,
        {
          type: QueryTypes.SELECT,
          replacements: { unknown: UNKNOWN_OWNER },
        },
      );
      const byPlaylist = new Map<string, Map<string, number>>();
      for (const { playlistUrl, owner, n } of rows) {
        const counts = byPlaylist.get(playlistUrl) ?? new Map();
        counts.set(owner, n);
        byPlaylist.set(playlistUrl, counts);
      }
      return byPlaylist;
    },

    async writeGroup(group: FilingGroup) {
      await sequelize.transaction(async (transaction) => {
        if (group.createPlaylist) {
          await PlaylistMetadata.findOrCreate({
            where: { playlistUrl: group.createPlaylist.playlistUrl },
            defaults: {
              ...group.createPlaylist,
              lastUpdatedByScheduler: new Date(),
            },
            transaction,
          });
        }

        if (group.playlistUrl !== null) {
          const wanted = group.items.filter((i) => i.createMapping);
          const existing = new Set(
            (await PlaylistVideoMapping.findAll({
              attributes: ["videoUrl"],
              where: {
                playlistUrl: group.playlistUrl,
                videoUrl: { [Op.in]: wanted.map((i) => i.videoUrl) },
              },
              transaction,
              raw: true,
            })).map((m) => m.videoUrl),
          );
          // A video the playlist already holds gets no second mapping, so a
          // retry after a half-finished run can't duplicate one.
          const toCreate = wanted.filter((i) => !existing.has(i.videoUrl));
          if (toCreate.length > 0) {
            await PlaylistVideoMapping.bulkCreate(
              toCreate.map((i) => ({
                videoUrl: i.videoUrl,
                playlistUrl: group.playlistUrl!,
                positionInPlaylist: i.position,
              })),
              { transaction },
            );
          }
        }

        await VideoFiling.bulkCreate(
          group.items.map((i) => ({
            videoUrl: i.videoUrl,
            placement: i.placement,
            playlistUrl: group.playlistUrl,
            locked: i.locked,
            rulesVersion: group.rulesVersion,
          })),
          {
            updateOnDuplicate: [
              "placement",
              "playlistUrl",
              "locked",
              "rulesVersion",
              "updatedAt",
            ],
            transaction,
          },
        );
      });
    },

    async markChannelLike(playlistUrls: string[]) {
      // `silent` leaves updatedAt alone: Channels sorts on activity.
      await PlaylistMetadata.update(
        { kind: "channel", kindSetByFiling: true },
        {
          where: { playlistUrl: { [Op.in]: playlistUrls }, kind: "playlist" },
          silent: true,
        },
      );
    },

    async loadUndoCandidates(): Promise<UndoCandidates> {
      const negativeMappings = await PlaylistVideoMapping.findAll({
        attributes: ["id", "playlistUrl"],
        where: { positionInPlaylist: { [Op.lt]: 0 } },
        raw: true,
      });
      const playlists = await sequelize.query<
        {
          playlistUrl: string;
          origin: "user" | "auto";
          kindSetByFiling: boolean;
          mappingCount: number;
        }
      >(
        `SELECT p."playlistUrl", p."origin", p."kindSetByFiling",
                (SELECT COUNT(*)::int FROM playlist_video_mappings m
                 WHERE m."playlistUrl" = p."playlistUrl") AS "mappingCount"
         FROM playlist_metadata p
         WHERE p."origin" = 'auto' OR p."kindSetByFiling"`,
        { type: QueryTypes.SELECT },
      );
      return {
        negativeMappings,
        filingRows: await VideoFiling.count(),
        playlists,
      };
    },

    async applyUndo(plan: UndoPlan) {
      await sequelize.transaction(async (transaction) => {
        // By sign rather than by id list: only the job writes a negative
        // position, and this stays one statement however many it wrote.
        await PlaylistVideoMapping.destroy({
          where: { positionInPlaylist: { [Op.lt]: 0 } },
          transaction,
        });
        await VideoFiling.destroy({ where: {}, transaction });
        if (plan.removeAutoPlaylists.length > 0) {
          await PlaylistMetadata.destroy({
            where: {
              playlistUrl: { [Op.in]: plan.removeAutoPlaylists },
              origin: "auto",
            },
            transaction,
          });
        }
        if (plan.resetKinds.length > 0) {
          await PlaylistMetadata.update(
            { kind: "playlist", kindSetByFiling: false },
            {
              where: { playlistUrl: { [Op.in]: plan.resetKinds } },
              silent: true,
              transaction,
            },
          );
        }
      });
    },
  };
}
