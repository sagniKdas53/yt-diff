/**
 * Shared set-up for the database tests.
 *
 * The environment is set before anything imports the models, because they read
 * it once, at import. Every test reloads `seed/load.sh`, which starts (or
 * reuses) a throwaway Postgres on localhost:55432 held in memory, so a test
 * can't depend on what an earlier one left. This never connects to anything
 * but that database.
 */
Deno.env.set("DB_HOST", "localhost");
Deno.env.set("DB_PORT", "55432");
Deno.env.set("DB_USERNAME", "ytdiff");
Deno.env.set("DB_PASSWORD", "testpassword");
Deno.env.set("SECRET_KEY", "seed-secret-key-not-used-anywhere-else");

export const { QueryTypes, Op } = await import("sequelize");
export const { sequelize, PlaylistVideoMapping } = await import(
  "../src/db/models.ts"
);
const { backfillBatch, emptyTotals } = await import(
  "../scripts/facets_backfill.ts"
);

const LOAD_SH = new URL(
  "../docs/plans/watch-first/seed/load.sh",
  import.meta.url,
).pathname;

export const END_PLAYLIST = "https://match.example/@match-me/videos";
export const MIXED_PLAYLIST = "https://match.example/playlist?list=mixed";

/** Reloads the pack and edge cases, then fills the facets as a deploy would. */
export async function reload() {
  const out = await new Deno.Command("bash", {
    args: [LOAD_SH],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `seed/load.sh failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const totals = emptyTotals();
  let cursor: string | null = null;
  do {
    cursor = await backfillBatch(cursor, totals);
  } while (cursor !== null);
}

export const dbTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await reload();
      await fn();
    },
  });

/** Closes the connection; register it as the last test of a file. */
export const closeTest = (name: string) =>
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await sequelize.close();
    },
  });

export async function rows<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  return await sequelize.query(sql, { type: QueryTypes.SELECT }) as T[];
}

export async function count(sql: string): Promise<number> {
  const [row] = await rows<{ n: string }>(sql);
  return Number(row.n);
}

/** SQL string literal, for values a test spells out itself. */
export const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
