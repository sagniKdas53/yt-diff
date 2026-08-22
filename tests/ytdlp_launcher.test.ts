// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "std/assert/mod.ts";
import { createYtDlpLauncher } from "../src/handlers/pipeline/ytdlp.ts";

/** Records every argv it is handed, and hands back a process-shaped stub. */
function recordingLauncher(siteArgs: string[] = []) {
  const spawned: string[][] = [];
  const launch = createYtDlpLauncher({
    buildSiteArgs: () => siteArgs,
    spawnPythonProcess: ((args: string[]) => {
      spawned.push(args);
      return { pid: 1 } as any;
    }) as any,
  });
  return { launch, spawned };
}

Deno.test("launchYtDlp - the URL lands last, behind a literal --", () => {
  const { launch } = recordingLauncher();
  const { args } = launch({
    url: "https://example.com/watch?v=1",
    flags: ["--dump-json", "--no-download"],
    reason: "test",
  });

  assertEquals(args[args.length - 2], "--");
  assertEquals(args[args.length - 1], "https://example.com/watch?v=1");
});

Deno.test("launchYtDlp - a URL that looks like a flag cannot become one", () => {
  // C1's invariant, now held for every call site rather than three by hand.
  // A row poisoned before that fix still reads as a URL because `--` has
  // already closed option parsing by the time yt-dlp reaches it.
  const { launch } = recordingLauncher();
  const { args } = launch({
    url: "--config-location=/tmp/evil",
    flags: ["--dump-json"],
    reason: "test",
  });

  assertEquals(args[args.length - 2], "--");
  assertEquals(args[args.length - 1], "--config-location=/tmp/evil");
});

Deno.test("launchYtDlp - options precede site args, which precede flags", () => {
  const { launch } = recordingLauncher(["--proxy", "http://proxy:8080"]);
  const { args } = launch({
    url: "https://example.com/v",
    options: ["--progress", "--embed-metadata"],
    flags: ["-P", "home:/downloads"],
    reason: "test",
  });

  assertEquals(args, [
    "--progress",
    "--embed-metadata",
    "--proxy",
    "http://proxy:8080",
    "-P",
    "home:/downloads",
    "--",
    "https://example.com/v",
  ]);
});

Deno.test("launchYtDlp - spawns exactly the argv it reports", () => {
  // The three hand-rolled builders each rendered their own command string for
  // the log; the download one omitted the option block's quoting, so what was
  // logged and what ran could differ.
  const { launch, spawned } = recordingLauncher(["--cookies", "/c.txt"]);
  const { args } = launch({
    url: "https://example.com/v",
    options: ["--progress"],
    flags: ["-P", "home:/downloads"],
    reason: "test",
  });

  assertEquals(spawned.length, 1);
  assertEquals(spawned[0], args);
});

Deno.test("launchYtDlp - an empty site-arg list adds nothing", () => {
  const { launch } = recordingLauncher([]);
  const { args } = launch({
    url: "https://example.com/v",
    flags: ["--dump-json"],
    reason: "test",
  });

  assertEquals(args, ["--dump-json", "--", "https://example.com/v"]);
  assert(!args.includes(""));
});
