// deno-lint-ignore-file no-explicit-any
import { Op } from "sequelize";
import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../../db/models.ts";
import { logger } from "../../logger.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  /** The videoId shared by all URLs in this group (if applicable) */
  videoId: string;
  /** All videoUrls that share this videoId / canonicalUrl */
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

export interface DuplicatePlaylistGroup {
  urls: string[];
  canonicalUrl: string;
  canonicalReason: string;
  duplicateUrls: string[];
}

export interface DeduplicateResult {
  videoDuplicatesFound: number;
  videoMergedCount: number;
  videoDetails: Array<
    DuplicateGroup & {
      action: "merged" | "would_merge" | "skipped";
      skipReason?: string;
    }
  >;
  playlistDuplicatesFound: number;
  playlistMergedCount: number;
  playlistDetails: Array<
    DuplicatePlaylistGroup & {
      action: "merged" | "would_merge" | "skipped";
      skipReason?: string;
    }
  >;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function canonicalizeVideoUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);

    if (
      url.hostname.includes("youtube.com") || url.hostname.includes("youtu.be")
    ) {
      url.hostname = "www.youtube.com";
      if (url.pathname.startsWith("/shorts/")) {
        const id = url.pathname.split("/")[2];
        url.pathname = "/watch";
        url.searchParams.set("v", id);
      } else if (url.hostname === "youtu.be") {
        const id = url.pathname.substring(1);
        url.hostname = "www.youtube.com";
        url.pathname = "/watch";
        url.searchParams.set("v", id);
      }
      const v = url.searchParams.get("v");
      url.search = "";
      if (v) url.searchParams.set("v", v);
    } else if (url.hostname.includes("iwara.tv")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[0] === "video") {
        url.pathname = `/video/${parts[1]}`;
      }
      url.search = "";
    } else if (url.hostname.includes("spankbang.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[1] === "video") {
        url.pathname = `/${parts[0]}/video`;
      }
      url.search = "";
    } else if (url.hostname.includes("xhamster.com")) {
      url.search = "";
    } else if (url.hostname.includes("pornhub.com")) {
      const viewkey = url.searchParams.get("viewkey");
      url.search = "";
      if (viewkey) url.searchParams.set("viewkey", viewkey);
    }

    if (
      url.hostname.includes("x.com") || url.hostname.includes("twitter.com")
    ) {
      url.searchParams.set("s", "20");
    }

    return url.toString();
  } catch (_e) {
    return urlStr;
  }
}

export function canonicalizePlaylistUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);

    if (
      url.hostname.includes("youtube.com") || url.hostname.includes("youtu.be")
    ) {
      url.hostname = "www.youtube.com";
      const list = url.searchParams.get("list");
      if (list) {
        url.pathname = "/playlist";
        url.search = `?list=${list}`;
      } else if (url.pathname === "/playlist") {
        url.search = "";
      }
    } else if (url.hostname.includes("iwara.tv")) {
      url.searchParams.delete("sort");
      url.searchParams.delete("page");
    } else if (url.hostname.includes("spankbang.com")) {
      url.searchParams.delete("o");
      url.searchParams.delete("p");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[1] === "playlist") {
        let pid = parts[0];
        if (pid.endsWith("-nohrcs")) pid = pid.replace("-nohrcs", "");
        url.pathname = `/${pid}/playlist`;
      }
    } else if (url.hostname.includes("xhamster.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[0] === "creators") {
        url.pathname = `/creators/${parts[1]}`;
      }
    }

    if (
      url.hostname.includes("x.com") || url.hostname.includes("twitter.com")
    ) {
      url.searchParams.set("s", "20");
    }

    return url.toString();
  } catch (_e) {
    return urlStr;
  }
}

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

