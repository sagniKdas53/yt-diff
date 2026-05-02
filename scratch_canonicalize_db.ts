import { PlaylistMetadata, sequelize, VideoMetadata } from "./src/db/models.ts";
import {
  canonicalizePlaylistUrl,
  canonicalizeVideoUrl,
  deduplicateAll,
} from "./src/handlers/pipeline/dedup.ts";
import { logger } from "./src/logger.ts";

async function run() {
  Deno.env.set("LOG_LEVELS", "info");

  // 1. Run dedup to merge any duplicates safely
  logger.info(
    "Running deduplication first to ensure no primary key conflicts...",
  );
  await deduplicateAll(false);

  // 2. Canonicalize Playlist URLs
  logger.info("Canonicalizing Playlist URLs...");
  const playlists = await PlaylistMetadata.findAll();
  let pCount = 0;
  for (const p of playlists) {
    const url = p.getDataValue("playlistUrl");
    if (url === "None" || url === "init") continue;

    const canon = canonicalizePlaylistUrl(url);
    if (canon !== url) {
      pCount++;
      logger.info(`Updating playlist: ${url} -> ${canon}`);
      try {
        await p.update({ playlistUrl: canon });
      } catch (e) {
        logger.error(
          `Failed to update playlist ${url}: ${(e as Error).message}`,
        );
      }
    }
  }
  logger.info(`Updated ${pCount} playlist URLs.`);

  // 3. Canonicalize Video URLs
  logger.info("Canonicalizing Video URLs...");
  const videos = await VideoMetadata.findAll();
  let vCount = 0;
  for (const v of videos) {
    const url = v.getDataValue("videoUrl");
    const canon = canonicalizeVideoUrl(url);
    if (canon !== url) {
      vCount++;
      logger.info(`Updating video: ${url} -> ${canon}`);
      try {
        await v.update({ videoUrl: canon });
      } catch (e) {
        logger.error(`Failed to update video ${url}: ${(e as Error).message}`);
      }
    }
  }
  logger.info(`Updated ${vCount} video URLs.`);
}

try {
  logger.info("Starting database canonicalization...");
  await run();
  logger.info("Done!");
} catch (err) {
  logger.error("Failed:", err as any);
} finally {
  await sequelize.close();
}
