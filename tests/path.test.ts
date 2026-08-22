import { assertEquals } from "std/assert/mod.ts";
import {
  basename,
  extname,
  isAbsolute,
  isWithinPath,
  join,
  normalize,
  relative,
  resolve,
  resolveWithin,
} from "../src/utils/path.ts";

Deno.test("path - isAbsolute checks absolute status", () => {
  assertEquals(isAbsolute("/home/user"), true);
  assertEquals(isAbsolute("relative/path"), false);
  assertEquals(isAbsolute(""), false);
});

Deno.test("path - normalize cleans up path segments", () => {
  assertEquals(normalize("/a/b/../c"), "/a/c");
  assertEquals(normalize("a/b/./c/"), "a/b/c");
  assertEquals(normalize(""), ".");
});

Deno.test("path - join combines segments safely", () => {
  assertEquals(join("a", "b", "c"), "a/b/c");
  assertEquals(join("a/", "/b", "c"), "a/b/c");
  assertEquals(join("", "a", ""), "a");
});

Deno.test("path - resolve computes absolute paths", () => {
  const cwd = Deno.cwd();
  assertEquals(resolve("a", "b"), `${cwd}/a/b`);
  assertEquals(resolve("/absolute", "path"), "/absolute/path");
});

Deno.test("path - basename extracts last segment", () => {
  assertEquals(basename("/a/b/file.txt"), "file.txt");
  assertEquals(basename("/a/b/"), "b");
  assertEquals(basename("/"), "/");
});

Deno.test("path - extname extracts file extension", () => {
  assertEquals(extname("file.txt"), ".txt");
  assertEquals(extname("file.tar.gz"), ".gz");
  assertEquals(extname("no_ext"), "");
  assertEquals(extname(".gitignore"), "");
});

Deno.test("path - relative computes path distance", () => {
  assertEquals(relative("/a/b", "/a/b/c/d"), "c/d");
  assertEquals(relative("/a/b/c", "/a/b"), "..");
});

Deno.test("path - isWithinPath prevents path traversals", () => {
  assertEquals(isWithinPath("/app/save", "/app/save/playlist/video.mp4"), true);
  assertEquals(isWithinPath("/app/save", "/app/save/../traversal"), false);
  assertEquals(isWithinPath("/app/save", "/other/path"), false);
});

Deno.test("path - resolveWithin resolves paths under the root", () => {
  assertEquals(
    resolveWithin("/app/save", "Some Playlist", "video.mp4"),
    "/app/save/Some Playlist/video.mp4",
  );
  // An empty segment is the common case: videos outside any playlist store
  // saveDirectory as "".
  assertEquals(
    resolveWithin("/app/save", "", "video.mp4"),
    "/app/save/video.mp4",
  );
  assertEquals(resolveWithin("/app/save"), "/app/save");
});

Deno.test("path - resolveWithin refuses paths that escape the root", () => {
  // join() collapses these silently, which is what let the delete paths build
  // them without noticing. S3: the read path caught it, the destructive paths
  // did not.
  assertEquals(resolveWithin("/app/save", "..", "etc"), null);
  assertEquals(resolveWithin("/app/save", "../../etc", "passwd"), null);
  assertEquals(resolveWithin("/app/save", "playlist/../../../etc"), null);
  // A sibling whose name merely starts with the root's is not inside it.
  assertEquals(resolveWithin("/app/save", "../saved/x"), null);
});

Deno.test("path - resolveWithin confines an absolute segment rather than obeying it", () => {
  // This join() does not let a leading slash reset the path the way
  // node's path.resolve would, so an absolute-looking saveDirectory lands
  // under the root instead of escaping to it. Pinned because the containment
  // guarantee reads differently if that ever changes.
  assertEquals(
    resolveWithin("/app/save", "/etc", "passwd"),
    "/app/save/etc/passwd",
  );
});

Deno.test("path - resolveWithin counts the root itself as inside", () => {
  // Deliberate, and the reason the recursive cleanup rejects it separately:
  // an empty saveDirectory names the whole library, not a playlist folder.
  assertEquals(resolveWithin("/app/save", ""), "/app/save");
  assertEquals(resolveWithin("/app/save", "playlist", ".."), "/app/save");
});
