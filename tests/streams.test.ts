import { assert, assertEquals } from "std/assert/mod.ts";
import { streamLines, streamTextChunks } from "../src/utils/streams.ts";

/**
 * The rule these pin is the one whose absence stalled the bot for an hour on
 * 2026-09-04: a consumer that stops reading has to cancel, or the subprocess
 * on the other end of the pipe blocks in `write()` and never exits.
 *
 * The stand-in for a pipe is a stream that is never closed by its producer.
 * A reader that walks away from one without cancelling leaves it open forever,
 * which is exactly what the kernel does with an unread pipe.
 */
function openStream(
  chunks: string[],
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      // Deliberately not closed: the producer is still writing.
    },
    cancel() {
      onCancel();
    },
  });
}

function closedStream(
  chunks: string[],
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
    cancel() {
      onCancel();
    },
  });
}

Deno.test("streamLines - stopping after the first line cancels the stream", async () => {
  let cancelled = false;
  const stream = openStream(
    ['{"first":true}\n', '{"second":true}\n'],
    () => (cancelled = true),
  );

  for await (const line of streamLines(stream)) {
    assertEquals(line, '{"first":true}');
    break;
  }

  assert(cancelled, "walking away from a stream must cancel it");
});

Deno.test("streamLines - returning from the loop cancels the stream", async () => {
  // `return` from inside the loop is how the playlist-title probe leaves, and
  // it closes the generator by a different path than `break` does.
  let cancelled = false;
  const stream = openStream(['{"first":true}\n'], () => (cancelled = true));

  const firstLine = await (async () => {
    for await (const line of streamLines(stream)) {
      return line;
    }
    return null;
  })();

  assertEquals(firstLine, '{"first":true}');
  assert(cancelled, "a return must cancel the stream too");
});

Deno.test("streamLines - a stream read to the end is not cancelled", async () => {
  let cancelled = false;
  const stream = closedStream(["a\nb\n", "c\n"], () => (cancelled = true));

  const lines: string[] = [];
  for await (const line of streamLines(stream)) {
    lines.push(line);
  }

  assertEquals(lines, ["a", "b", "c"]);
  assert(!cancelled, "a stream that ended on its own needs no cancelling");
});

Deno.test("streamLines - lines split across chunks are rejoined", async () => {
  const stream = closedStream(['{"a":1', '}\n{"b":2}\n'], () => {});

  const lines: string[] = [];
  for await (const line of streamLines(stream)) {
    lines.push(line);
  }

  assertEquals(lines, ['{"a":1}', '{"b":2}']);
});

Deno.test("streamLines - a final line with no newline still arrives", async () => {
  const stream = closedStream(["done\ntrailing"], () => {});

  const lines: string[] = [];
  for await (const line of streamLines(stream)) {
    lines.push(line);
  }

  assertEquals(lines, ["done", "trailing"]);
});

Deno.test("streamTextChunks - a thrown consumer still cancels the stream", async () => {
  // The pipe has to be released on the failure path as well, or one throw
  // inside a chunk handler leaks a subprocess.
  let cancelled = false;
  const stream = openStream(["chunk\n"], () => (cancelled = true));

  let threw = false;
  try {
    for await (const _chunk of streamTextChunks(stream)) {
      throw new Error("handler blew up");
    }
  } catch {
    threw = true;
  }

  assert(threw, "the consumer's error should propagate");
  assert(cancelled, "and the stream should still be cancelled");
});
