import { Op, type WhereOptions } from "sequelize";

import {
  BotHeartbeat,
  BotSubmission,
  PlaylistMetadata,
  PlaylistVideoMapping,
  VideoMetadata,
} from "../db/models.ts";
import { removeVideoFiles } from "../handlers/videoFiles.ts";
import type { BotPlatform } from "./types.ts";

/**
 * Statuses that mean "the process died before this settled". Anything else —
 * delivered, failed, reaped, downloaded — is a finished job, and a restart
 * must not repeat it.
 */
const UNSETTLED_STATUSES = ["pending", "indexing", "downloading"];

/** The single row of bot_heartbeat. */
const HEARTBEAT_ROW_ID = "bot";

/**
 * The rows one `/keep` or `/rm` acts on: every submission of this video, in
 * one chat when the caller named one.
 */
function submissionUrlWhere(
  canonicalUrl: string,
  chatId?: string,
): WhereOptions {
  return chatId === undefined ? { canonicalUrl } : { canonicalUrl, chatId };
}

/**
 * The subset of a video row the bot actually reads.
 *
 * Deliberately a plain shape rather than the Sequelize model so BotCore can be
 * tested without a database.
 */
export interface VideoRecord {
  videoUrl: string;
  videoId: string;
  title: string;
  downloadStatus: boolean;
  fileName: string | null;
  saveDirectory: string | null;
  /** yt-dlp's size estimate in bytes; 0 when unknown. */
  approximateSize: number;
}

export interface SubmissionRecord {
  id: string;
  status: string;
  requestedUrl: string;
  canonicalUrl: string | null;
}

/**
 * A submission that never reached a terminal status, with everything needed
 * to pick it back up: where to reply, what was asked for, and when it arrived.
 */
export interface UnsettledSubmissionRecord {
  id: string;
  platform: BotPlatform;
  chatId: string;
  requestedUrl: string;
  kind: string;
  requestedDeliveryMode: string | null;
  createdAt: Date;
}

/** One entry of a playlist, in playlist order. */
export interface PlaylistEntryRecord {
  /** 1-based position as stored by the pipeline. */
  position: number;
  title: string;
  videoUrl: string;
  downloadStatus: boolean;
}

/** A playlist row, plus how many entries it currently holds. */
export interface PlaylistRecord {
  playlistUrl: string;
  title: string;
  monitoringType: string;
  videoCount: number;
}

export interface CreateSubmissionFields {
  platform: string;
  chatId: string;
  messageId: string;
  requestedUrl: string;
  kind: string;
  retention: string;
  /** What the user asked for; written now so a resumed download matches. */
  requestedDeliveryMode: string;
}

/** Every database interaction BotCore needs, behind one injectable seam. */
export interface BotStore {
  createSubmission(fields: CreateSubmissionFields): Promise<{ id: string }>;
  /**
   * Submissions still in flight when the process died — status pending,
   * indexing or downloading — oldest first, so a restart replays a burst in
   * the order it was sent.
   */
  listUnsettledSubmissions(
    limit: number,
  ): Promise<UnsettledSubmissionRecord[]>;
  /** Distinct platform/chat pairs with a submission in the window. */
  listActiveChatsSince(
    since: Date,
  ): Promise<{ platform: BotPlatform; chatId: string }[]>;
  /** When the bot last polled or handled an update; null if never booted. */
  getLastSeenAt(): Promise<Date | null>;
  /** Stamps the heartbeat row. */
  touchLastSeenAt(at: Date): Promise<void>;
  updateSubmission(id: string, fields: Record<string, unknown>): Promise<void>;
  findVideoByUrl(videoUrl: string): Promise<VideoRecord | null>;
  findVideosByVideoId(videoId: string): Promise<VideoRecord[]>;
  listSubmissions(chatId: string, limit: number): Promise<SubmissionRecord[]>;
  /** Free-text search over indexed videos, by title or URL. */
  searchVideos(query: string, limit: number): Promise<VideoRecord[]>;
  /** The playlist row and its entry count, or null when it is not indexed. */
  findPlaylistByUrl(playlistUrl: string): Promise<PlaylistRecord | null>;
  /** Known playlists, most recently updated first. */
  listPlaylists(limit: number): Promise<PlaylistRecord[]>;
  /**
   * One page of a playlist's entries, in playlist order.
   *
   * @returns The page plus the playlist's total entry count, for paging hints
   */
  listPlaylistVideos(
    playlistUrl: string,
    start: number,
    limit: number,
  ): Promise<{ total: number; items: PlaylistEntryRecord[] }>;
  /** Resolves a short id prefix, but only to a unique match. */
  findSubmissionByPrefix(
    chatId: string,
    idPrefix: string,
  ): Promise<SubmissionRecord | null>;
  /**
   * Makes every delivery of one video permanent, so the reaper leaves the file
   * on disk. Scoped to one chat when `chatId` is given: `/keep` in a shared
   * chat must not keep other people's rows, even though they name the same
   * file.
   *
   * @returns How many submissions were updated, so the caller can say whether
   *   anything was actually kept rather than claiming success either way.
   */
  keepSubmissionsByUrl(
    canonicalUrl: string,
    chatId?: string,
  ): Promise<number>;
  /** Marks one video's submissions reaped in a chat; the files are already gone. */
  markSubmissionsReapedByUrl(
    canonicalUrl: string,
    chatId?: string,
  ): Promise<number>;
  /**
   * Deletes a video's files and clears its file columns.
   *
   * @returns false when the video is gone or a file could not be removed
   */
  purgeVideoFiles(videoUrl: string): Promise<boolean>;
}

