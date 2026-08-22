import { assertEquals } from "std/assert/mod.ts";
import { chunkPlaylistLines } from "../src/handlers/pipeline/chunks.ts";

async function* stream(lines: string[]) {
  for (const line of lines) yield line;
}

async function collect(
  lines: string[],
  chunkSize: number,
  startIndex?: number,
) {
  const out: { items: string[]; startIndex: number }[] = [];
  for await (
    const chunk of chunkPlaylistLines(stream(lines), chunkSize, startIndex)
  ) {
    out.push(chunk);
  }
  return out;
}

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line${i + 1}`);

Deno.test("chunkPlaylistLines - offsets are 1-based and contiguous", async () => {
  // positionInPlaylist is written straight from startIndex, so an off-by-one
  // here silently renumbers a whole playlist.
  const chunks = await collect(lines(6), 2);
  assertEquals(chunks.map((c) => c.startIndex), [1, 3, 5]);
  assertEquals(chunks[0].items, ["line1", "line2"]);
  assertEquals(chunks[2].items, ["line5", "line6"]);
});

Deno.test("chunkPlaylistLines - the trailing partial chunk is yielded", async () => {
  const chunks = await collect(lines(7), 3);
  assertEquals(chunks.map((c) => c.items.length), [3, 3, 1]);
  assertEquals(chunks.map((c) => c.startIndex), [1, 4, 7]);
});

Deno.test("chunkPlaylistLines - an exact multiple leaves no trailing chunk", async () => {
  const chunks = await collect(lines(6), 3);
  assertEquals(chunks.length, 2);
  assertEquals(chunks.map((c) => c.startIndex), [1, 4]);
});

Deno.test("chunkPlaylistLines - an empty stream yields nothing", async () => {
  assertEquals(await collect([], 3), []);
});

Deno.test("chunkPlaylistLines - fewer lines than a chunk still yield one", async () => {
  const chunks = await collect(lines(2), 10);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].startIndex, 1);
  assertEquals(chunks[0].items.length, 2);
});

Deno.test("chunkPlaylistLines - a resumed walk counts from where it resumed", async () => {
  // "End" mode rewinds one chunk from the last recorded position rather than
  // starting at the top, so the offsets have to start there too.
  const chunks = await collect(lines(5), 2, 101);
  assertEquals(chunks.map((c) => c.startIndex), [101, 103, 105]);
});

Deno.test("chunkPlaylistLines - a non-positive size does not buffer everything", async () => {
  // Guards a misconfigured chunkSize: yielding one chunk of the entire
  // playlist would defeat the progressive ingest the whole path is built on.
  const chunks = await collect(lines(3), 0);
  assertEquals(chunks.map((c) => c.items.length), [1, 1, 1]);
  assertEquals(chunks.map((c) => c.startIndex), [1, 2, 3]);
});

Deno.test("chunkPlaylistLines - each chunk is its own array", async () => {
  // The consumer holds a chunk across an await while the generator keeps
  // filling; reusing one buffer would hand it items it has already ingested.
  const chunks = await collect(lines(4), 2);
  chunks[0].items.push("mutated");
  assertEquals(chunks[1].items, ["line3", "line4"]);
});
