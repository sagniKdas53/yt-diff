import { sequelize, VideoMetadata } from "../src/db/models.ts";
import { logger } from "../src/logger.ts";

Deno.env.set("LOG_LEVELS", Deno.env.get("LOG_LEVELS") || "info");

const APPLY_FLAG = "--apply";
const dryRun = !Deno.args.includes(APPLY_FLAG);

const DOWNLOAD_RESET_FIELDS = {
  downloadStatus: false,
  fileName: null,
  thumbNailFile: null,
  subTitleFile: null,
  commentsFile: null,
  descriptionFile: null,
  saveDirectory: null,
  isMetaDataSynced: false,
};

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

async function run() {
  const totalVideos = await VideoMetadata.count();
  const downloadedVideos = await VideoMetadata.count({
    where: { downloadStatus: true },
  });

  logger.info("Prepared download-state reset maintenance run", {
    dryRun,
    totalVideos,
    downloadedVideos,
  });

  if (dryRun) {
    logger.info(
      `Dry run only. Re-run with ${APPLY_FLAG} to reset all video download state.`,
    );
    return;
  }

  const [resetCount] = await VideoMetadata.update(DOWNLOAD_RESET_FIELDS, {
    where: {},
  });

  logger.info("Download-state reset completed", {
    resetCount,
  });
}

try {
  logger.info("Starting download-state reset...");
  await run();
} catch (error) {
  logger.error("Maintenance script failed", {
    error: formatUnknownError(error),
  });
  Deno.exit(1);
} finally {
  await sequelize.close();
}
