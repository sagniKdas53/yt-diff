import { assert, assertEquals } from "std/assert/mod.ts";
import { createPlaylistRecord } from "../src/handlers/pipeline/playlist-records.ts";
import { PlaylistMetadata } from "../src/db/models.ts";

/**
 * The Q10 enabler: the sort order used to come from a counter held in
 * `createListingFlow`'s closure, seeded once and invalidated by hand after
 * every deletion. It now comes from the table itself on every create.
 *
 * That is only true if the read happens inside the same serialized section as
 * the write — otherwise two concurrent creates read the same tail and hand out
 * the same number, which is the collision the old reset hook existed to
 * prevent. These tests pin both halves.
 *
 * The seam is the model static, as in `ingest_chunk_persist.test.ts`.
 */

interface Created {
  playlistUrl: string;
  sortOrder: number;
}

/**
 * Stands in for the playlist table.
 *
 * `findOne` reads the highest sort order held so far and `findOrCreate`
 * appends, so the stub has the one property the real table has: a create is
 * visible to the next read.
 */
function installTable(): {
  rows: Created[];
  peakConcurrentReads: () => number;
  restore: () => void;
} {
  const rows: Created[] = [];
  let readsInFlight = 0;
  let peak = 0;

  // deno-lint-ignore no-explicit-any
  (PlaylistMetadata as any).findOne = async () => {
    readsInFlight += 1;
    peak = Math.max(peak, readsInFlight);
    // One turn of the event loop, so a second create that is free to run
    // reaches this read before this one finishes — which is exactly what an
    // unserialized implementation would do, and what the peak then records.
    await new Promise((resolve) => setTimeout(resolve, 0));
    readsInFlight -= 1;

    if (rows.length === 0) return null;
    const highest = rows.reduce((best, r) =>
      r.sortOrder > best.sortOrder ? r : best
    );
    return {
      getDataValue: () => highest.sortOrder,
      sortOrder: highest.sortOrder,
    };
  };

  // deno-lint-ignore no-explicit-any
  (PlaylistMetadata as any).findOrCreate = (opts: any) => {
    const existing = rows.find((r) => r.playlistUrl === opts.where.playlistUrl);
    if (existing) return Promise.resolve([existing, false]);
    const row = {
      playlistUrl: opts.defaults.playlistUrl,
      sortOrder: opts.defaults.sortOrder,
    };
    rows.push(row);
    return Promise.resolve([row, true]);
  };

  return {
    rows,
    peakConcurrentReads: () => peak,
    restore: () => {
      // deno-lint-ignore no-explicit-any
      delete (PlaylistMetadata as any).findOne;
      // deno-lint-ignore no-explicit-any
      delete (PlaylistMetadata as any).findOrCreate;
    },
  };
}

Deno.test("createPlaylistRecord - the first playlist sorts at zero", async () => {
  const { rows, restore } = installTable();
  try {
    await createPlaylistRecord("https://e.com/a", "Alpha", "Fast");
    assertEquals(rows[0].sortOrder, 0);
  } finally {
    restore();
  }
});

Deno.test("createPlaylistRecord - each later playlist takes MAX(sortOrder) + 1", async () => {
  const { rows, restore } = installTable();
  try {
    await createPlaylistRecord("https://e.com/a", "Alpha", "Fast");
    await createPlaylistRecord("https://e.com/b", "Bravo", "Fast");
    await createPlaylistRecord("https://e.com/c", "Charlie", "Fast");
    assertEquals(rows.map((r) => r.sortOrder), [0, 1, 2]);
  } finally {
    restore();
  }
});

Deno.test("createPlaylistRecord - concurrent creates read one at a time", async () => {
  // Reading MAX(sortOrder) is only safe if the read and the write it feeds are
  // one section: three creates that read before any of them writes all see the
  // same tail and claim the same number. The read yields a turn, so an
  // implementation that did not serialize would have all three in flight at
  // once — the peak is what distinguishes the two, and the numbers handed out
  // are the consequence.
  const { rows, peakConcurrentReads, restore } = installTable();

  try {
    await Promise.all([
      createPlaylistRecord("https://e.com/a", "Alpha", "Fast"),
      createPlaylistRecord("https://e.com/b", "Bravo", "Fast"),
      createPlaylistRecord("https://e.com/c", "Charlie", "Fast"),
    ]);

    assertEquals(peakConcurrentReads(), 1);
    const orders = rows.map((r) => r.sortOrder).sort((l, r) => l - r);
    assertEquals(orders, [0, 1, 2]);
  } finally {
    restore();
  }
});

Deno.test("createPlaylistRecord - a deletion needs no invalidation step", async () => {
  // Deleting a playlist renumbers the rows after it. The counter had to be
  // told; reading the table cannot be stale, because it reads the same rows
  // the deletion just rewrote.
  const { rows, restore } = installTable();
  try {
    await createPlaylistRecord("https://e.com/a", "Alpha", "Fast");
    await createPlaylistRecord("https://e.com/b", "Bravo", "Fast");
    await createPlaylistRecord("https://e.com/c", "Charlie", "Fast");

    // Delete "Bravo" and renumber, exactly as the deletion path does.
    rows.splice(1, 1);
    rows.forEach((row, index) => (row.sortOrder = index));

    await createPlaylistRecord("https://e.com/d", "Delta", "Fast");
    assertEquals(rows.map((r) => r.sortOrder), [0, 1, 2]);
    assertEquals(rows[2].playlistUrl, "https://e.com/d");
  } finally {
    restore();
  }
});

Deno.test("createPlaylistRecord - an existing playlist is returned, not renumbered", async () => {
  const { rows, restore } = installTable();
  try {
    await createPlaylistRecord("https://e.com/a", "Alpha", "Fast");
    await createPlaylistRecord("https://e.com/a", "Alpha again", "Slow");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].sortOrder, 0);
  } finally {
    restore();
  }
});

Deno.test("createPlaylistRecord - a failed create still releases the lock", async () => {
  // The lock is released in a `finally`. Without that, one thrown create would
  // wedge every later one forever.
  const { restore } = installTable();
  // deno-lint-ignore no-explicit-any
  (PlaylistMetadata as any).findOrCreate = () =>
    Promise.reject(new Error("write refused"));

  try {
    let threw = false;
    try {
      await createPlaylistRecord("https://e.com/a", "Alpha", "Fast");
    } catch {
      threw = true;
    }
    assert(threw, "the create should surface its failure");

    // The next create must not hang on the previous one's lock.
    const { rows, restore: restoreSecond } = installTable();
    try {
      await createPlaylistRecord("https://e.com/b", "Bravo", "Fast");
      assertEquals(rows.length, 1);
    } finally {
      restoreSecond();
    }
  } finally {
    restore();
  }
});
