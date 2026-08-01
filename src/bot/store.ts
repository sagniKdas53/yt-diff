import { Op } from "sequelize";

import { BotSubmission, VideoMetadata } from "../db/models.ts";
import { removeVideoFiles } from "../handlers/videoFiles.ts";

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

export interface CreateSubmissionFields {
  platform: string;
  chatId: string;
  messageId: string;
  requestedUrl: string;
  kind: string;
  retention: string;
}

/** Every database interaction BotCore needs, behind one injectable seam. */
export interface BotStore {
  createSubmission(fields: CreateSubmissionFields): Promise<{ id: string }>;
  updateSubmission(id: string, fields: Record<string, unknown>): Promise<void>;
  findVideoByUrl(videoUrl: string): Promise<VideoRecord | null>;
  findVideosByVideoId(videoId: string): Promise<VideoRecord[]>;
  listSubmissions(chatId: string, limit: number): Promise<SubmissionRecord[]>;
  /** Free-text search over indexed videos, by title or URL. */
  searchVideos(query: string, limit: number): Promise<VideoRecord[]>;
  /** Resolves a short id prefix, but only to a unique match. */
  findSubmissionByPrefix(
    chatId: string,
    idPrefix: string,
  ): Promise<SubmissionRecord | null>;
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
    // BIGINT comes back as a string from pg.
    approximateSize: Number(row.approximateSize ?? 0) || 0,
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
