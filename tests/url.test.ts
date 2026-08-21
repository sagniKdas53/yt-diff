import { assertEquals } from "std/assert/mod.ts";
import { appendUrlArg, isHttpUrl } from "../src/utils/url.ts";

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
