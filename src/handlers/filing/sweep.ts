import { logger } from "../../logger.ts";
import { filedPosition } from "./positions.ts";
import {
  isChannelLike,
  type KnownPlaylist,
  type Placement,
  type PlacementKind,
  placeVideos,
  type UnlistedRow,
} from "./place.ts";
import { AUTO_PREFIX, RULES_VERSION } from "./rules.ts";
import { createDbFilingStore } from "./store.ts";

/** How many clip/archive rows one transaction writes. */
const SIMPLE_WRITE_CHUNK = 500;

export interface AutoChannelRecord {
  playlistUrl: string;
  title: string;
  kind: "channel";
  origin: "auto";
  sortOrder: -1;
  monitoringType: "N/A";
  saveDirectory: "";
}

export interface FilingItem {
  videoUrl: string;
  placement: PlacementKind;
  locked: boolean;
  /** Where the filed mapping goes: negative, from `filedPosition`. */
  position: number;
  /** False when the video is already in the playlist for real. */
  createMapping: boolean;
}

/** Everything one transaction writes. A null playlist is filing rows only. */
export interface FilingGroup {
  playlistUrl: string | null;
  createPlaylist?: AutoChannelRecord;
  items: FilingItem[];
  rulesVersion: number;
}

export interface UndoCandidates {
  /** Mappings at negative positions: the job's, by construction. */
  negativeMappings: Array<{ id: string; playlistUrl: string }>;
  filingRows: number;
  playlists: Array<{
    playlistUrl: string;
    origin: "user" | "auto";
    /** The sweep flipped this user playlist to kind "channel". */
    kindSetByFiling: boolean;
    mappingCount: number;
  }>;
}

export interface UndoPlan {
  mappingIds: string[];
  removeAutoPlaylists: string[];
  resetKinds: string[];
}

/** Every read and write the sweep makes, injectable as `RetentionStore` is. */
export interface FilingStore {
  /** Unlisted rows whose facets haven't been filled in yet. */
  countWithoutFacets(): Promise<number>;
  loadUnlisted(): Promise<UnlistedRow[]>;
  loadPlaylists(): Promise<KnownPlaylist[]>;
  /** Videos per owner for each user playlist still of kind "playlist". */
  loadOwnerCounts(): Promise<Map<string, Map<string, number>>>;
  writeGroup(group: FilingGroup): Promise<void>;
  markChannelLike(playlistUrls: string[]): Promise<void>;
  loadUndoCandidates(): Promise<UndoCandidates>;
  applyUndo(plan: UndoPlan): Promise<void>;
}

export interface FilingSummary {
  considered: number;
  toPlaylist: number;
  toChannel: number;
  newChannels: number;
  toClips: number;
  toArchive: number;
  unchanged: number;
  channelLikePlaylists: number;
  /** Groups whose transaction failed; their rows stay unswept for next time. */
  failedGroups: number;
  /** Unlisted rows skipped because `facets:backfill` hasn't reached them. */
  withoutFacets: number;
}

export interface UndoSummary {
  mappingsRemoved: number;
  filingRowsRemoved: number;
  channelsRemoved: number;
  kindsReset: number;
}

function isUnchanged(row: UnlistedRow, placement: Placement): boolean {
  const filing = row.filing;
  if (filing === null) return false;
  if (
    filing.placement !== placement.placement ||
    filing.playlistUrl !== placement.playlistUrl ||
    filing.locked !== placement.locked
  ) return false;
  // A filed row whose mapping has gone is a removal, which `placeVideos`
  // already turned into a locked archive row, so this only guards the rest.
  return placement.placement === "playlist" ||
      placement.placement === "channel"
    ? row.hasFiledMapping
    : true;
}

function autoChannel(key: string, title: string): AutoChannelRecord {
  return {
    playlistUrl: `${AUTO_PREFIX}${key}`,
    title,
    kind: "channel",
    origin: "auto",
    sortOrder: -1,
    monitoringType: "N/A",
    saveDirectory: "",
  };
}

/**
 * Files every Unlisted video: places it, then writes one transaction per
 * playlist or channel. A dry run (`apply: false`) returns the same summary and
 * writes nothing. Nothing here deletes, and nothing reads or writes expiry.
 */
