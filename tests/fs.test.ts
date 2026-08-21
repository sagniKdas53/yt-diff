import { assertEquals } from "std/assert/mod.ts";
import { exists, isFile, mkdir, readdir, rm, unlink } from "../src/utils/fs.ts";
import { join } from "../src/utils/path.ts";

Deno.test("fs - exists detects files and directories", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await exists(tempDir), true);
    assertEquals(await exists(join(tempDir, "non_existent")), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("fs - mkdir creates directories recursively", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const nested = join(tempDir, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    assertEquals(await exists(nested), true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("fs - readdir lists directory contents", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(tempDir, "file1.txt"), "hello");
    await Deno.writeTextFile(join(tempDir, "file2.txt"), "world");
    const files = await readdir(tempDir);
    assertEquals(files.includes("file1.txt"), true);
    assertEquals(files.includes("file2.txt"), true);
    assertEquals(files.length, 2);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("fs - unlink removes files", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const filePath = join(tempDir, "test.txt");
    await Deno.writeTextFile(filePath, "temp content");
    assertEquals(await exists(filePath), true);

    await unlink(filePath);
    assertEquals(await exists(filePath), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("fs - rm deletes directories recursively", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const nested = join(tempDir, "a", "b");
    await mkdir(nested, { recursive: true });
    await Deno.writeTextFile(join(nested, "file.txt"), "hello");

    await rm(join(tempDir, "a"), { recursive: true });
    assertEquals(await exists(join(tempDir, "a")), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("fs - isFile separates files from directories", async () => {
  const root = await Deno.makeTempDir();
  const filePath = `${root}/clip.mp4`;
  const dirPath = `${root}/Some Playlist`;

  await Deno.writeTextFile(filePath, "data");
  await Deno.mkdir(dirPath);

  try {
    assertEquals(await isFile(filePath), true);
    // exists() is true here too, which is exactly why the signed-URL paths
    // cannot use it: minting a link for a directory sends a Content-Length
    // taken from the directory entry and then fails EISDIR mid-body.
    assertEquals(await exists(dirPath), true);
    assertEquals(await isFile(dirPath), false);
    assertEquals(await isFile(`${root}/absent.mp4`), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
