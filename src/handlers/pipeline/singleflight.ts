/**
 * Collapses concurrent requests for the same work onto one execution.
 *
 * The listing path needed this and did not have it. Downloads did: an entry
 * goes into `downloadProcesses` *before* the semaphore is acquired, so
 * `downloadItemsConcurrently` can see queued downloads and filter duplicates
 * against them. Listing acquires the semaphore first and registers afterwards,
 * so a queued listing is invisible to everything — and on 2026-09-04 the same
 * playlist was submitted twice, twenty-one seconds apart, and both went into
 * the queue. The second run found the playlist already present at the same
 * watch mode, returned "No items found", and surfaced in the UI as a failure
 * of a listing that had in fact just succeeded.
 *
 * Joining rather than rejecting is what makes this invisible to callers: the
 * second caller awaits the first's promise and gets the real result, instead
 * of an error it would have to explain or a silently dropped entry that would
 * shift every later index in the results array.
 */
export function createSingleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>();

  return {
    /**
     * Runs `work`, or joins the run already under way for `key`.
     *
     * The cleanup is attached before the entry is recorded, which is safe
     * because a `finally` callback cannot run before the synchronous code
     * that follows it — so the delete can never outrun its own set.
     */
    run(key: string, work: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) return existing;

      const started = work().finally(() => {
        if (inFlight.get(key) === started) {
          inFlight.delete(key);
        }
      });
      inFlight.set(key, started);
      return started;
    },

    /** How many distinct pieces of work are running or queued. */
    get size(): number {
      return inFlight.size;
    },

    /** True when `key` is already running or queued. */
    has(key: string): boolean {
      return inFlight.has(key);
    },

    /**
     * Releases a key while its run is still going.
     *
     * A pause needs this: the run it killed is still in flight when the kill
     * lands, and a resume arriving before it settles would join the dying run
     * and silently do nothing. The cleanup in `run` is identity-guarded, so an
     * abandoned run finishing later cannot delete its replacement's entry.
     */
    forget(key: string): void {
      inFlight.delete(key);
    },
  };
}

export type SingleFlight<T> = ReturnType<typeof createSingleFlight<T>>;
