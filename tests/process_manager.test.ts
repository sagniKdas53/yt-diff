import { assertEquals } from "std/assert/mod.ts";
import {
  hasEphemeralThumbnails,
  isSiteXDotCom,
  normalizeUrl,
  truncateText,
  urlToTitle,
} from "../src/handlers/pipeline/process-manager.ts";

Deno.test("process-manager - normalizeUrl cleans tracking and standardizes YouTube", () => {
  // YouTube watch cleanups
  assertEquals(
    normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s&list=abc"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  // YouTube shorts cleanup
  assertEquals(
    normalizeUrl("https://youtube.com/shorts/dQw4w9WgXcQ?feature=share"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  // YouTube channels video path append
  assertEquals(
    normalizeUrl("https://www.youtube.com/@some_creator"),
    "https://www.youtube.com/@some_creator/videos",
  );
  // generic force https
  assertEquals(
    normalizeUrl("http://example.com/some/path/"),
    "https://example.com/some/path",
  );
});

Deno.test("process-manager - urlToTitle extracts path slug as title", () => {
  assertEquals(
    urlToTitle("https://www.youtube.com/channel/some-channel"),
    "some-channel",
  );
  assertEquals(
    urlToTitle("https://example.com/nested/path/slug"),
    "nested_path_slug",
  );
  assertEquals(
    urlToTitle("invalid-url"),
    "invalid-url",
  );
});

Deno.test("process-manager - truncateText bounds long text safely", () => {
  assertEquals(truncateText("hello world", 5), "hello");
  assertEquals(truncateText("hello", 10), "hello");
  assertEquals(truncateText("", 10), "");
});

Deno.test("process-manager - isSiteXDotCom detects x.com and subdomains", () => {
  assertEquals(isSiteXDotCom("https://x.com/status/123"), true);
  assertEquals(isSiteXDotCom("https://sub.x.com/post"), true);
  assertEquals(isSiteXDotCom("https://not-x.com"), false);
});

Deno.test("process-manager - hasEphemeralThumbnails identifies transient media sites", () => {
  assertEquals(hasEphemeralThumbnails("https://facebook.com/watch"), true);
  assertEquals(hasEphemeralThumbnails("https://instagram.com/p/123"), true);
  assertEquals(hasEphemeralThumbnails("https://youtube.com/watch"), false);
});
