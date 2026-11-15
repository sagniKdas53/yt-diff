import {
  AUTO_PREFIX,
  CHANNEL_MIN_VIDEOS,
  CHANNEL_SHARE,
  CLIP_MAX_SECONDS,
  URL_WORDS,
} from "./rules.ts";

/**
 * Where an Unlisted video goes. Pure: every read the decision needs is passed
 * in, and the sweep (sweep.ts) does the reading and the writing.
 *
 * The first rule that fits wins:
 *   1. Already in a real playlist, or its uploader matches a channel-like one
 *      on the same site (by handle first, then by channel id).
 *   2. Known duration under CLIP_MAX_SECONDS: a clip.
 *   3. At least CHANNEL_MIN_VIDEOS left from one channel: that channel.
 *   4. Everything else: Archive. Saved or Links only is `downloadStatus` at
 *      query time, so it isn't stored here.
 */

export type PlacementKind = "playlist" | "channel" | "clip" | "archive";

export interface UnlistedRow {
  videoUrl: string;
  site: string;
  channelKey: string | null;
  channelName: string | null;
  channelHandle: string | null;
  /** The part of `channelKey` after "<site>:", for matching URLs by id. */
  channelId: string | null;
  durationSeconds: number | null;
  addedAt: Date;
  /** A playlist the video is in that the job didn't put it in. */
  realPlaylistUrl: string | null;
  filing: {
    placement: PlacementKind;
    playlistUrl: string | null;
    locked: boolean;
  } | null;
  /** A mapping exists in `filing.playlistUrl`. */
  hasFiledMapping: boolean;
}

export interface KnownPlaylist {
  playlistUrl: string;
  site: string;
  urlSegments: string[];
  monitored: boolean;
  createdAt: Date;
  /**
   * The playlist is one account's videos: its kind is "channel", or it passes
   * `isChannelLike` right now. A curated or mixed playlist is never a target
   * for an uploader match, however its URL reads.
   */
  channelLike: boolean;
}

export interface Placement {
  videoUrl: string;
  placement: PlacementKind;
  playlistUrl: string | null;
  locked: boolean;
  /** Set on the first placement into a channel that doesn't exist yet. */
  newChannel?: { key: string; title: string };
}

