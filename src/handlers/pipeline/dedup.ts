// deno-lint-ignore-file no-explicit-any
import { Op } from "sequelize";
import {
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  /** The videoId shared by all URLs in this group */
  videoId: string;
  /** All videoUrls that share this videoId */
  urls: string[];
  /** The URL we will keep (canonical) */
  canonicalUrl: string;
  /** Explanation of why this URL was chosen as canonical */
  canonicalReason: string;
  /** List of real playlists the canonical URL belongs to (if any) */
  canonicalPlaylists: string[];
  /** The URLs that will be merged into the canonical and then deleted */
  duplicateUrls: string[];
}

export interface DeduplicateResult {
  duplicatesFound: number;
  mergedCount: number;
  details: Array<
    DuplicateGroup & {
      action: "merged" | "would_merge" | "skipped";
      skipReason?: string;
    }
  >;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return hostname without leading www./m. for domain-scoping comparisons. */
function coreHostname(url: string): string {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "")
      .replace(/^m\./, "");
  } catch {
    return "";
  }
}

/**
 * Decide which URL to treat as the canonical one for a group of duplicates.
 *
 * Priority (per user decision):
 *   1. Prefer the record that belongs to a real playlist (not "None" / "init")
 *   2. Among ties, prefer the most recently updated record (updatedAt DESC)
 *   3. The URL produced by normalizeUrl() is used as the tie-breaker label only;
 *      the actual winner is determined by database state.
 */
