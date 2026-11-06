/**
 * Files Unlisted videos, or undoes it. Both are a dry run unless `--apply`.
 *
 *   deno task filing:run             print what would happen
 *   deno task filing:run --apply     do it
 *   deno task filing:undo            print what would be reversed
 *   deno task filing:undo --apply    reverse it
 *
 * Nothing here deletes a file, a video row or a `None` mapping. Run
 * `deno task facets:backfill` first: rows without facets are skipped.
 */

import { initializeDatabase, sequelize } from "../src/db/models.ts";
import { runFilingSweep, undoFiling } from "../src/handlers/filing/sweep.ts";

const [command, ...flags] = Deno.args;
const apply = flags.includes("--apply");

if (import.meta.main) {
  if (command !== "run" && command !== "undo") {
    console.error("usage: filing.ts <run|undo> [--apply]");
    Deno.exit(2);
  }
  await initializeDatabase();
  try {
    console.log(apply ? "Applying." : "Dry run: nothing is written.");
    const summary = command === "run"
      ? await runFilingSweep({ apply })
      : await undoFiling({ apply });
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) console.log("Add --apply to write it.");
  } finally {
    await sequelize.close();
  }
}