function toVideoRecord(row: VideoMetadata): VideoRecord {
  return {
    videoUrl: row.videoUrl,
    videoId: row.videoId,
    title: row.title,
    downloadStatus: row.downloadStatus,
    fileName: row.fileName ?? null,
    saveDirectory: row.saveDirectory ?? null,
    // BIGINT comes back as a string from pg, and yt-dlp writes -1 when it has
    // no estimate (which is the norm for x.com). Normalise both to 0 = unknown.
    approximateSize: Math.max(0, Number(row.approximateSize ?? 0) || 0),
  };
}

function toPlaylistRecord(
  row: PlaylistMetadata,
  videoCount: number,
): PlaylistRecord {
  return {
    playlistUrl: row.playlistUrl,
    title: row.title,
    // A playlist written before monitoring existed can have this empty; the
    // web UI reads an empty value as "not monitored" too.
    monitoringType: row.monitoringType || "N/A",
    videoCount,
  };
}

function toSubmissionRecord(row: BotSubmission): SubmissionRecord {
  return {
    id: row.id,
    status: row.status,
    requestedUrl: row.requestedUrl,
    canonicalUrl: row.canonicalUrl ?? null,
  };
}

function toUnsettledSubmissionRecord(
  row: BotSubmission,
): UnsettledSubmissionRecord {
  return {
    id: row.id,
    // The column is a plain string; only the two platforms in BotPlatform have
    // ever written it, and the replay skips anything with no adapter.
    platform: row.platform as BotPlatform,
    chatId: row.chatId,
    requestedUrl: row.requestedUrl,
    kind: row.kind,
    requestedDeliveryMode: row.requestedDeliveryMode ?? null,
    createdAt: row.createdAt,
  };
}

