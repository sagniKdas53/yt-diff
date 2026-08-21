import { assertEquals } from "std/assert/mod.ts";
import {
  truncateText,
  urlToTitle,
} from "../src/handlers/pipeline/process-manager.ts";

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
