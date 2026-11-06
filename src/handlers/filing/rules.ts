/**
 * The numbers behind Unlisted filing. They live here and nowhere else, so a
 * threshold changes in one place and the tests that name it follow.
 */

/** Under this many seconds a known-length video is a clip. */
export const CLIP_MAX_SECONDS = 120;

/** A channel needs at least this many videos left after playlists and clips. */
export const CHANNEL_MIN_VIDEOS = 3;

/** The share of a playlist one owner needs for it to count as a channel. */
export const CHANNEL_SHARE = 0.8;

/** How long a saved video stays in the Inbox. */
export const INBOX_DAYS = 30;

/**
 * Stamped on every filing row. Bump it when a rule changes, so a later sweep
 * can tell which rows were placed under the old one.
 */
export const RULES_VERSION = 1;

/**
 * Path segments that name a kind of page rather than an account, so a handle
 * equal to one of them must not match a playlist URL. The same list as
 * `seed/check.sql`, which Task 6 compares against.
 */
export const URL_WORDS: ReadonlySet<string> = new Set([
  "videos",
  "playlist",
  "profile",
  "channel",
  "user",
  "shorts",
]);

/** Prefix of an auto-channel's playlistUrl, which is never a real URL. */
export const AUTO_PREFIX = "auto:";
