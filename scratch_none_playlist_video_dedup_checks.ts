import { deduplicateAll } from "./src/handlers/pipeline/dedup.ts";
import { sequelize } from "./src/db/models.ts";
import { logger } from "./src/logger.ts";

// Set log level to trace to see everything
Deno.env.set("LOG_LEVELS", "trace");

try {
  logger.info("Running manual dedup dry run...");
  const result = await deduplicateAll(false);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("Dedup failed:", err);
} finally {
  await sequelize.close();
}
