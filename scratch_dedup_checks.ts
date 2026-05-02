import { deduplicateUnlisted, deduplicatePlaylists } from "./src/handlers/pipeline/dedup.ts";
import { sequelize } from "./src/db/models.ts";
import { logger } from "./src/logger.ts";

// Set log level to trace to see everything
Deno.env.set("LOG_LEVELS", "trace");

try {
  logger.info("Running manual dedup unlisted...");
  const unlistedResult = await deduplicateUnlisted(false);
  console.log(JSON.stringify(unlistedResult, null, 2));

  logger.info("Running manual dedup playlists...");
  const playlistsResult = await deduplicatePlaylists(false);
  console.log(JSON.stringify(playlistsResult, null, 2));
} catch (err) {
  console.error("Dedup failed:", err);
} finally {
  await sequelize.close();
}
