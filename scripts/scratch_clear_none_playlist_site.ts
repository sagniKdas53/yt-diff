import { Op } from "sequelize";

import {
  PlaylistMetadata,
  PlaylistVideoMapping,
  sequelize,
  VideoMetadata,
} from "../src/db/models.ts";
import { logger } from "../src/logger.ts";

Deno.env.set("LOG_LEVELS", Deno.env.get("LOG_LEVELS") || "info");

const APPLY_FLAG = "--apply";
const dryRun = !Deno.args.includes(APPLY_FLAG);

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.stack || error.name;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normalizeSiteArg(siteArg: string): string {
  const trimmed = siteArg.trim();
  if (!trimmed) {
    throw new Error("Site URL/host argument cannot be empty.");
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let hostname: string;
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    throw new Error(
      `Invalid site argument "${siteArg}". Pass a host like x.com or a full URL.`,
    );
  }

  const normalized = hostname.toLowerCase();
  if (!normalized) {
    throw new Error(`Could not derive a hostname from "${siteArg}".`);
  }

  return normalized;
}

function isHostOrSubdomain(hostname: string, allowedHost: string): boolean {
  return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
}

function matchesSite(videoUrl: string, siteHost: string): boolean {
  try {
    const { hostname } = new URL(videoUrl);
    return isHostOrSubdomain(hostname.toLowerCase(), siteHost);
  } catch {
    return false;
  }
}

async function collectWorkset(siteHost: string) {
  const nonePlaylist = await PlaylistMetadata.findByPk("None");
  if (!nonePlaylist) {
    throw new Error(
      'Required pseudo-playlist "None" does not exist in playlist_metadata.',
    );
  }

  const noneMappings = await PlaylistVideoMapping.findAll({
    where: { playlistUrl: "None" },
    attributes: ["id", "videoUrl"],
  });

  const matchingMappings = noneMappings.filter((mapping) =>
    matchesSite(mapping.getDataValue("videoUrl") as string, siteHost)
  );

  const videoUrls = [
    ...new Set(
      matchingMappings.map((mapping) =>
        mapping.getDataValue("videoUrl") as string
      ),
    ),
  ];

  const referencedElsewhere = videoUrls.length === 0
    ? new Set<string>()
    : new Set(
      (
        await PlaylistVideoMapping.findAll({
          where: {
            videoUrl: { [Op.in]: videoUrls },
            playlistUrl: { [Op.ne]: "None" },
          },
          attributes: ["videoUrl"],
        })
      ).map((mapping) => mapping.getDataValue("videoUrl") as string),
    );

  const orphanedVideoUrls = videoUrls.filter((videoUrl) =>
    !referencedElsewhere.has(videoUrl)
  );

  return {
    siteHost,
    mappingIds: matchingMappings.map((mapping) =>
      mapping.getDataValue("id") as string
    ),
    videoUrls,
    orphanedVideoUrls,
    referencedElsewhereCount: referencedElsewhere.size,
  };
}

async function run(siteHost: string) {
  const workset = await collectWorkset(siteHost);

  logger.info('Prepared "None" playlist site cleanup', {
    dryRun,
    siteHost: workset.siteHost,
    matchingMappings: workset.mappingIds.length,
    matchingUniqueVideos: workset.videoUrls.length,
    videosReferencedOutsideNone: workset.referencedElsewhereCount,
    videosToDeleteAfterUnmapping: workset.orphanedVideoUrls.length,
  });

  if (dryRun) {
    logger.info(
      `Dry run only. Re-run with ${APPLY_FLAG} to remove ${siteHost} entries from the "None" playlist.`,
    );
    return;
  }

  const transaction = await sequelize.transaction();

  try {
    const deletedMappings = workset.mappingIds.length === 0
      ? 0
      : await PlaylistVideoMapping.destroy({
        where: {
          id: { [Op.in]: workset.mappingIds },
          playlistUrl: "None",
        },
        transaction,
      });

    const deletedVideos = workset.orphanedVideoUrls.length === 0
      ? 0
      : await VideoMetadata.destroy({
        where: {
          videoUrl: { [Op.in]: workset.orphanedVideoUrls },
        },
        transaction,
      });

    await transaction.commit();

    logger.info('"None" playlist site cleanup completed', {
      siteHost,
      deletedMappings,
      deletedVideos,
      keptReferencedVideos: workset.videoUrls.length -
        workset.orphanedVideoUrls.length,
    });
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

const siteArg = Deno.args.find((arg) => !arg.startsWith("--"));

if (!siteArg) {
  console.error(
    "Usage: deno run ... scratch_clear_none_playlist_site.ts <site-host-or-url> [--apply]",
  );
  Deno.exit(1);
}

const siteHost = normalizeSiteArg(siteArg);

try {
  logger.info('Starting "None" playlist site cleanup...', {
    siteHost,
  });
  await run(siteHost);
} catch (error) {
  logger.error("Maintenance script failed", {
    error: formatUnknownError(error),
  });
  Deno.exit(1);
} finally {
  await sequelize.close();
}
