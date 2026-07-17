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
