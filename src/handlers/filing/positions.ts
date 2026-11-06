/**
 * Positions in `playlist_video_mappings`. Only the filing job writes a
 * negative one, so a negative position means "put here by the job", and
 * anything doing arithmetic on positions has to allow for them.
 */

/**
 * Where a filed mapping sits: minus the time the video was added, in seconds.
 * Newest-added is the least negative, so it sorts last in position order and
 * first when Unlisted is read newest-first. The `-1` ceiling keeps the epoch
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
