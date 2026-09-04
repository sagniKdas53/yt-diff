import { assert, assertEquals } from "std/assert/mod.ts";
import {
  addPlaylist,
  createPlaylistRecord,
} from "../src/handlers/pipeline/playlist-records.ts";
import { PlaylistMetadata } from "../src/db/models.ts";
import { config } from "../src/config.ts";
import { streamLines, streamTextChunks } from "../src/utils/streams.ts";
import type { ManagedProcess } from "../src/handlers/pipeline/types.ts";
import type { YtDlpLaunchSpec } from "../src/handlers/pipeline/ytdlp.ts";

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
  title: string;
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
      title: opts.defaults.title,
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

/**
 * A stand-in for one `yt-dlp` probe, with a pipe that behaves like a pipe.
 *
 * The single property that matters: `status` does not resolve while stdout
 * still holds bytes nobody has read. That is the kernel's behaviour, it is
 * what wedged the listing semaphore for an hour on 2026-09-04, and it is the
 * thing a fake that simply resolves would hide. The process ends when the
 * reader cancels the pipe or when it is killed — nothing else.
 */
interface ProbeScript {
  /** Lines the probe writes to stdout, newline-terminated for the reader. */
  stdout: string[];
  stderr?: string[];
  exitCode?: number;
  /** True for a probe that finishes writing and exits by itself. */
  endsOnItsOwn?: boolean;
}

interface ProbeRecord {
  flags: string[];
  killed: boolean;
  killSignals: string[];
  stdoutCancelled: boolean;
}

function fakeLauncher(scripts: ProbeScript[]) {
  const encoder = new TextEncoder();
  const launched: ProbeRecord[] = [];

  function build(script: ProbeScript, record: ProbeRecord): ManagedProcess {
    let resolveStatus!: (status: Deno.CommandStatus) => void;
    const status = new Promise<Deno.CommandStatus>((resolve) => {
      resolveStatus = resolve;
    });

    let exited = false;
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let stderrController: ReadableStreamDefaultController<Uint8Array> | null =
      null;

    const closeQuietly = (
      controller: ReadableStreamDefaultController<Uint8Array> | null,
    ) => {
      try {
        controller?.close();
      } catch {
        // Already closed or cancelled; either way the pipe is shut.
      }
    };

    const exit = (signal: Deno.Signal | null) => {
      if (exited) return;
      exited = true;
      closeQuietly(stdoutController);
      closeQuietly(stderrController);
      const code = signal ? 143 : (script.exitCode ?? 0);
      resolveStatus({ success: code === 0, code, signal });
    };

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
        for (const line of script.stdout) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        if (script.endsOnItsOwn) exit(null);
      },
      cancel() {
        record.stdoutCancelled = true;
        exit(null);
      },
    });

    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        stderrController = controller;
        for (const line of script.stderr ?? []) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        if (script.endsOnItsOwn) closeQuietly(controller);
      },
      cancel() {},
    });

    return {
      pid: 4242 + launched.length,
      get killed() {
        return record.killed;
      },
      stdout,
      stderr,
      status,
      kill(signal: Deno.Signal = "SIGTERM") {
        record.killed = true;
        record.killSignals.push(signal);
        exit(signal);
        return true;
      },
    };
  }

  const launchYtDlp = (spec: YtDlpLaunchSpec) => {
    const script = scripts[launched.length] ??
      { stdout: [], endsOnItsOwn: true };
    const record: ProbeRecord = {
      flags: spec.flags,
      killed: false,
      killSignals: [],
      stdoutCancelled: false,
    };
    launched.push(record);
    return { process: build(script, record), args: spec.flags };
  };

  return { launchYtDlp, launched };
}

function probeDeps(scripts: ProbeScript[]) {
  const { launchYtDlp, launched } = fakeLauncher(scripts);
  const statusCalls: { key: string; status: string }[] = [];
  return {
    launched,
    statusCalls,
    deps: {
      launchYtDlp,
      streamLines,
      streamTextChunks,
      setProcessStatus: (key: string, status: string) => {
        statusCalls.push({ key, status });
        return true;
      },
    } as unknown as Parameters<typeof addPlaylist>[0],
  };
}

