/**
 * Creates the schema the way the app does, so the pack never carries a copy of it
 * that can go stale. initializeDatabase logs sync errors rather than throwing them,
 * so a real failure shows up as a missing table when load.sh loads the data.
 */
import { initializeDatabase, sequelize } from "../../../../src/db/models.ts";

await initializeDatabase();
await sequelize.close();
Deno.exit(0);
