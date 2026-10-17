import { Op } from "sequelize";

import type { Chapter } from "../pipeline/chapters.ts";

export interface PlaylistDisplayRequest {
  start?: number;
  stop?: number;
  sort?: string;
  order?: string;
  query?: string;
}

export interface SubListRequest {
  url?: string;
  start?: number;
  stop?: number;
  query?: string;
  sortDownloaded?: boolean;
}

export interface UpdatePlaylistMonitoringRequest {
  url: string;
  watch: string;
}

export interface DeletePlaylistRequestBody {
  playListUrl: string;
  deleteAllVideosInPlaylist?: boolean;
  deletePlaylist?: boolean;
  cleanUp?: boolean;
}

export interface ReindexAllRequestBody {
  start?: string | number;
  stop?: string | number;
  siteFilter?: string;
  chunkSize?: string | number;
}

export interface DeleteVideosRequestBody {
  playListUrl: string;
  mappingIds?: string[];
  videoUrls?: string[];
  cleanUp?: boolean;
  deleteVideoMappings?: boolean;
  deleteVideosInDB?: boolean;
}

export interface PlaylistVideoRowShape {
  id: string;
  positionInPlaylist: number;
  playlistUrl: string;
  video_metadatum?: {
    title?: string;
    videoId?: string;
    videoUrl?: string;
    downloadStatus?: boolean;
    isAvailable?: boolean;
    fileName?: string | null;
    thumbNailFile?: string | null;
    onlineThumbnail?: string | null;
    subTitleFile?: string | null;
    descriptionFile?: string | null;
    isMetaDataSynced?: boolean;
    commentsFile?: string | null;
    chapters?: Chapter[] | null;
    saveDirectory?: string | null;
    missingExtras?: string[] | null;
    lastDownloadError?: string | null;
  };
}

export interface SafePlaylistVideoMeta {
  title?: string;
  videoId?: string;
  videoUrl?: string;
  downloadStatus?: boolean;
  isAvailable?: boolean;
  fileName?: string | null;
  thumbNailFile?: string | null;
  onlineThumbnail?: string | null;
  subTitleFile?: string | null;
  descriptionFile?: string | null;
  isMetaDataSynced?: boolean;
  saveDirectory?: string | null;
  missingExtras?: string[] | null;
  commentsFile?: string | null;
  chapters?: Chapter[] | null;
  /**
   * When the reaper will take this file, if it will — the clock behind the
   * UI's "expires in 3 h" chip. Only files the bot fetched in ephemeral mode
   * have one, and clearing it (via `/keepfile` or `/keep`) is what makes the
   * chip go away.
   */
  botExpiresAt?: Date | null;
  lastDownloadError?: string | null;
}

export interface SafePlaylistVideoRow {
  id: string;
  positionInPlaylist: number;
  playlistUrl: string;
  video_metadatum: SafePlaylistVideoMeta;
}

export interface PlaylistWhereShape {
  sortOrder: { [Op.gte]: number };
  playlistUrl?: { [Op.iLike]: string };
  title?: { [Op.iLike]?: string; [Op.iRegexp]?: string };
}

export type HttpError = Error & { status?: number };

export interface ListingItem {
  url: string;
  type: string;
  currentMonitoringType: string;
  reason: string;
  isScheduledUpdate?: boolean;
}

export type ListItemsConcurrently = (
  items: ListingItem[],
  chunkSize: number,
  sleep: boolean,
) => Promise<Array<{ status?: string }>>;

export type SafeEmit = (event: string, payload: unknown) => void;

export interface PlaylistHandlerDependencies {
  listItemsConcurrently: ListItemsConcurrently;
  safeEmit: SafeEmit;
}
