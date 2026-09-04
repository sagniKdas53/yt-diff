// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import {
  createYtDlpLauncher,
  redactSecretArgs,
} from "../src/handlers/pipeline/ytdlp.ts";

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

/**
 * Every yt-dlp launch logs its argv at debug level. For iwara that argv
 * carries `--username`, `--password` and a `--proxy` URL with its own
 * `user:pass@`, so until this was added two live passwords were written to the
 * container log on every listing and download — and travelled onward in any
 * log someone was asked to read.
 *
 * The log line still has to be worth reading, so these pin both halves: the
 * secrets are gone, and everything you would actually diagnose from is not.
 */

Deno.test("redactSecretArgs - credential values are replaced, flags are kept", () => {
  const rendered = redactSecretArgs([
    "--username",
    "real-user",
    "--password",
    's3cr3t}"pass',
    "--playlist-start",
    "1",
  ]);

  assertEquals(rendered, [
    "--username",
    "<redacted>",
    "--password",
    "<redacted>",
    "--playlist-start",
    "1",
  ]);
});

Deno.test("redactSecretArgs - a proxy keeps its host and loses its credentials", () => {
  // The host is the whole reason the proxy is worth logging: it is how you
  // tell a dead proxy from a dead site. Loopback here on purpose: the redactor
  // cannot tell one host from another, and a real proxy address committed to a
  // public repo is its own small leak.
  const rendered = redactSecretArgs([
    "--proxy",
    "http://proxy-user:hunter2@127.0.0.1:3128",
  ]);

  assertEquals(rendered, ["--proxy", "http://<redacted>@127.0.0.1:3128"]);
});

Deno.test("redactSecretArgs - a proxy with no credentials is untouched", () => {
  const rendered = redactSecretArgs(["--proxy", "http://gluetun:3128"]);
  assertEquals(rendered, ["--proxy", "http://gluetun:3128"]);
});

Deno.test("redactSecretArgs - the joined form is redacted too", () => {
  // Not produced today, but the argv is assembled in three places and a log
  // that leaks on a spelling nobody thought about is the point of this.
  assertEquals(
    redactSecretArgs(["--password=s3cr3t", "--proxy=http://u:p@host:3128"]),
    ["--password=<redacted>", "--proxy=http://<redacted>@host:3128"],
  );
});

Deno.test("redactSecretArgs - a trailing credential flag with no value is left alone", () => {
  // Malformed, not a leak. Swallowing it would hide the malformation.
  assertEquals(redactSecretArgs(["--playlist-start", "1", "--password"]), [
    "--playlist-start",
    "1",
    "--password",
  ]);
});

Deno.test("redactSecretArgs - everything not a credential survives verbatim", () => {
  // A redactor that eats the diagnostic content has not helped anyone.
  const args = [
    "--cookies",
    "/run/secrets/cookies.txt",
    "--flat-playlist",
    "--playlist-items",
    "1",
    "--dump-single-json",
    "--no-download",
    "--",
    "https://www.iwara.tv/profile/muta81/videos",
  ];
  assertEquals(redactSecretArgs(args), args);
});

Deno.test("launchYtDlp - the logged command carries no password", () => {
  // The end-to-end guarantee: whatever buildSiteArgs contributes, the string
  // that reaches the logger is clean, while the argv actually spawned is not —
  // redacting the real arguments would launch yt-dlp unauthenticated.
  const { launch, spawned } = recordingLauncher([
    "--username",
    "real-user",
    "--password",
    "hunter2",
    "--proxy",
    "http://proxy-user:proxypass@127.0.0.1:3128",
  ]);

  const { args } = launch({
    url: "https://www.iwara.tv/profile/muta81/videos",
    flags: ["--dump-json"],
    reason: "test",
  });

  assert(spawned[0].includes("hunter2"), "the spawned argv keeps the password");
  assert(args.includes("hunter2"), "and so does the returned argv");

  const rendered = redactSecretArgs(args).join(" ");
  assert(!rendered.includes("hunter2"), "the password must not be rendered");
  assert(!rendered.includes("proxypass"), "nor the proxy password");
  assert(!rendered.includes("real-user"), "nor the username");
  assertStringIncludes(rendered, "127.0.0.1:3128");
  assertStringIncludes(rendered, "https://www.iwara.tv/profile/muta81/videos");
});
