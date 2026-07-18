/**
 * Unit tests for bot-core URL parser.
 *
 * Run: deno test --allow-read bots/core/url-parser.test.ts
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { parseUrl } from "./url-parser.ts";

Deno.test("parseUrl — YouTube Shorts URL", () => {
  const result = parseUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
  assertExists(result);
  assertEquals(result.site, "youtube");
  assertEquals(result.isShorts, true);
  assertEquals(result.isValidVideo, true);
  assertEquals(
    result.canonical,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

Deno.test("parseUrl — YouTube watch URL", () => {
  const result = parseUrl(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assertExists(result);
  assertEquals(result.site, "youtube");
  assertEquals(result.isShorts, false);
  assertEquals(result.isValidVideo, true);
});

Deno.test("parseUrl — youtu.be short URL", () => {
  const result = parseUrl("https://youtu.be/dQw4w9WgXcQ");
  assertExists(result);
  assertEquals(result.site, "youtube");
  assertEquals(result.isValidVideo, true);
  assertEquals(
    result.canonical,
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

Deno.test("parseUrl — YouTube playlist URL is rejected", () => {
  const result = parseUrl(
    "https://www.youtube.com/playlist?list=PL1234567890",
  );
  assertExists(result);
  assertEquals(result.isValidVideo, false);
});

Deno.test("parseUrl — YouTube channel URL is rejected", () => {
  const result = parseUrl("https://www.youtube.com/@somechannel");
  assertExists(result);
  assertEquals(result.isValidVideo, false);
});

Deno.test("parseUrl — x.com status URL", () => {
  const result = parseUrl("https://x.com/user/status/1234567890");
  assertExists(result);
  assertEquals(result.site, "x.com");
  assertEquals(result.isValidVideo, true);
});

Deno.test("parseUrl — x.com non-status URL is rejected", () => {
  const result = parseUrl("https://x.com/user");
  assertExists(result);
  assertEquals(result.site, "x.com");
  assertEquals(result.isValidVideo, false);
});

Deno.test("parseUrl — garbage text returns null", () => {
  const result = parseUrl("hello world no url here");
  assertEquals(result, null);
});

Deno.test("parseUrl — URL with surrounding text extracts URL", () => {
  const result = parseUrl(
    "check this out https://youtu.be/dQw4w9WgXcQ it's cool",
  );
  assertExists(result);
  assertEquals(result.site, "youtube");
  assertEquals(result.isValidVideo, true);
});

Deno.test("parseUrl — m.youtube.com mobile URL", () => {
  const result = parseUrl(
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  assertExists(result);
  assertEquals(result.site, "youtube");
  assertEquals(result.isValidVideo, true);
});

Deno.test("parseUrl — youtube-nocookie.com", () => {
  const result = parseUrl(
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  assertExists(result);
  assertEquals(result.site, "youtube");
  assertEquals(result.isValidVideo, true);
});
