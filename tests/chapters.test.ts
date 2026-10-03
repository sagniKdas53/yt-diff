import { assertEquals } from "std/assert/mod.ts";
import { parseChapters } from "../src/handlers/pipeline/chapters.ts";

/**
 * The parse is pinned against a real `ffprobe -show_chapters -of json`
 * document, captured from a file written with three chapters. The fields are
 * strings in a fixed format, and a hand-written fixture would have been
 * written to suit the parser rather than to describe what ffprobe prints.
 */

const ffprobeOutput = JSON.parse(
  await Deno.readTextFile("tests/fixtures/ffprobe-chapters.json"),
);

Deno.test("chapters - the captured ffprobe document reads as three chapters", () => {
  const chapters = parseChapters(ffprobeOutput);
  assertEquals(chapters.length, 3);
  assertEquals(chapters[0], { start: 0, end: 45, title: "Opening" });
  assertEquals(chapters[1], {
    start: 45,
    end: 132,
    title: "The part everyone came for",
  });
  assertEquals(chapters[2], { start: 132, end: 180, title: "Wrap-up" });
});

Deno.test("chapters - a file with none is an empty list, not a failure", () => {
  // The common case, and the reason this cannot throw: most files have no
  // chapters and the download must not care.
  assertEquals(parseChapters({ chapters: [] }), []);
  assertEquals(parseChapters({}), []);
  assertEquals(parseChapters(null), []);
});

Deno.test("chapters - an unusable start is dropped rather than placed at zero", () => {
  // An unplaced chapter would show up as a title at the very beginning of the
  // video, which is worse than not showing it at all.
  const chapters = parseChapters({
    chapters: [
      { start_time: "N/A", end_time: "10.000000", tags: { title: "Bad" } },
      {
        start_time: "10.000000",
        end_time: "20.000000",
        tags: { title: "Good" },
      },
    ],
  });
  assertEquals(chapters, [{ start: 10, end: 20, title: "Good" }]);
});

Deno.test("chapters - a missing end is filled in from the next chapter", () => {
  const chapters = parseChapters({
    chapters: [
      { start_time: "0.000000", tags: { title: "One" } },
      { start_time: "5.000000", tags: { title: "Two" } },
    ],
  });
  assertEquals(chapters, [
    { start: 0, end: 5, title: "One" },
    { start: 5, end: 5, title: "Two" },
  ]);
});

Deno.test("chapters - an untitled chapter is kept, not thrown away", () => {
  // A chapter with no title is still a boundary the seek bar draws and the
  // transcript can list; losing it would shorten the video's own structure.
  const chapters = parseChapters({
    chapters: [{ start_time: "3.500000", end_time: "9.000000", tags: {} }],
  });
  assertEquals(chapters, [{ start: 3.5, end: 9, title: "" }]);
});