/** Lowercase and drop one leading @, so `@Name` and `name` compare equal. */
function bare(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

/**
 * The channel-like playlist whose URL names this uploader, on the same site.
 *
 * The handle is tried first, then the channel id, which finds a channel stored
 * under an id-style URL. Only a playlist that is one account's videos can
 * match: a user's curated playlist often sits under their path, and matching
 * it would file every video they upload there.
 *
 * With two matches a monitored playlist wins, then the oldest, which is the
 * order `resolveVideoPlaylist` uses to pick a folder.
 */
export function channelFromUploader(
  row: UnlistedRow,
  playlists: KnownPlaylist[],
): string | null {
  const candidates = playlists.filter((p) =>
    p.channelLike && p.site === row.site
  );
  return matchSegment(row.channelHandle, candidates) ??
    matchSegment(row.channelId, candidates);
}

function matchSegment(
  value: string | null,
  candidates: KnownPlaylist[],
): string | null {
  if (value === null) return null;
  const wanted = bare(value);
  if (wanted === "" || URL_WORDS.has(wanted)) return null;

  const matches = candidates.filter((p) =>
    p.urlSegments.some((segment) => bare(segment) === wanted)
  );
  if (matches.length === 0) return null;

  matches.sort((a, b) =>
    Number(b.monitored) - Number(a.monitored) ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
  return matches[0].playlistUrl;
}

/** The `isChannelLike` bucket for videos whose owner isn't known. */
export const UNKNOWN_OWNER = "";

/**
 * Whether a playlist is really one account's videos, so it belongs under
 * Channels. `counts` holds every video in the playlist by owner, with the
 * ones that have no known owner under UNKNOWN_OWNER: they count toward the
 * total, so a mixed playlist isn't labelled a channel, but they can never be
 * the dominant owner themselves.
 */
export function isChannelLike(counts: Map<string, number>): boolean {
  let total = 0;
  let largest = 0;
  for (const [owner, count] of counts) {
    total += count;
    if (owner !== UNKNOWN_OWNER && count > largest) largest = count;
  }
  return largest >= CHANNEL_MIN_VIDEOS && largest / total >= CHANNEL_SHARE;
}

function unchanged(row: UnlistedRow): Placement | null {
  const filing = row.filing;
  if (filing === null) return null;

  if (filing.locked) {
    return {
      videoUrl: row.videoUrl,
      placement: filing.placement,
      playlistUrl: filing.playlistUrl,
      locked: true,
    };
  }

  if (filing.placement === "playlist" || filing.placement === "channel") {
    // The playlist was deleted (the foreign key nulled it) or the video was
    // taken out of it: that was a choice, so it goes to Archive and stays.
    if (filing.playlistUrl === null || !row.hasFiledMapping) {
      return {
        videoUrl: row.videoUrl,
        placement: "archive",
        playlistUrl: null,
        locked: true,
      };
    }
    return {
      videoUrl: row.videoUrl,
      placement: filing.placement,
      playlistUrl: filing.playlistUrl,
      locked: false,
    };
  }

  // A clip or archive row is reconsidered, because metadata that arrives
  // later can move it.
  return null;
}

function titleFor(rows: UnlistedRow[], key: string): string {
  return rows.find((r) => r.channelName !== null)?.channelName ??
    rows.find((r) => r.channelHandle !== null)?.channelHandle ?? key;
}

/** One placement per input row, in input order. */
export function placeVideos(
  rows: UnlistedRow[],
  playlists: KnownPlaylist[],
): Placement[] {
  const results = new Map<UnlistedRow, Placement>();
  const remaining: UnlistedRow[] = [];

  for (const row of rows) {
    const kept = unchanged(row);
    if (kept) {
      results.set(row, kept);
      continue;
    }

    const playlistUrl = row.realPlaylistUrl ??
      channelFromUploader(row, playlists);
    if (playlistUrl !== null) {
      results.set(row, {
        videoUrl: row.videoUrl,
        placement: "playlist",
        playlistUrl,
        locked: false,
      });
      continue;
    }

    // An unknown duration isn't a clip.
    if (
      row.durationSeconds !== null && row.durationSeconds < CLIP_MAX_SECONDS
    ) {
      results.set(row, {
        videoUrl: row.videoUrl,
        placement: "clip",
        playlistUrl: null,
        locked: false,
      });
      continue;
    }

    remaining.push(row);
  }

  const groups = new Map<string, UnlistedRow[]>();
  for (const row of remaining) {
    if (row.channelKey === null) continue;
    const group = groups.get(row.channelKey);
    if (group) group.push(row);
    else groups.set(row.channelKey, [row]);
  }

  const known = new Set(playlists.map((p) => p.playlistUrl));
  const announced = new Set<string>();

  for (const row of remaining) {
    const group = row.channelKey === null
      ? undefined
      : groups.get(row.channelKey);
    if (row.channelKey !== null && group) {
      const playlistUrl = `${AUTO_PREFIX}${row.channelKey}`;
      // A channel that already exists takes a lone video: otherwise it could
      // never grow after the first sweep.
      if (known.has(playlistUrl) || group.length >= CHANNEL_MIN_VIDEOS) {
        const placement: Placement = {
          videoUrl: row.videoUrl,
          placement: "channel",
          playlistUrl,
          locked: false,
        };
        if (!known.has(playlistUrl) && !announced.has(playlistUrl)) {
          announced.add(playlistUrl);
          placement.newChannel = {
            key: row.channelKey,
            title: titleFor(group, row.channelKey),
          };
        }
        results.set(row, placement);
        continue;
      }
    }

    results.set(row, {
      videoUrl: row.videoUrl,
      placement: "archive",
      playlistUrl: null,
      locked: false,
    });
  }

  return rows.map((row) => results.get(row)!);
}
