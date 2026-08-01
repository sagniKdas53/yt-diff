import { assertEquals } from "std/assert/mod.ts";
import {
  canonicalizePlaylistUrl,
  canonicalizeVideoUrl,
} from "../src/handlers/pipeline/dedup.ts";

Deno.test("dedup - canonicalizeVideoUrl standardizes YouTube videos", () => {
  // Shorts
  assertEquals(
    canonicalizeVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  // youtu.be
  assertEquals(
    canonicalizeVideoUrl("https://youtu.be/dQw4w9WgXcQ"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  // standard watch with list query removed
  assertEquals(
    canonicalizeVideoUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc",
    ),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

Deno.test("dedup - canonicalizeVideoUrl standardizes Iwara videos", () => {
  assertEquals(
    canonicalizeVideoUrl("https://iwara.tv/video/12345/some-title-slug"),
    "https://iwara.tv/video/12345",
  );
});

Deno.test("dedup - canonicalizeVideoUrl standardizes Spankbang videos", () => {
  assertEquals(
    canonicalizeVideoUrl("https://spankbang.com/abcde/video/some-slug"),
    "https://spankbang.com/abcde/video",
  );
});

Deno.test("dedup - canonicalizeVideoUrl standardizes Pornhub videos", () => {
  assertEquals(
    canonicalizeVideoUrl(
      "https://www.pornhub.com/view_video.php?viewkey=ph12345&other=garbage",
    ),
    "https://www.pornhub.com/view_video.php?viewkey=ph12345",
  );
});

Deno.test("dedup - canonicalizeVideoUrl standardizes X/Twitter links", () => {
  assertEquals(
    canonicalizeVideoUrl("https://x.com/user/status/123"),
    "https://x.com/user/status/123?s=20",
  );
});

Deno.test("dedup - canonicalizePlaylistUrl standardizes playlists", () => {
  // YouTube list
  assertEquals(
    canonicalizePlaylistUrl(
      "https://www.youtube.com/playlist?list=PL123&index=4",
    ),
    "https://www.youtube.com/playlist?list=PL123",
  );
  // Iwara
  assertEquals(
    canonicalizePlaylistUrl("https://iwara.tv/playlist/123?sort=date&page=2"),
    "https://iwara.tv/playlist/123",
  );
  // Spankbang
  assertEquals(
    canonicalizePlaylistUrl("https://spankbang.com/abc-nohrcs/playlist"),
    "https://spankbang.com/abc/playlist",
  );
});
