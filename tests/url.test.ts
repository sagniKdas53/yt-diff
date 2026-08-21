import { assertEquals } from "std/assert/mod.ts";
import { appendUrlArg, isHttpUrl, toHttpUrl } from "../src/utils/url.ts";

Deno.test("url - isHttpUrl accepts only http and https", () => {
  assertEquals(isHttpUrl("https://example.com/watch?v=abc"), true);
  assertEquals(isHttpUrl("http://example.com"), true);

  // Other schemes parse fine but must not reach a yt-dlp argv.
  assertEquals(isHttpUrl("file:///etc/passwd"), false);
  assertEquals(isHttpUrl("data:text/plain,hi"), false);
  assertEquals(isHttpUrl("ftp://example.com/x"), false);
});

Deno.test("url - isHttpUrl rejects flag-shaped strings", () => {
  // These are the C1 payloads: they never parse as a URL, so normalizeUrl
  // returned them untouched and they landed in argv as options.
  assertEquals(isHttpUrl("--config-location=/tmp/planted.conf"), false);
  assertEquals(isHttpUrl("--exec=touch /tmp/pwned"), false);
  assertEquals(isHttpUrl("-o/tmp/out.%(ext)s"), false);
  assertEquals(isHttpUrl(""), false);
  assertEquals(isHttpUrl("not a url at all"), false);
});

Deno.test("url - appendUrlArg puts the URL behind an option terminator", () => {
  assertEquals(
    appendUrlArg(["--dump-json", "--no-download"], "https://example.com/v"),
    ["--dump-json", "--no-download", "--", "https://example.com/v"],
  );
});

Deno.test("url - appendUrlArg leaves the caller's options untouched", () => {
  const options = ["-P", "home:/data"];
  const args = appendUrlArg(options, "https://example.com/v");

  assertEquals(options, ["-P", "home:/data"]);
  assertEquals(args, ["-P", "home:/data", "--", "https://example.com/v"]);
});

Deno.test("url - a flag-shaped URL stays positional after the terminator", () => {
  // Belt and braces: even if something slips past the schema, "--" keeps the
  // value out of yt-dlp's option namespace.
  const args = appendUrlArg(["--dump-json"], "--config-location=/tmp/x");

  assertEquals(args.indexOf("--") < args.length - 1, true);
  assertEquals(args[args.length - 1], "--config-location=/tmp/x");
});

// --- toHttpUrl: the /list and /download boundary ----------------------------
//
// isHttpUrl above is the bot's bar, where a bare word must stay chatter.
// toHttpUrl is the web form's: it parses rather than validates, so a pasted
// URL without a scheme still works, and every accepted value comes back as a
// serialization that starts with a scheme.

Deno.test("toHttpUrl - accepts scheme-less URLs across supported sites", () => {
  // A spread of shapes from yt-dlp's supported-sites list, as a person would
  // paste them out of an address bar.
  const cases: [string, string][] = [
    [
      "youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "www.youtube.com/@creator/videos",
      "https://www.youtube.com/@creator/videos",
    ],
    ["youtu.be/dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ"],
    ["m.youtube.com/shorts/abc123", "https://m.youtube.com/shorts/abc123"],
    [
      "bilibili.com/video/BV1x411c7mD",
      "https://bilibili.com/video/BV1x411c7mD",
    ],
    ["nicovideo.jp/watch/sm9", "https://nicovideo.jp/watch/sm9"],
    ["vimeo.com/123456789", "https://vimeo.com/123456789"],
    ["soundcloud.com/artist/track", "https://soundcloud.com/artist/track"],
    ["twitch.tv/videos/123", "https://twitch.tv/videos/123"],
    ["iwara.tv/video/abc", "https://iwara.tv/video/abc"],
    ["x.com/user/status/123", "https://x.com/user/status/123"],
  ];

  for (const [input, expected] of cases) {
    assertEquals(toHttpUrl(input), expected, `on ${input}`);
  }
});

