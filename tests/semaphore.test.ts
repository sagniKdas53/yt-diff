import { assertEquals } from "std/assert/mod.ts";
import { Semaphore } from "../src/handlers/pipeline/semaphore.ts";

Deno.test("semaphore - pendingCount is zero while slots are free", async () => {
  const sem = new Semaphore(2, "test");

  assertEquals(sem.pendingCount, 0);
  await sem.acquire();
  assertEquals(sem.pendingCount, 0);
  await sem.acquire();
  // At capacity, but nobody is waiting yet.
  assertEquals(sem.pendingCount, 0);
});

Deno.test("semaphore - pendingCount counts waiters parked behind a full queue", async () => {
  // maxListings defaults to 1, which is the batch re-index case: every item
  // after the first waits, and only pendingCount can see them.
  const sem = new Semaphore(1, "test");
  await sem.acquire();

  const waiters = [sem.acquire(), sem.acquire(), sem.acquire()];
  // Let the queued promises register before asserting.
  await Promise.resolve();

  assertEquals(sem.pendingCount, 3);

  sem.release();
  await waiters[0];
  assertEquals(sem.pendingCount, 2);

  sem.release();
  await waiters[1];
  sem.release();
  await waiters[2];
  assertEquals(sem.pendingCount, 0);
});

Deno.test("semaphore - setMaxConcurrent drains waiters and clears pendingCount", async () => {
  const sem = new Semaphore(1, "test");
  await sem.acquire();

  const waiters = [sem.acquire(), sem.acquire()];
  await Promise.resolve();
  assertEquals(sem.pendingCount, 2);

  sem.setMaxConcurrent(3);
  await Promise.all(waiters);

  assertEquals(sem.pendingCount, 0);
});
