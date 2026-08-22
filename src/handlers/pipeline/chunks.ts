/**
 * One batch of raw playlist entries, wherever they came from.
 *
 * `startIndex` is the 1-based position of `items[0]` within the playlist,
 * which is what the ingest path stores as `positionInPlaylist`. Sources own
 * that number because only they know it: yt-dlp emits a flat line stream and
 * the offset has to be counted, while the YouTube API returns it.
 */
export interface PlaylistChunk {
  items: string[];
  startIndex: number;
}

/**
 * Groups a flat line stream into fixed-size chunks, tracking each one's offset.
 *
 * The trailing partial chunk is yielded like any other. The listing path used
 * to handle it in a separate block after the loop, which is how the two copies
 * of that loop came to disagree about whether a partial chunk counts toward
 * the "everything here is already known" early stop.
 *
 * @param lines - Entries in playlist order.
 * @param chunkSize - Maximum entries per chunk; anything below 1 is treated
 *   as 1, since a non-positive size would otherwise buffer the whole playlist.
 * @param startIndex - 1-based position of the first line in the stream.
 */
export async function* chunkPlaylistLines(
  lines: AsyncIterable<string>,
  chunkSize: number,
  startIndex = 1,
): AsyncGenerator<PlaylistChunk> {
  const size = Math.max(1, Math.floor(chunkSize));
  let pending: string[] = [];
  let nextIndex = startIndex;

  for await (const line of lines) {
    pending.push(line);
    if (pending.length >= size) {
      yield { items: pending, startIndex: nextIndex };
      nextIndex += pending.length;
      pending = [];
    }
  }

  if (pending.length > 0) {
    yield { items: pending, startIndex: nextIndex };
  }
}