async function pickCanonical(
  urlsInGroup: string[],
): Promise<{ canonicalUrl: string; reason: string; playlists: string[] }> {
  const PSEUDO_PLAYLISTS = new Set(["None", "init"]);

  // Fetch each URL's most-recently-updated playlist membership.
  const rows = await Promise.all(
    urlsInGroup.map(async (url) => {
      const playlists = await PlaylistVideoMapping.findAll({
        where: {
          videoUrl: url,
          playlistUrl: { [Op.notIn]: [...PSEUDO_PLAYLISTS] },
        },
        attributes: ["playlistUrl"],
      });
      const playlistUrls = playlists.map((p) =>
        p.getDataValue("playlistUrl") as string
      );
      const meta = await VideoMetadata.findOne({
        where: { videoUrl: url },
        attributes: ["updatedAt"],
      });
      return {
        url,
        inRealPlaylist: playlistUrls.length > 0,
        playlists: playlistUrls,
        updatedAt: (meta as any)?.updatedAt ?? new Date(0),
      };
    }),
  );

  // Sort: real-playlist first, then newest updatedAt.
  rows.sort((a, b) => {
    if (a.inRealPlaylist !== b.inRealPlaylist) {
      return a.inRealPlaylist ? -1 : 1;
    }
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });

  const winner = rows[0];
  const reason = winner.inRealPlaylist
    ? `Found ${winner.playlists.length} time(s) in real playlist(s)`
    : "most recently updated";

  return { canonicalUrl: winner.url, reason, playlists: winner.playlists };
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Find all groups of VideoMetadata rows that share the same videoId but live
 * under different videoUrl primary keys, optionally scoped to a site.
 */
export async function findDuplicateVideos(
  siteFilter?: string,
): Promise<DuplicateGroup[]> {
  // Use a raw query to group by videoId and find groups with >1 distinct URL.
  // We scope by hostname substring when siteFilter is provided.
  const siteWhere = siteFilter
    ? `AND "videoUrl" ILIKE '%${siteFilter.replace(/'/g, "''")}%'`
    : "";

  const [rows] = await sequelize.query(`
    SELECT "videoId", array_agg("videoUrl") AS urls
    FROM video_metadata
    WHERE "videoId" IS NOT NULL AND "videoId" != ''
    ${siteWhere}
    GROUP BY "videoId"
    HAVING count(DISTINCT "videoUrl") > 1
  `);

  const groups: DuplicateGroup[] = [];

  for (const row of rows as Array<{ videoId: string; urls: string[] }>) {
    const { videoId, urls } = row;

    // Filter to same core domain (prevents cross-site false positives).
    const domains = new Set(urls.map(coreHostname));
    if (domains.size > 1) {
      // Multiple distinct domains sharing a videoId — skip to avoid mistakes.
      logger.warn("dedup: skipping cross-domain videoId group", {
        videoId,
        urls: urls.join(", "),
      });
      continue;
    }

    const { canonicalUrl, reason, playlists } = await pickCanonical(urls);
    const duplicateUrls = urls.filter((u) => u !== canonicalUrl);

    groups.push({
      videoId,
      urls,
      canonicalUrl,
      canonicalReason: reason,
      canonicalPlaylists: playlists,
      duplicateUrls,
    });
  }

  return groups;
}

/**
 * Merge a set of duplicate URLs into their canonical URL.
 *
 * Steps:
 *   1. Re-home all PlaylistVideoMapping rows from duplicates → canonical
 *      (skip if a mapping for that playlist+position already exists)
 *   2. Propagate any non-null metadata fields the canonical is missing
 *   3. Destroy the duplicate VideoMetadata rows
 */
async function mergeVideoRecords(group: DuplicateGroup): Promise<void> {
  const { canonicalUrl, duplicateUrls } = group;

  const transaction = await sequelize.transaction();
  try {
    const canonicalMeta = await VideoMetadata.findOne({
      where: { videoUrl: canonicalUrl },
      transaction,
    }) as any;

    if (!canonicalMeta) {
      throw new Error(`Canonical record not found: ${canonicalUrl}`);
    }

    for (const dupUrl of duplicateUrls) {
      const dupMeta = await VideoMetadata.findOne({
        where: { videoUrl: dupUrl },
        transaction,
      }) as any;

      if (!dupMeta) {
        logger.warn("dedup: duplicate record already gone", { dupUrl });
        continue;
      }

      // 1. Re-home mappings from dup → canonical.
      //    Get all mappings for the dup URL.
      const dupMappings = await PlaylistVideoMapping.findAll({
        where: { videoUrl: dupUrl },
        transaction,
      });

      for (const mapping of dupMappings) {
        const playlistUrl = mapping.getDataValue("playlistUrl") as string;
        const position = mapping.getDataValue("positionInPlaylist") as number;

        // Check whether a mapping already exists at this playlist+position for canonical.
        const collision = await PlaylistVideoMapping.findOne({
          where: {
            videoUrl: canonicalUrl,
            playlistUrl,
            positionInPlaylist: position,
          },
          transaction,
        });

        if (collision) {
          // Already mapped — just delete the dup mapping.
          await mapping.destroy({ transaction });
        } else {
          await mapping.update({ videoUrl: canonicalUrl }, { transaction });
        }
      }

      // 2. Propagate missing metadata fields from dup → canonical.
      const fieldsToPropagate: string[] = [
        "downloadStatus",
        "fileName",
        "thumbNailFile",
        "onlineThumbnail",
        "subTitleFile",
        "commentsFile",
        "descriptionFile",
        "saveDirectory",
        "isMetaDataSynced",
      ];
      const updates: Record<string, unknown> = {};
      for (const field of fieldsToPropagate) {
        const canonVal = canonicalMeta.getDataValue(field);
        const dupVal = dupMeta.getDataValue(field);
        if (!canonVal && dupVal) {
          updates[field] = dupVal;
        }
      }
      if (Object.keys(updates).length > 0) {
        await canonicalMeta.update(updates, { transaction });
      }

      // 3. Destroy the duplicate record.
      await dupMeta.destroy({ transaction });

      logger.info("dedup: merged duplicate into canonical", {
        canonicalUrl,
        dupUrl,
        updatedFields: Object.keys(updates).join(", "),
        remappedCount: dupMappings.length,
      });
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public orchestrator
// ---------------------------------------------------------------------------

/**
 * Scan the database for duplicate videoId groups and optionally merge them.
 *
 * @param dryRun   If true, report what would happen but make no DB changes.
 * @param siteFilter  Optional site substring to scope the scan (e.g. "iwara.tv").
 */
export async function deduplicateAll(
  dryRun: boolean,
  siteFilter?: string,
): Promise<DeduplicateResult> {
  logger.info("dedup: starting scan", { dryRun, siteFilter });

  const groups = await findDuplicateVideos(siteFilter);

  logger.info(`dedup: found ${groups.length} duplicate group(s)`, { dryRun });

  const details: DeduplicateResult["details"] = [];
  let mergedCount = 0;

  for (const group of groups) {
    if (dryRun) {
      details.push({ ...group, action: "would_merge" });
      continue;
    }

    try {
      await mergeVideoRecords(group);
      mergedCount += group.duplicateUrls.length;
      details.push({ ...group, action: "merged" });
    } catch (err) {
      logger.error("dedup: failed to merge group", {
        group: JSON.stringify(group),
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      details.push({
        ...group,
        action: "skipped",
        skipReason: (err as Error).message,
      });
    }
  }

  logger.info("dedup: completed", {
    dryRun,
    duplicatesFound: groups.length,
    mergedCount,
  });

  return {
    duplicatesFound: groups.length,
    mergedCount,
    details,
  };
}

// ---------------------------------------------------------------------------
// HTTP handler (for /dedup route)
// ---------------------------------------------------------------------------

import he from "he";
import { generateCorsHeaders, MIME_TYPES } from "../../utils/http.ts";
import type { HttpResponseLike } from "../../transport/http.ts";

export interface DedupRequestBody {
  dryRun?: boolean;
  siteFilter?: string;
}

export async function processDedupRequest(
  requestBody: DedupRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  const jsonMimeType = MIME_TYPES[".json"];
  try {
    const dryRun = requestBody.dryRun !== false; // default true
    const siteFilter = requestBody.siteFilter?.trim() || undefined;

    logger.info("dedup: request received", { dryRun, siteFilter });

    const result = await deduplicateAll(dryRun, siteFilter);

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({ status: "success", ...result }));
  } catch (error) {
    logger.error("dedup: request failed", {
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
