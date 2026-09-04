/**
 * Reading a subprocess's output without wedging the subprocess.
 *
 * These two were defined inline in `index.ts` and handed to the pipeline as
 * dependencies, which left the one rule that makes them safe — a consumer that
 * stops early must cancel the stream — untestable and, as it turned out,
 * unimplemented.
 */

/**
 * Decoded chunks from a subprocess stream, for as long as the consumer wants
 * them.
 *
 * The `finally` is the important part. A consumer that stops early — `break`,
 * `return`, or a throw — closes this generator, and until it also cancelled
 * the stream the read end of the pipe stayed open and unread. The child then
 * blocked in `write()` the moment it filled the 64 KB kernel pipe buffer, and
 * `process.status` never resolved: that is exactly how one playlist-title
 * probe wedged the listing semaphore, and with it the whole bot, for an hour
 * on 2026-09-04. Cancelling closes the pipe, so an abandoned child gets EPIPE
 * and exits instead of hanging on a reader that is never coming back.
 */
export async function* streamTextChunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let drained = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (value) {
        yield decoder.decode(value, { stream: true });
      }
    }
    const trailing = decoder.decode();
    if (trailing) {
      yield trailing;
    }
  } finally {
    if (!drained) {
      try {
        await reader.cancel();
      } catch {
        // Already closed or errored; the pipe is shut either way.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Releasing a reader whose stream is gone is not a failure.
    }
  }
}

/**
 * Whole lines from a subprocess stream.
 *
 * Inherits the cancellation contract above: stopping early on a line closes
 * the chunk generator underneath, which cancels the stream, which is what lets
 * a caller that only wants the first line — the playlist-title probe — take it
 * and leave.
 */
export async function* streamLines(stream: ReadableStream<Uint8Array>) {
  let buffered = "";
  for await (const chunk of streamTextChunks(stream)) {
    buffered += chunk;
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      buffered = buffered.slice(newlineIndex + 1);
      yield line;
      newlineIndex = buffered.indexOf("\n");
    }
  }

  const trailing = buffered.trim();
  if (trailing.length > 0) {
    yield trailing;
  }
}
