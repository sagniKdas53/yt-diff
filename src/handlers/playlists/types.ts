import { Op } from "sequelize";

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
  url?: string;
  watch?: string;
}

export interface DeletePlaylistRequestBody {
  playListUrl?: string;
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
  playListUrl?: string;
  videoUrls?: string[];
  cleanUp?: boolean;
  deleteVideoMappings?: boolean;
  deleteVideosInDB?: boolean;
}

export interface PlaylistVideoRowShape {
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
    saveDirectory?: string | null;
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
}

export interface SafePlaylistVideoRow {
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

export type ResetPendingPlaylistSortCounter = () => void;
export type ListItemsConcurrently = (
  items: ListingItem[],
  chunkSize: number,
  sleep: boolean,
) => Promise<Array<{ status?: string }>>;

export interface PlaylistHandlerDependencies {
  listItemsConcurrently: ListItemsConcurrently;
  resetPendingPlaylistSortCounter: ResetPendingPlaylistSortCounter;
}
