import { Model } from "sequelize";
import { config } from "../../config.ts";

export const playlistRegex = /(?:playlist|list=|videos$)\b/i;

export const downloadOptions = [
  "--progress",
  "--embed-metadata",
  "--embed-chapters",
  config.saveSubs ? "--write-subs" : "",
  config.saveSubs ? "--write-auto-subs" : "",
  config.saveDescription ? "--write-description" : "",
  config.saveComments ? "--write-comments" : "",
  config.saveThumbnail ? "--write-thumbnail" : "",
  config.restrictFilenames ? "--restrict-filenames" : "",
  "-P",
  "temp:/tmp",
  "-o",
  config.restrictFilenames ? "%(id)s.%(ext)s" : "%(title)s[%(id)s].%(ext)s",
  "--print",
  "before_dl:title:%(title)s [%(id)s]",
  "--print",
  config.restrictFilenames
    ? 'post_process:"fileName:%(id)s.%(ext)s"'
    : 'post_process:"fileName:%(title)s[%(id)s].%(ext)s"',
  "--progress-template",
  "download-title:%(info.id)s-%(progress.eta)s",
].filter(Boolean) as string[];

if (!isNaN(config.maxFileNameLength) && config.maxFileNameLength > 0) {
  downloadOptions.push("--trim-filenames");
  downloadOptions.push(`${config.maxFileNameLength}`);
}

export interface ManagedProcess {
  pid: number;
  readonly killed: boolean;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): boolean;
}

export interface ProcessLike {
  status: string;
  spawnType: string;
  lastActivity: number;
  lastStdoutActivity: number;
  spawnTimeStamp: number;
  spawnedProcess?: { kill: (signal: string) => boolean } | ManagedProcess | null;
}

export interface ListingRequestBody {
  urlList?: string[];
  chunkSize?: number | string;
  sleep?: boolean;
  monitoringType?: string;
}

export interface DownloadRequestBody {
  urlList: string[];
  playListUrl?: string;
}

export interface ListingItem {
  url: string;
  type: string;
  currentMonitoringType: string;
  previousMonitoringType?: string;
  reason: string;
  isScheduledUpdate?: boolean;
}

export interface ListingResult {
  url: string;
  status: string;
  title?: string;
  playlistTitle?: string;
  type?: string;
  processedChunks?: number;
  seekPlaylistListTo?: number;
  error?: string;
}

export interface DownloadItem {
  url: string;
  title: string;
  saveDirectory: string;
  videoId: string;
}

export interface DownloadResult {
  url: string;
  title: string;
  status: string;
  error?: string;
}

export interface VideoEntrySnapshot {
  videoId: string;
  approximateSize: number | string;
  title: string;
  isAvailable: boolean;
}

export interface VideoEntryRecord extends VideoEntrySnapshot {
  downloadStatus?: boolean;
  fileName?: string | null;
}

export interface StreamedItemData extends Record<string, unknown> {
  webpage_url?: string;
  url?: string;
  thumbnail?: string | null;
  title?: string;
  id?: string;
  filesize_approx?: number | string;
  formats?: unknown;
  requested_formats?: unknown;
  thumbnails?: unknown;
  subtitles?: unknown;
  automatic_captions?: unknown;
}

export interface ParsedStreamItem {
  itemData: StreamedItemData;
  videoUrl: string;
  index: number;
  onlineThumbnail: string | null;
}

export interface StreamingVideoProcessingResult {
  count: number;
  title: string;
  responseUrl: string;
  alreadyExistedCount: number;
}

export interface VideoUpsertData extends VideoEntrySnapshot {
  videoUrl: string;
  downloadStatus: boolean;
  isAvailable: boolean;
  onlineThumbnail: string | null;
  raw_metadata: StreamedItemData;
}

export interface PlaylistMappingCreate {
  videoUrl: string;
  playlistUrl: string;
  positionInPlaylist: number;
}

export interface PlaylistMappingUpdate {
  instance: Model;
  position: number;
}

export interface DiscoveredMetadata {
  fileName: string | null;
  descriptionFile: string | null;
  commentsFile: string | null;
  subTitleFile: string | null;
  thumbNailFile: string | null;
}

export interface FileSyncStatus {
  videoFileFound: boolean;
  descriptionFileFound: boolean;
  commentsFileFound: boolean;
  subTitleFileFound: boolean;
  thumbNailFileFound: boolean;
}

export interface DownloadCompletionUpdates extends DiscoveredMetadata {
  downloadStatus: boolean;
  isAvailable: boolean;
  title: string;
  isMetaDataSynced: boolean;
  saveDirectory: string;
}

export interface DownloadProcessEntry extends ProcessLike {
  url: string;
  title: string;
}

export interface ListingProcessEntry extends ProcessLike {
  url: string;
  type: string;
  monitoringType: string;
}

export type SafeEmit = (event: string, payload: unknown) => void;
export type SiteArgBuilder = (url: string, config: unknown) => string[];
export type StreamTextChunks = (
  stream: ReadableStream<Uint8Array>,
) => AsyncGenerator<string>;
export type StreamLines = (stream: ReadableStream<Uint8Array>) => AsyncGenerator<string>;
export type SpawnPythonProcess = (args: string[]) => ManagedProcess;
export type HttpError = Error & { status?: number };

export interface PipelineHandlerDependencies {
  safeEmit: SafeEmit;
  buildSiteArgs: SiteArgBuilder;
  spawnPythonProcess: SpawnPythonProcess;
  streamTextChunks: StreamTextChunks;
  streamLines: StreamLines;
}

export enum ProcessExitCodes {
  SUCCESS = 0,
  PARTIAL_ERROR = 1, // Often generated when only partial list/data is scraped, or minor warning
  SIGTERM = 143,     // Process was killed (e.g. by user/timeout sending SIGTERM)
}