/** Sequelize-backed implementation used in production. */
export function createSequelizeBotStore(): BotStore {
  return {
    async createSubmission(fields) {
      const row = await BotSubmission.create({
        ...fields,
        canonicalUrl: null,
        status: "pending",
      });
      return { id: row.id };
    },

    async listUnsettledSubmissions(limit) {
      const rows = await BotSubmission.findAll({
        where: { status: { [Op.in]: UNSETTLED_STATUSES } },
        // Oldest first, so a burst Telegram replays comes back out in the
        // order it went in.
        order: [["createdAt", "ASC"]],
        limit,
      });
      return rows.map(toUnsettledSubmissionRecord);
    },

    async listActiveChatsSince(since) {
      const rows = await BotSubmission.findAll({
        attributes: ["platform", "chatId"],
        where: { createdAt: { [Op.gte]: since } },
        group: ["platform", "chatId"],
        order: [["createdAt", "DESC"]],
      });
      return rows.map((row) => ({
        platform: row.getDataValue("platform") as BotPlatform,
        chatId: row.getDataValue("chatId") as string,
      }));
    },

    async getLastSeenAt() {
      const row = await BotHeartbeat.findByPk(HEARTBEAT_ROW_ID);
      return row ? row.lastSeenAt : null;
    },

    async touchLastSeenAt(at) {
      // One row, so an upsert: find-then-create would race with the minute
      // timer and with every update arriving at the same time.
      await BotHeartbeat.upsert({ id: HEARTBEAT_ROW_ID, lastSeenAt: at });
    },

    async updateSubmission(id, fields) {
      await BotSubmission.update(fields, { where: { id } });
    },

    async findVideoByUrl(videoUrl) {
      const row = await VideoMetadata.findOne({ where: { videoUrl } });
      return row ? toVideoRecord(row) : null;
    },

    async findVideosByVideoId(videoId) {
      const rows = await VideoMetadata.findAll({
        where: { videoId },
        limit: 25,
      });
      return rows.map(toVideoRecord);
    },

    async searchVideos(query, limit) {
      const like = `%${query}%`;
      const rows = await VideoMetadata.findAll({
        where: {
          [Op.or]: [
            { title: { [Op.iLike]: like } },
            { videoUrl: { [Op.iLike]: like } },
          ],
        },
        order: [["updatedAt", "DESC"]],
        limit,
      });
      return rows.map(toVideoRecord);
    },

    async findPlaylistByUrl(playlistUrl) {
      const row = await PlaylistMetadata.findOne({ where: { playlistUrl } });
      if (!row) {
        return null;
      }
      const videoCount = await PlaylistVideoMapping.count({
        where: { playlistUrl },
      });
      return toPlaylistRecord(row, videoCount);
    },

    async listPlaylists(limit) {
      const rows = await PlaylistMetadata.findAll({
        // "None" and "init" are pseudo-playlists for unlisted videos, not
        // something anyone asked the bot to index.
        where: { playlistUrl: { [Op.notIn]: ["None", "init"] } },
        order: [["updatedAt", "DESC"]],
        limit,
      });
      return await Promise.all(rows.map(async (row) =>
        toPlaylistRecord(
          row,
          await PlaylistVideoMapping.count({
            where: { playlistUrl: row.playlistUrl },
          }),
        )
      ));
    },

    async listPlaylistVideos(playlistUrl, start, limit) {
      // Mirrors the web UI's sub-list query: playlist order, joined to the
      // video row so a page can show titles rather than bare URLs.
      const { count, rows } = await PlaylistVideoMapping.findAndCountAll({
        attributes: ["positionInPlaylist", "videoUrl"],
        include: [{
          model: VideoMetadata,
          attributes: ["title", "videoUrl", "downloadStatus"],
          required: false,
        }],
        where: { playlistUrl },
        order: [["positionInPlaylist", "ASC"]],
        offset: start,
        limit,
      });

      return {
        total: count,
        items: rows.map((row) => ({
          position: row.positionInPlaylist,
          // The join is optional so a mapping whose video row is missing still
          // shows up as a numbered line rather than vanishing from the page.
          title: row.video_metadatum?.title ?? row.videoUrl,
          videoUrl: row.videoUrl,
          downloadStatus: row.video_metadatum?.downloadStatus ?? false,
        })),
      };
    },

    async listSubmissions(chatId, limit) {
      const rows = await BotSubmission.findAll({
        where: { chatId },
        order: [["createdAt", "DESC"]],
        limit,
      });
      return rows.map(toSubmissionRecord);
    },

    async findSubmissionByPrefix(chatId, idPrefix) {
      const rows = await BotSubmission.findAll({
        where: { chatId, id: { [Op.like]: `${idPrefix}%` } },
        limit: 2,
      });
      // An ambiguous prefix is treated as no match rather than guessing.
      return rows.length === 1 ? toSubmissionRecord(rows[0]) : null;
    },

    async keepSubmissionsByUrl(canonicalUrl, chatId) {
      const [count] = await BotSubmission.update(
        { retention: "persistent", expiresAt: null },
        { where: submissionUrlWhere(canonicalUrl, chatId) },
      );
      return count;
    },

    async markSubmissionsReapedByUrl(canonicalUrl, chatId) {
      const [count] = await BotSubmission.update(
        { status: "reaped" },
        { where: submissionUrlWhere(canonicalUrl, chatId) },
      );
      return count;
    },

    async purgeVideoFiles(videoUrl) {
      const video = await VideoMetadata.findOne({ where: { videoUrl } });
      if (!video) {
        return false;
      }

      const removed = await removeVideoFiles(video);
      if (!removed) {
        return false;
      }

      // Mirrors the web UI's delete-with-cleanup reset exactly, so the two
      // cannot drift on which columns count as file state.
      await video.update({
        downloadStatus: false,
        fileName: null,
        thumbNailFile: null,
        subTitleFile: null,
        commentsFile: null,
        descriptionFile: null,
        saveDirectory: null,
      });
      return true;
    },
  };
}