async function pickCanonical(
  urlsInGroup: string[],
): Promise<{ canonicalUrl: string; reason: string; playlists: string[] }> {
  const PSEUDO_PLAYLISTS = new Set(["None", "init"]);

  const rows = await Promise.all(
    urlsInGroup.map(async (url) => {
      const playlists = await PlaylistVideoMapping.findAll({
        where: { videoUrl: url },
        attributes: ["playlistUrl"],
      });
      const playlistUrls = playlists.map(
        (p) => p.getDataValue("playlistUrl") as string,
      );
      const meta = await VideoMetadata.findOne({
        where: { videoUrl: url },
        attributes: ["updatedAt"],
      });
      const realPlaylists = playlistUrls.filter(
        (p) => !PSEUDO_PLAYLISTS.has(p),
      );
      return {
        url,
        inRealPlaylist: realPlaylists.length > 0,
        playlists: playlistUrls,
        updatedAt: (meta as any)?.updatedAt ?? new Date(0),
      };
    }),
  );

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
// Core operations: Videos
// ---------------------------------------------------------------------------

export async function canonicalizeVideoUrlsInNonePlaylist(
  siteFilter?: string,
): Promise<void> {
  const whereClause: any = { playlistUrl: "None" };
  if (siteFilter) {
    whereClause.videoUrl = { [Op.iLike]: `%${siteFilter}%` };
  }

  const mappings = await PlaylistVideoMapping.findAll({
    where: whereClause,
    order: [["positionInPlaylist", "ASC"]],
  });

  logger.info(
    `dedup: checking ${mappings.length} items in None playlist for canonicalization`,
  );

  for (const mapping of mappings) {
    const originalUrl = mapping.getDataValue("videoUrl") as string;
    const canonUrl = canonicalizeVideoUrl(originalUrl);

    if (canonUrl === originalUrl) {
      continue;
    }

    const transaction = await sequelize.transaction();
    try {
      // Check if canonUrl already exists in None playlist
      const existingMapping = await PlaylistVideoMapping.findOne({
        where: { playlistUrl: "None", videoUrl: canonUrl },
        transaction,
      });

      if (existingMapping) {
        const existingPos = existingMapping.getDataValue(
          "positionInPlaylist",
        ) as number;
        const currentPos = mapping.getDataValue("positionInPlaylist") as number;

        let toRemove, toKeep;
        if (existingPos > currentPos) {
          toRemove = existingMapping;
          toKeep = mapping;
        } else {
          toRemove = mapping;
          toKeep = existingMapping;
        }

        const removedPos = toRemove.getDataValue(
          "positionInPlaylist",
        ) as number;

        logger.info(
          "dedup: found duplicate in None playlist during canonicalization",
          {
            originalUrl,
            canonUrl,
            removedPos,
          },
        );

        await toRemove.destroy({ transaction });

        await PlaylistVideoMapping.decrement("positionInPlaylist", {
          by: 1,
          where: {
            playlistUrl: "None",
            positionInPlaylist: { [Op.gt]: removedPos },
          },
          transaction,
        });

        if (toKeep === mapping) {
          const meta = await VideoMetadata.findOne({
            where: { videoUrl: originalUrl },
            transaction,
          });
          const existingMeta = await VideoMetadata.findOne({
            where: { videoUrl: canonUrl },
            transaction,
          });

          if (!existingMeta) {
            if (meta) {
              await meta.update({ videoUrl: canonUrl }, { transaction }); // cascades
            } else {
              await mapping.update({ videoUrl: canonUrl }, { transaction });
            }
          } else {
            await mapping.update({ videoUrl: canonUrl }, { transaction });
            if (meta) await meta.destroy({ transaction });
          }
        } else {
          const meta = await VideoMetadata.findOne({
            where: { videoUrl: originalUrl },
            transaction,
          });
          if (meta) {
            await meta.destroy({ transaction });
          }
        }
      } else {
        logger.debug("dedup: canonicalizing url in None playlist", {
          originalUrl,
          canonUrl,
        });

        const meta = await VideoMetadata.findOne({
          where: { videoUrl: originalUrl },
          transaction,
        });
        const existingMeta = await VideoMetadata.findOne({
          where: { videoUrl: canonUrl },
          transaction,
        });

        if (!existingMeta) {
          if (meta) {
            await meta.update({ videoUrl: canonUrl }, { transaction }); // cascades
          } else {
            await mapping.update({ videoUrl: canonUrl }, { transaction });
          }
        } else {
          await mapping.update({ videoUrl: canonUrl }, { transaction });
          if (meta) await meta.destroy({ transaction });
        }
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      logger.error("dedup: error canonicalizing url in None playlist", {
        originalUrl,
        canonUrl,
        error: (err as Error).message,
      });
    }
  }
}

// ---------------------------------------------------------------------------

export async function findDuplicateVideos(
  siteFilter?: string,
): Promise<DuplicateGroup[]> {
  const whereClause = siteFilter
    ? { videoUrl: { [Op.iLike]: `%${siteFilter}%` } }
    : undefined;

  const allVideos = await VideoMetadata.findAll({
    where: whereClause,
    attributes: ["videoUrl", "videoId"],
  });

  // 1. Group by videoId
  const videoIdGroups = new Map<string, Set<string>>();
  for (const v of allVideos) {
    const vid = v.getDataValue("videoId");
    const url = v.getDataValue("videoUrl");
    if (vid) {
      const domain = coreHostname(url);
      const key = `vid::${domain}::${vid}`;
      if (!videoIdGroups.has(key)) videoIdGroups.set(key, new Set());
      videoIdGroups.get(key)!.add(url);
    }
  }

  // 2. Group by canonicalUrl
  const canonGroups = new Map<string, Set<string>>();
  for (const v of allVideos) {
    const url = v.getDataValue("videoUrl");
    const canon = canonicalizeVideoUrl(url);
    if (!canonGroups.has(canon)) canonGroups.set(canon, new Set());
    canonGroups.get(canon)!.add(url);
  }

  // Union-Find to merge overlaps
  const parent = new Map<string, string>();
  const find = (i: string): string => {
    if (!parent.has(i)) parent.set(i, i);
    if (parent.get(i) === i) return i;
    const root = find(parent.get(i)!);
    parent.set(i, root);
    return root;
  };
  const union = (i: string, j: string) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent.set(rootI, rootJ);
  };

  for (const group of videoIdGroups.values()) {
    const urls = Array.from(group);
    for (let i = 1; i < urls.length; i++) union(urls[0], urls[i]);
  }
  for (const group of canonGroups.values()) {
    const urls = Array.from(group);
    for (let i = 1; i < urls.length; i++) union(urls[0], urls[i]);
  }

  const mergedGroups = new Map<string, string[]>();
  for (const v of allVideos) {
    const url = v.getDataValue("videoUrl");
    const root = find(url);
    if (!mergedGroups.has(root)) mergedGroups.set(root, []);
    mergedGroups.get(root)!.push(url);
  }

  const groups: DuplicateGroup[] = [];

  for (const urls of mergedGroups.values()) {
    if (urls.length > 1) {
      const domains = new Set(urls.map(coreHostname));
      if (domains.size > 1) {
        logger.warn("dedup: skipping cross-domain video group", {
          urls: urls.join(", "),
        });
        continue;
      }

      const { canonicalUrl, reason, playlists } = await pickCanonical(urls);
      const duplicateUrls = urls.filter((u) => u !== canonicalUrl);
      const sample = allVideos.find((v) =>
        v.getDataValue("videoUrl") === canonicalUrl
      );

      groups.push({
        videoId: sample?.getDataValue("videoId") || "",
        urls,
        canonicalUrl,
        canonicalReason: reason,
        canonicalPlaylists: playlists,
        duplicateUrls,
      });
    }
  }

  return groups;
}

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

      const dupMappings = await PlaylistVideoMapping.findAll({
        where: { videoUrl: dupUrl },
        transaction,
      });

      for (const mapping of dupMappings) {
        const playlistUrl = mapping.getDataValue("playlistUrl") as string;

        const alreadyInPlaylist = await PlaylistVideoMapping.findOne({
          where: { videoUrl: canonicalUrl, playlistUrl },
          transaction,
        });

        if (alreadyInPlaylist) {
          const removedPosition = mapping.getDataValue(
            "positionInPlaylist",
          ) as number;
          logger.debug(
            "dedup: removing duplicate playlist mapping and adjusting indexes",
            {
              playlistUrl,
              videoUrl: canonicalUrl,
              removedPosition,
              keptPosition: alreadyInPlaylist.getDataValue(
                "positionInPlaylist",
              ),
            },
          );

          await mapping.destroy({ transaction });

          await PlaylistVideoMapping.decrement("positionInPlaylist", {
            by: 1,
            where: {
              playlistUrl,
              positionInPlaylist: { [Op.gt]: removedPosition },
            },
            transaction,
          });
        } else {
          await mapping.update({ videoUrl: canonicalUrl }, { transaction });
        }
      }

      const fieldsToPropagate = [
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
// Core operations: Playlists
// ---------------------------------------------------------------------------

export async function findDuplicatePlaylists(
  siteFilter?: string,
): Promise<DuplicatePlaylistGroup[]> {
  const whereClause = siteFilter
    ? { playlistUrl: { [Op.iLike]: `%${siteFilter}%` } }
    : undefined;

  const allPlaylists = await PlaylistMetadata.findAll({
    where: whereClause,
    attributes: ["playlistUrl", "saveDirectory", "updatedAt"],
  });

  const canonGroups = new Map<string, string[]>();

  for (const p of allPlaylists) {
    const url = p.getDataValue("playlistUrl");
    if (url === "None" || url === "init") continue;
    const canon = canonicalizePlaylistUrl(url);
    if (!canonGroups.has(canon)) canonGroups.set(canon, []);
    canonGroups.get(canon)!.push(url);
  }

  const groups: DuplicatePlaylistGroup[] = [];

  for (const [_canon, urls] of canonGroups.entries()) {
    if (urls.length > 1) {
      const records = allPlaylists.filter((p) =>
        urls.includes(p.getDataValue("playlistUrl"))
      );

      records.sort((a, b) => {
        const aDir = a.getDataValue("saveDirectory");
        const bDir = b.getDataValue("saveDirectory");
        const aHasDir = aDir && aDir !== "";
        const bHasDir = bDir && bDir !== "";

        if (aHasDir !== bHasDir) return aHasDir ? -1 : 1;

        const aTime = (a.getDataValue("updatedAt") as Date).getTime();
        const bTime = (b.getDataValue("updatedAt") as Date).getTime();
        return bTime - aTime;
      });

      const winner = records[0];
      const canonicalUrl = winner.getDataValue("playlistUrl");
      const aDir = winner.getDataValue("saveDirectory");
      const reason = (aDir && aDir !== "")
        ? "has non-empty saveDirectory"
        : "most recently updated";

      const duplicateUrls = urls.filter((u) => u !== canonicalUrl);

      groups.push({
        urls,
        canonicalUrl,
        canonicalReason: reason,
        duplicateUrls,
      });
    }
  }

  return groups;
}

async function mergePlaylistRecords(
  group: DuplicatePlaylistGroup,
): Promise<void> {
  const { canonicalUrl, duplicateUrls } = group;

  const transaction = await sequelize.transaction();
  try {
    const canonicalMeta = await PlaylistMetadata.findOne({
      where: { playlistUrl: canonicalUrl },
      transaction,
    }) as any;

    if (!canonicalMeta) {
      throw new Error(`Canonical playlist not found: ${canonicalUrl}`);
    }

    for (const dupUrl of duplicateUrls) {
      const dupMeta = await PlaylistMetadata.findOne({
        where: { playlistUrl: dupUrl },
        transaction,
      }) as any;

      if (!dupMeta) {
        continue;
      }

      const dupMappings = await PlaylistVideoMapping.findAll({
        where: { playlistUrl: dupUrl },
        transaction,
      });

      for (const mapping of dupMappings) {
        const videoUrl = mapping.getDataValue("videoUrl") as string;

        const alreadyInCanonical = await PlaylistVideoMapping.findOne({
          where: { playlistUrl: canonicalUrl, videoUrl },
          transaction,
        });

        if (alreadyInCanonical) {
          const dupUpdatedAt = (mapping.getDataValue("updatedAt") as Date)
            .getTime();
          const canonUpdatedAt =
            (alreadyInCanonical.getDataValue("updatedAt") as Date).getTime();

          if (dupUpdatedAt > canonUpdatedAt) {
            logger.debug(
              "dedup: duplicate mapping is newer, replacing canonical mapping",
              {
                playlistUrl: canonicalUrl,
                videoUrl,
              },
            );
            await alreadyInCanonical.destroy({ transaction });
            await mapping.update({ playlistUrl: canonicalUrl }, {
              transaction,
            });
          } else {
            logger.debug(
              "dedup: canonical mapping is newer or equal, dropping duplicate mapping",
              {
                playlistUrl: canonicalUrl,
                videoUrl,
              },
            );
            await mapping.destroy({ transaction });
          }
        } else {
          await mapping.update({ playlistUrl: canonicalUrl }, { transaction });
        }
      }

      const fieldsToPropagate = [
        "saveDirectory",
        "monitoringType",
      ];
      const updates: Record<string, unknown> = {};
      for (const field of fieldsToPropagate) {
        const canonVal = canonicalMeta.getDataValue(field);
        const dupVal = dupMeta.getDataValue(field);
        if (
          (!canonVal || canonVal === "" || canonVal === "N/A") && dupVal &&
          dupVal !== "" && dupVal !== "N/A"
        ) {
          updates[field] = dupVal;
        }
      }
      if (Object.keys(updates).length > 0) {
        await canonicalMeta.update(updates, { transaction });
      }

      await dupMeta.destroy({ transaction });

      logger.info("dedup: merged duplicate playlist into canonical", {
        canonicalUrl,
        dupUrl,
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

export interface DeduplicateUnlistedResult {
  videoDuplicatesFound: number;
  videoMergedCount: number;
  videoDetails: Array<
    DuplicateGroup & {
      action: "merged" | "would_merge" | "skipped";
      skipReason?: string;
    }
  >;
}

export async function deduplicateUnlisted(
  dryRun: boolean,
  siteFilter?: string,
): Promise<DeduplicateUnlistedResult> {
  logger.info("dedup: starting unlisted scan", { dryRun, siteFilter });

  // 0. Canonicalize video urls in the None playlist first
  if (!dryRun) {
    await canonicalizeVideoUrlsInNonePlaylist(siteFilter);
  }

  // 1. Process Videos
  const videoGroups = await findDuplicateVideos(siteFilter);
  logger.info(`dedup: found ${videoGroups.length} video duplicate group(s)`, {
    dryRun,
  });

  const videoDetails: DeduplicateUnlistedResult["videoDetails"] = [];
  let videoMergedCount = 0;

  for (const group of videoGroups) {
    if (dryRun) {
      videoDetails.push({ ...group, action: "would_merge" });
      continue;
    }

    try {
      await mergeVideoRecords(group);
      videoMergedCount += group.duplicateUrls.length;
      videoDetails.push({ ...group, action: "merged" });
    } catch (err) {
      logger.error("dedup: failed to merge video group", {
        group: JSON.stringify(group),
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      videoDetails.push({
        ...group,
        action: "skipped",
        skipReason: (err as Error).message,
      });
    }
  }

  logger.info("dedup: completed unlisted videos", {
    dryRun,
    videoDuplicatesFound: videoGroups.length,
    videoMergedCount,
  });

  return {
    videoDuplicatesFound: videoGroups.length,
    videoMergedCount,
    videoDetails,
  };
}

export interface DeduplicatePlaylistsResult {
  playlistDuplicatesFound: number;
  playlistMergedCount: number;
  playlistDetails: Array<
    DuplicatePlaylistGroup & {
      action: "merged" | "would_merge" | "skipped";
      skipReason?: string;
    }
  >;
}

export async function deduplicatePlaylists(
  dryRun: boolean,
  siteFilter?: string,
): Promise<DeduplicatePlaylistsResult> {
  logger.info("dedup: starting playlist scan", { dryRun, siteFilter });

  // Process Playlists
  const playlistGroups = await findDuplicatePlaylists(siteFilter);
  logger.info(
    `dedup: found ${playlistGroups.length} playlist duplicate group(s)`,
    { dryRun },
  );

  const playlistDetails: DeduplicatePlaylistsResult["playlistDetails"] = [];
  let playlistMergedCount = 0;

  for (const group of playlistGroups) {
    if (dryRun) {
      playlistDetails.push({ ...group, action: "would_merge" });
      continue;
    }

    try {
      await mergePlaylistRecords(group);
      playlistMergedCount += group.duplicateUrls.length;
      playlistDetails.push({ ...group, action: "merged" });
    } catch (err) {
      logger.error("dedup: failed to merge playlist group", {
        group: JSON.stringify(group),
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      playlistDetails.push({
        ...group,
        action: "skipped",
        skipReason: (err as Error).message,
      });
    }
  }

  logger.info("dedup: completed playlists", {
    dryRun,
    playlistDuplicatesFound: playlistGroups.length,
    playlistMergedCount,
  });

  return {
    playlistDuplicatesFound: playlistGroups.length,
    playlistMergedCount,
    playlistDetails,
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

export async function processDedupUnlistedRequest(
  requestBody: DedupRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  const jsonMimeType = MIME_TYPES[".json"];
  try {
    const dryRun = requestBody.dryRun !== false; // default true
    const siteFilter = requestBody.siteFilter?.trim() || undefined;

    logger.info("dedup-unlisted: request received", { dryRun, siteFilter });

    const result = await deduplicateUnlisted(dryRun, siteFilter);

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({ status: "success", ...result }));
  } catch (error) {
    logger.error("dedup-unlisted: request failed", {
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

export async function processDedupPlaylistsRequest(
  requestBody: DedupRequestBody,
  response: HttpResponseLike,
): Promise<void> {
  const jsonMimeType = MIME_TYPES[".json"];
  try {
    const dryRun = requestBody.dryRun !== false; // default true
    const siteFilter = requestBody.siteFilter?.trim() || undefined;

    logger.info("dedup-playlists: request received", { dryRun, siteFilter });

    const result = await deduplicatePlaylists(dryRun, siteFilter);

    response.writeHead(200, generateCorsHeaders(jsonMimeType));
    response.end(JSON.stringify({ status: "success", ...result }));
  } catch (error) {
    logger.error("dedup-playlists: request failed", {
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