/** Fails loudly instead of hanging when a probe wedges. */
async function within<T>(
  ms: number,
  label: string,
  work: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

Deno.test("addPlaylist - a probe that keeps writing after the first line does not wedge", async () => {
  // The 2026-09-04 incident, in one test. yt-dlp had written item 1's JSON,
  // the reader took it and left, and item 5's 600 KB filled the pipe: the
  // probe blocked in write(), `status` never resolved, and the one listing
  // slot stayed held for an hour. The stdout here never ends on its own, so
  // the only way this returns is if leaving the read closes the pipe.
  const { rows, restore } = installTable();
  const { deps, launched } = probeDeps([{
    stdout: [
      '{"title":"MMD Lo-Chan (Type.LO)"}',
      `{"padding":"${"x".repeat(2048)}"}`,
    ],
  }]);

  try {
    await within(
      2000,
      "addPlaylist",
      addPlaylist(deps, "https://www.youtube.com/playlist?list=PL1", "N/A"),
    );

    assertEquals(rows.length, 1);
    assertEquals(rows[0].title, "MMD Lo-Chan (Type.LO)");
    assert(launched[0].stdoutCancelled, "the unread pipe must be cancelled");
    assert(launched[0].killed, "and the probe itself must be stopped");
  } finally {
    restore();
  }
});

Deno.test("addPlaylist - the cheap flat probe answers on its own", async () => {
  // One `--flat-playlist` object, not five video dumps: the old probe pulled
  // roughly 600 KB of format tables per item to read one string.
  const { rows, restore } = installTable();
  const { deps, launched } = probeDeps([{
    stdout: ['{"title":"Flat Title"}'],
    endsOnItsOwn: true,
  }]);

  try {
    await within(
      2000,
      "addPlaylist",
      addPlaylist(deps, "https://www.youtube.com/playlist?list=PL1", "N/A"),
    );

    assertEquals(launched.length, 1);
    assert(launched[0].flags.includes("--flat-playlist"));
    assert(launched[0].flags.includes("--dump-single-json"));
    assertEquals(rows[0].title, "Flat Title");
  } finally {
    restore();
  }
});

Deno.test("addPlaylist - no flat title falls back to the per-item probe", async () => {
  // Extractors that expose no playlist-level title still put playlist_title on
  // each entry, so the heavier probe is what answers for them.
  const { rows, restore } = installTable();
  const { deps, launched } = probeDeps([
    { stdout: ["{}"], endsOnItsOwn: true },
    {
      stdout: ['{"playlist_title":"From The Items","title":"Video One"}'],
      endsOnItsOwn: true,
    },
  ]);

  try {
    await within(
      2000,
      "addPlaylist",
      addPlaylist(deps, "https://www.iwara.tv/profile/akomni/videos", "N/A"),
    );

    assertEquals(launched.length, 2);
    assert(launched[1].flags.includes("--ignore-errors"));
    assertEquals(launched[1].flags.includes("--flat-playlist"), false);
    // playlist_title wins over the entry's own title.
    assertEquals(rows[0].title, "From The Items");
  } finally {
    restore();
  }
});

Deno.test("addPlaylist - a probe past its deadline is killed, not retried", async () => {
  // A site slow enough to miss the deadline is not one to ask a heavier
  // question of, and the row still has to get made.
  const { rows, restore } = installTable();
  const originalTimeout = config.queue.titleProbeTimeout;
  config.queue.titleProbeTimeout = 50;
  // Writes nothing and never exits: the deadline is the only way out.
  const { deps, launched } = probeDeps([{ stdout: [] }]);

  try {
    await within(
      2000,
      "addPlaylist",
      addPlaylist(deps, "https://www.youtube.com/playlist?list=PL1", "N/A"),
    );

    assertEquals(launched.length, 1);
    assert(launched[0].killed, "the deadline must terminate the probe");
    // urlToTitle's answer for a playlist URL with no usable path segments.
    assertEquals(rows[0].title, "https://www.youtube.com/playlist?list=PL1");
  } finally {
    config.queue.titleProbeTimeout = originalTimeout;
    restore();
  }
});

Deno.test("addPlaylist - the probe is registered against the listing's entry", async () => {
  // Untracked was how the wedged probe stayed invisible: the cleanup job saw
  // a "pending" row with no process attached and walked past it, twice.
  const { restore } = installTable();
  const { deps, statusCalls } = probeDeps([{
    stdout: ['{"title":"Tracked"}'],
    endsOnItsOwn: true,
  }]);

  try {
    await within(
      2000,
      "addPlaylist",
      addPlaylist(
        deps,
        "https://www.youtube.com/playlist?list=PL1",
        "N/A",
        "pending_https://www.youtube.com/playlist?list=PL1_1",
      ),
    );

    assertEquals(statusCalls, [{
      key: "pending_https://www.youtube.com/playlist?list=PL1_1",
      status: "running",
    }]);
  } finally {
    restore();
  }
});

Deno.test("addPlaylist - stderr is drained while stdout is read", async () => {
  // Both drains and the exit status are awaited together; a probe whose only
  // output is diagnostics must still reach the URL-derived fallback.
  const { rows, restore } = installTable();
  const { deps } = probeDeps([
    {
      stdout: [],
      stderr: ["ERROR: [youtube] abc: Sign in to confirm your age."],
      exitCode: 1,
      endsOnItsOwn: true,
    },
    {
      stdout: [],
      stderr: ["ERROR: [youtube] abc: Sign in to confirm your age."],
      exitCode: 1,
      endsOnItsOwn: true,
    },
  ]);

  try {
    await within(
      2000,
      "addPlaylist",
      addPlaylist(deps, "https://example.com/channel/some-channel", "N/A"),
    );

    assertEquals(rows[0].title, "some-channel");
  } finally {
    restore();
  }
});