export async function runFilingSweep(
  options: { apply: boolean },
  store: FilingStore = createDbFilingStore(),
): Promise<FilingSummary> {
  const [rows, playlists, withoutFacets] = await Promise.all([
    store.loadUnlisted(),
    store.loadPlaylists(),
    store.countWithoutFacets(),
  ]);
  if (withoutFacets > 0) {
    logger.warn("Some Unlisted rows have no facets; run facets:backfill", {
      withoutFacets,
    });
  }

  const placements = placeVideos(rows, playlists);
  const summary: FilingSummary = {
    considered: rows.length,
    toPlaylist: 0,
    toChannel: 0,
    newChannels: 0,
    toClips: 0,
    toArchive: 0,
    unchanged: 0,
    channelLikePlaylists: 0,
    failedGroups: 0,
    withoutFacets,
  };

  const byPlaylist = new Map<string, FilingGroup>();
  const simple: FilingItem[] = [];

  rows.forEach((row, i) => {
    const placement = placements[i];
    if (isUnchanged(row, placement)) {
      summary.unchanged++;
      return;
    }
    const item: FilingItem = {
      videoUrl: row.videoUrl,
      placement: placement.placement,
      locked: placement.locked,
      position: filedPosition(row.addedAt),
      createMapping: placement.playlistUrl !== null &&
        placement.playlistUrl !== row.realPlaylistUrl,
    };
    if (placement.playlistUrl === null) {
      simple.push(item);
      return;
    }
    let group = byPlaylist.get(placement.playlistUrl);
    if (!group) {
      group = {
        playlistUrl: placement.playlistUrl,
        items: [],
        rulesVersion: RULES_VERSION,
      };
      byPlaylist.set(placement.playlistUrl, group);
    }
    if (placement.newChannel) {
      group.createPlaylist = autoChannel(
        placement.newChannel.key,
        placement.newChannel.title,
      );
    }
    group.items.push(item);
  });

  const groups: FilingGroup[] = [...byPlaylist.values()];
  for (let i = 0; i < simple.length; i += SIMPLE_WRITE_CHUNK) {
    groups.push({
      playlistUrl: null,
      items: simple.slice(i, i + SIMPLE_WRITE_CHUNK),
      rulesVersion: RULES_VERSION,
    });
  }

  for (const group of groups) {
    if (options.apply) {
      try {
        await store.writeGroup(group);
      } catch (error) {
        // One bad group must not stop the rest. Its rows get no filing row,
        // so the next run picks them up again.
        summary.failedGroups++;
        logger.error("Filing group failed", {
          playlistUrl: group.playlistUrl,
          error: (error as Error).message,
        });
        continue;
      }
    }
    for (const item of group.items) {
      if (item.placement === "playlist") summary.toPlaylist++;
      else if (item.placement === "channel") summary.toChannel++;
      else if (item.placement === "clip") summary.toClips++;
      else summary.toArchive++;
    }
    if (group.createPlaylist) summary.newChannels++;
  }

  // User playlists that are really one account's videos belong under
  // Channels. This only ever flips towards "channel"; undo reverses it.
  const owners = await store.loadOwnerCounts();
  const channelLike = [...owners]
    .filter(([, counts]) => isChannelLike(counts))
    .map(([playlistUrl]) => playlistUrl);
  summary.channelLikePlaylists = channelLike.length;
  if (options.apply && channelLike.length > 0) {
    try {
      await store.markChannelLike(channelLike);
    } catch (error) {
      summary.channelLikePlaylists = 0;
      logger.error("Marking channel-like playlists failed", {
        error: (error as Error).message,
      });
    }
  }

  logger.info("Filing sweep finished", { ...summary, apply: options.apply });
  return summary;
}

/**
 * Reverses the job and nothing else. It removes mappings at negative
 * positions (only the job writes those), the filing rows, the auto channels
 * left empty, and the `kind` the sweep changed. It never goes through
 * `/delplay`, which would renumber every other playlist.
 */
export async function undoFiling(
  options: { apply: boolean },
  store: FilingStore = createDbFilingStore(),
): Promise<UndoSummary> {
  const found = await store.loadUndoCandidates();

  const removedFrom = new Map<string, number>();
  for (const { playlistUrl } of found.negativeMappings) {
    removedFrom.set(playlistUrl, (removedFrom.get(playlistUrl) ?? 0) + 1);
  }

  // Only a playlist the job made, and only when nothing real is left in it.
  // A promoted channel has origin "user" by now, so it is never touched.
  const removeAutoPlaylists = found.playlists
    .filter((p) =>
      p.origin === "auto" &&
      p.mappingCount - (removedFrom.get(p.playlistUrl) ?? 0) <= 0
    )
    .map((p) => p.playlistUrl);
  const resetKinds = found.playlists
    .filter((p) => p.origin === "user" && p.kindSetByFiling)
    .map((p) => p.playlistUrl);

  const plan: UndoPlan = {
    mappingIds: found.negativeMappings.map((m) => m.id),
    removeAutoPlaylists,
    resetKinds,
  };
  if (options.apply) await store.applyUndo(plan);

  const summary: UndoSummary = {
    mappingsRemoved: plan.mappingIds.length,
    filingRowsRemoved: found.filingRows,
    channelsRemoved: removeAutoPlaylists.length,
    kindsReset: resetKinds.length,
  };
  logger.info("Filing undo finished", { ...summary, apply: options.apply });
  return summary;
}
