import { logger } from "../../logger.ts";
import { exists } from "../../utils/fs.ts";
import { basename } from "../../utils/path.ts";

/**
 * Chapters, as the player needs them.
 *
 * `--embed-chapters` has been in the download options since before any of
 * this, so every file downloaded so far already carries its chapters in the
 * container. Nothing could read them: a browser does not expose embedded
 * chapters to a `<video>` element, and the infojson they would come from is
 * not fetched. ffprobe can, and it ships in the image beside yt-dlp.
 *
 * Extracted at discovery time rather than at play time — one sub-second
 * process per download, against a file the pipeline has just written and is
 * already holding open.
 */
export interface Chapter {
  /** Seconds from the start of the file. */
  start: number;
  /** Seconds to the start of the next chapter, or to the end of the file. */
  end: number;
  title: string;
}

/** One chapter as ffprobe reports it. */
interface FfprobeChapter {
  start_time?: string;
  end_time?: string;
  tags?: { title?: string };
}

/** Only what `parseChapters` reads out of ffprobe's JSON. */
interface FfprobeOutput {
  chapters?: FfprobeChapter[];
}

/** How long to wait for one ffprobe before giving up on it. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Maps ffprobe's chapter list onto the player's shape.
 *
 * Exported for its own sake: it is pure, it is the part that can be wrong
 * without touching the disk, and the numbers ffprobe prints are strings in
 * several formats ("12.5", "00:00:12.500000", "N/A").
 *
 * A chapter with no usable start is dropped rather than placed at zero: an
 * unplaced chapter would show up as a title at the beginning of the video,
 * which is worse than not showing it.
 *
 * @param output - ffprobe's `-show_chapters -of json` document
 * @returns Chapters in file order
 */
export function parseChapters(output: unknown): Chapter[] {
  const chapters = (output as FfprobeOutput | null)?.chapters;
  if (!Array.isArray(chapters)) {
    return [];
  }

  const parsed: Chapter[] = [];
  for (const chapter of chapters) {
    const start = toSeconds(chapter?.start_time);
    if (start === null) {
      continue;
    }
    const end = toSeconds(chapter?.end_time);
    parsed.push({
      start,
      // ffprobe reports the end of the last chapter as the end of the file,
      // and sometimes leaves it empty. Either way the player only needs the
      // next chapter's start to draw the mark, so a missing end is filled in
      // from the next chapter below.
      end: end ?? start,
      title: (chapter?.tags?.title ?? "").trim(),
    });
  }

  for (let i = 0; i < parsed.length - 1; i++) {
    if (parsed[i].end <= parsed[i].start) {
      parsed[i].end = parsed[i + 1].start;
    }
  }

  return parsed;
}

/**
 * Reads one of ffprobe's time fields.
 *
 * @returns Seconds, or null when the field is absent or unparseable
 */
function toSeconds(value: string | undefined): number | null {
  if (typeof value !== "string" || value.trim() === "" || value === "N/A") {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Reads the chapters out of one downloaded file.
 *
 * Returns an empty list for anything that has none: a video without chapters
 * is the normal case, not a failure, and so is a file ffprobe will not read.
 * The caller stores the result either way, so "no chapters" is recorded once
 * rather than re-probed on every later download of the same video.
 *
 * @param filePath - Absolute path to the media file
 * @param run - Runs a command and resolves with its stdout, for tests
 */
export async function readChapters(
  filePath: string,
  run: RunCommand = defaultRun,
): Promise<Chapter[]> {
  if (!(await exists(filePath))) {
    return [];
  }

  try {
    const stdout = await run([
      "ffprobe",
      "-v",
      "error",
      "-show_chapters",
      "-of",
      "json",
      filePath,
    ]);
    const chapters = parseChapters(JSON.parse(stdout));
    logger.debug("Read chapters from file", {
      file: basename(filePath),
      count: chapters.length,
    });
    return chapters;
  } catch (error) {
    logger.debug("Could not read chapters from file", {
      file: basename(filePath),
      error: (error as Error).message,
    });
    return [];
  }
}

/** Runs a command and resolves with its stdout. */
export type RunCommand = (args: string[]) => Promise<string>;

const decoder = new TextDecoder();

const defaultRun: RunCommand = (args) => {
  const [command, ...rest] = args;
  return new Promise<string>((resolve, reject) => {
    const child = new Deno.Command(command, {
      args: rest,
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; the rejection below is the answer either way.
      }
      reject(new Error(`${command} timed out`));
    }, PROBE_TIMEOUT_MS);

    void (async () => {
      try {
        const output = await child.output();
        clearTimeout(timer);
        if (!output.success) {
          reject(new Error(`${command} exited with code ${output.code}`));
          return;
        }
        resolve(decoder.decode(output.stdout));
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
};
