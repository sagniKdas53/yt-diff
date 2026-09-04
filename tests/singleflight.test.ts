import { assert, assertEquals } from "std/assert/mod.ts";
import { createSingleFlight } from "../src/handlers/pipeline/singleflight.ts";

/**
 * Observed on 2026-09-04: the same playlist was submitted twice, twenty-one
 * seconds apart, and both submissions went into the listing queue. The second
 * run found the playlist already present at the same watch mode, returned
 * "No items found", and surfaced as a failure of a listing that had in fact
 * just succeeded.
 *
 * Downloads never had this problem — an entry lands in `downloadProcesses`
 * before the semaphore is acquired, so queued downloads are visible to the
 * duplicate filter. Listing acquires first and registers after.
 */

/** Work whose completion the test controls. */
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (release = resolve));
  return { promise, release };
}

Deno.test("singleFlight - a second caller joins the first instead of starting again", async () => {
  const flight = createSingleFlight<string>();
  const first = gate<string>();
  let starts = 0;

  const work = () => {
    starts++;
    return first.promise;
  };

  const a = flight.run("playlist-1", work);
  const b = flight.run("playlist-1", work);

  assertEquals(starts, 1, "the work should run once");
  assertEquals(flight.size, 1);

  first.release("listed");

  // Both callers get the real result — not an error, and not a dropped entry
  // that would shift every later index in the results array.
  assertEquals(await a, "listed");
  assertEquals(await b, "listed");
});

Deno.test("singleFlight - the key is released once the work settles", async () => {
  const flight = createSingleFlight<string>();
  let starts = 0;
  const work = () => {
    starts++;
    return Promise.resolve("done");
  };

  await flight.run("playlist-1", work);
  assertEquals(flight.size, 0, "a finished run must not linger");

  await flight.run("playlist-1", work);
  assertEquals(starts, 2, "a later submission runs again");
});

Deno.test("singleFlight - a failed run is released too", async () => {
  // Without the `finally`, one thrown listing would wedge that URL until
  // restart — the same shape as the create-lock bug in playlist-records.
  const flight = createSingleFlight<string>();
  let starts = 0;

  const failing = () => {
    starts++;
    return Promise.reject(new Error("listing blew up"));
  };

  let threw = false;
  try {
    await flight.run("playlist-1", failing);
  } catch {
    threw = true;
  }

  assert(threw, "the failure should reach the caller");
  assertEquals(flight.size, 0, "and must not leave the key held");

  await flight.run("playlist-1", () => Promise.resolve("ok"));
  assertEquals(starts, 1, "the retry is a fresh run, not the failed one");
});

Deno.test("singleFlight - both joiners see the same failure", async () => {
  const flight = createSingleFlight<string>();
  const first = gate<string>();
  let starts = 0;

  const work = () => {
    starts++;
    return first.promise.then(() => {
      throw new Error("listing blew up");
    });
  };

  const a = flight.run("playlist-1", work).catch((e: Error) => e.message);
  const b = flight.run("playlist-1", work).catch((e: Error) => e.message);
  first.release("go");

  assertEquals(await a, "listing blew up");
  assertEquals(await b, "listing blew up");
  assertEquals(starts, 1);
});

Deno.test("singleFlight - different keys run independently", async () => {
  // `/index <url> Start` and a bare submission of the same URL ask for
  // different things; collapsing them would hand the second caller a result
  // computed under the first one's watch mode.
  const flight = createSingleFlight<string>();
  const started: string[] = [];

  const results = await Promise.all([
    flight.run("url|Start", () => {
      started.push("Start");
      return Promise.resolve("a");
    }),
    flight.run("url|N/A", () => {
      started.push("N/A");
      return Promise.resolve("b");
    }),
  ]);

  assertEquals(started.sort(), ["N/A", "Start"]);
  assertEquals(results, ["a", "b"]);
});

Deno.test("singleFlight - a burst of identical submissions runs once", async () => {
  const flight = createSingleFlight<number>();
  const first = gate<number>();
  let starts = 0;

  const joined = Array.from(
    { length: 20 },
    () =>
      flight.run("playlist-1", () => {
        starts++;
        return first.promise;
      }),
  );

  assertEquals(starts, 1);
  first.release(42);
  assertEquals(await Promise.all(joined), Array(20).fill(42));
});
