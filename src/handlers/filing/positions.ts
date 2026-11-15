/**
 * Positions in `playlist_video_mappings`. Only the filing job writes a
 * negative one, so a negative position means "put here by the job", and
 * anything doing arithmetic on positions has to allow for them.
 */

/**
 * Where a filed mapping sits: minus the time the video was added, in seconds.
 * The newest-added video is the most negative, so it sorts first in position
 * order, which is what puts filed videos newest first above position 1 in a
 * real playlist. The `-1` ceiling keeps the epoch
 * and sub-second timestamps negative, because undo finds the job's rows by
 * their sign.
 */
export function filedPosition(addedAt: Date): number {
  return Math.min(-1, -Math.floor(addedAt.getTime() / 1000));
}

/**
 * The position for a new real entry after the last one on record. A playlist
 * holding only filed mappings has a negative maximum, and adding one to it
 * would write a real video into the job's range, where undo would remove it.
 */
export function nextRealPosition(last: number | null | undefined): number {
  return Math.max(0, last ?? 0) + 1;
}