Deno.test("toHttpUrl - keeps URLs that already carry a scheme", () => {
  assertEquals(
    toHttpUrl("https://example.com/watch?v=1"),
    "https://example.com/watch?v=1",
  );
  // http is preserved here; normalizeUrl forces https further down.
  assertEquals(toHttpUrl("http://example.com/v"), "http://example.com/v");
  assertEquals(toHttpUrl("HTTPS://Example.COM/v"), "https://example.com/v");
});

Deno.test("toHttpUrl - handles hosts, ports, IPs and internationalized names", () => {
  // "example.com:8443/v" parses as scheme "example.com:" on its own, so this
  // is the case that a naive protocol check gets wrong.
  assertEquals(toHttpUrl("example.com:8443/v"), "https://example.com:8443/v");
  assertEquals(toHttpUrl("localhost:8080/v"), "https://localhost:8080/v");
  assertEquals(toHttpUrl("127.0.0.1:3000/v"), "https://127.0.0.1:3000/v");
  assertEquals(toHttpUrl("[::1]:8080/v"), "https://[::1]:8080/v");
  // IDN hosts are punycoded by the URL parser rather than rejected.
  assertEquals(
    toHttpUrl("пример.рф/видео"),
    "https://xn--e1afmkfd.xn--p1ai/%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE",
  );
  assertEquals(
    toHttpUrl("  youtube.com/watch?v=1  "),
    "https://youtube.com/watch?v=1",
  );
});

Deno.test("toHttpUrl - rejects the C1 payloads even though prefixing would parse them", () => {
  // "https://" + "--config-location=/tmp/x" parses, with the flag as the
  // hostname. The leading-hyphen check is what stops it being laundered.
  assertEquals(toHttpUrl("--config-location=/tmp/planted.conf"), null);
  assertEquals(toHttpUrl("--exec=touch /tmp/pwned"), null);
  assertEquals(toHttpUrl("-o/tmp/out.%(ext)s"), null);
  assertEquals(toHttpUrl("  --dump-json  "), null);
});

Deno.test("toHttpUrl - rejects other schemes and non-URL text", () => {
  assertEquals(toHttpUrl("file:///etc/passwd"), null);
  assertEquals(toHttpUrl("file://evil.example/x"), null);
  assertEquals(toHttpUrl("data:text/plain,hi"), null);
  assertEquals(toHttpUrl("javascript:alert(1)"), null);
  assertEquals(toHttpUrl("ftp://example.com/x"), null);
  assertEquals(toHttpUrl("/etc/passwd"), null);
  assertEquals(toHttpUrl("notaurl"), null);
  assertEquals(toHttpUrl("not a url"), null);
  assertEquals(toHttpUrl(""), null);
  assertEquals(toHttpUrl("   "), null);
});

Deno.test("toHttpUrl - rejects yt-dlp's non-URL prefix forms", () => {
  // Deliberate: this app keys playlists by URL, and the account-scoped ones
  // would spend the operator's cookies on behalf of whoever submitted them.
  assertEquals(toHttpUrl("ytsearch:cats"), null);
  assertEquals(toHttpUrl("ytsearch10:cats"), null);
  assertEquals(toHttpUrl(":ytfav"), null);
  assertEquals(toHttpUrl(":ytsubs"), null);
  assertEquals(toHttpUrl(":ythistory"), null);
  assertEquals(toHttpUrl("scsearch:jazz"), null);
  assertEquals(toHttpUrl("bilisearch:cats"), null);
});

Deno.test("toHttpUrl - every accepted value is safe to place in an argv", () => {
  const inputs = [
    "youtube.com/watch?v=1",
    "https://example.com/v",
    "example.com:8443/v",
    "//example.com/v",
    "[::1]:8080/v",
    "user:pass@example.com/v",
  ];

  for (const input of inputs) {
    const normalized = toHttpUrl(input);
    assertEquals(normalized !== null, true, `rejected ${input}`);
    // The output invariant C1 rests on: never mistakable for an option.
    assertEquals(
      normalized!.startsWith("https://") || normalized!.startsWith("http://"),
      true,
      `${input} -> ${normalized}`,
    );
  }
});
