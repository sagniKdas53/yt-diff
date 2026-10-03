import { Model } from "sequelize";
import { type AppConfig, config } from "../../config.ts";

export const playlistRegex = /(?:playlist|list=|creators|videos$)\b/i;

/**
 * Monitoring types whose videos the box keeps maintaining on its own.
 *
 * Lives here rather than with either of its two readers — the reaper, which
 * will not touch a video in one of these, and the download router, which
 * prefers to file a video in one of these — because the two answering with
 * different lists would mean a file the scheduler keeps fresh is reaped out
 * from under it.
 */
export const MONITORED_TYPES = ["Start", "End", "Full"];

/**
 * The one language the sidecar flags and the extras probe both read from.
 *
 * `--sub-langs en` and `%(subtitles.en&1|0)s` have to agree: the second asks
 * whether the language the first will actually fetch is there, and a mismatch
 * makes every video look like it is missing subtitles.
 */
export const SUBTITLE_LANGS = "en";

/**
 * Sidecars that can fail on their own without the media download caring.
 *
 * This is the vocabulary `missingExtras` is written in. "chapters" is here
 * because `--embed-chapters` is unconditional and its absence is still a gap,
 * even though it lands inside the media file rather than beside it.
 */
export const EXTRA_KINDS = [
  "subtitles",
  "thumbnail",
  "description",
  "comments",
  "chapters",
] as const;

export type ExtraKind = (typeof EXTRA_KINDS)[number];

/** Which sidecars this deployment asked for, from the SAVE_* switches. */
export function configuredExtras(): readonly ExtraKind[] {
  const wanted: ExtraKind[] = [];
  if (config.saveSubs) wanted.push("subtitles");
  if (config.saveThumbnail) wanted.push("thumbnail");
  if (config.saveDescription) wanted.push("description");
  if (config.saveComments) wanted.push("comments");
  // --embed-chapters is not behind a switch.
  wanted.push("chapters");
  return wanted;
}

/** The file name template, shared by a download and by an extras-only retry. */
function fileNameTemplate() {
  return config.restrictFilenames
    ? "%(id)s.%(ext)s"
    : "%(title)s[%(id)s].%(ext)s";
}

/**
 * Options that only fetch sidecars. Shared by a download and by the
 * extras-only retry, so a retry asks for exactly what the first run asked
 * for and lands in the same place.
 */
const sidecarOptions: string[] = [
  // A sidecar failure becomes a warning instead of an error, so a subtitle
  // 429 no longer stops yt-dlp before it fetches the video at all. The
  // filesystem, not the exit code, decides whether a download succeeded.
  "--ignore-errors",
  config.saveSubs ? "--write-subs" : "",
  config.saveSubs ? "--write-auto-subs" : "",
  config.saveSubs ? "--sub-langs" : "",
  config.saveSubs ? SUBTITLE_LANGS : "",
  config.saveSubs ? "--convert-subs" : "",
  config.saveSubs ? "vtt" : "",
  // The timedtext endpoint is what YouTube throttles first, so space those
  // requests out even when the general pacing knob is off.
  config.saveSubs ? "--sleep-subtitles" : "",
  config.saveSubs ? "1" : "",
  config.saveDescription ? "--write-description" : "",
  // --write-comments puts the comments in the infojson; without
  // --write-info-json there is no file to find and commentsFile never flips.
  config.saveComments ? "--write-comments" : "",
  config.saveComments ? "--write-info-json" : "",
  config.saveComments ? "--no-write-playlist-metafiles" : "",
  // Page through every comment thread otherwise, which is where the 429s
  // come from in the first place.
  config.saveComments ? "--extractor-args" : "",
  config.saveComments ? "youtube:max_comments=100" : "",
  config.saveThumbnail ? "--write-thumbnail" : "",
  config.restrictFilenames ? "--restrict-filenames" : "",
  "-P",
  "temp:/tmp",
  "-o",
  fileNameTemplate(),
  "--print",
  "before_dl:title:%(title)s [%(id)s]",
  // Prints 1 or 0 per sidecar, so every extractor answers the same question
  // the same way and there is no per-site table anywhere.
  "--print",
  `before_dl:extras:subs=%(subtitles.${SUBTITLE_LANGS}&1|0)s autosubs=%(automatic_captions.${SUBTITLE_LANGS}&1|0)s chapters=%(chapters&1|0)s comments=%(comment_count&1|0)s description=%(description&1|0)s thumbnail=%(thumbnail&1|0)s`,
  "--print",
  config.restrictFilenames
    ? 'post_process:"fileName:%(id)s.%(ext)s"'
    : 'post_process:"fileName:%(title)s[%(id)s].%(ext)s"',
].filter(Boolean) as string[];

export const downloadOptions = [
  "--progress",
  "--embed-metadata",
  "--embed-chapters",
  ...sidecarOptions,
  "--progress-template",
  "download-title:%(info.id)s-%(progress.eta)s",
];

if (config.ytdlpSleepRequests > 0) {
  // Off by default: it slows every playlist run, not just a rate-limited one.
  downloadOptions.splice(downloadOptions.length - 2, 0, "--sleep-requests");
  downloadOptions.splice(
    downloadOptions.length - 2,
    0,
    String(
      config.ytdlpSleepRequests,
    ),
  );
}

/**
 * The same sidecar request without the media, for recovering what a run
 * missed. `-P home:<savePath>` and the caller's URL complete it, so the
 * output template resolves to exactly the files the download would have.
 */
export const extrasOnlyOptions = ["--skip-download", ...sidecarOptions];

/**
 * Reads the `extras:` line yt-dlp prints before the download starts.
 *
 * @returns The sidecars the source has, or null when the line never arrived
 */
export function parseOfferedExtras(
  line: string,
): Set<ExtraKind> | null {
  const match =
    /extras:subs=(\d)\s+autosubs=(\d)\s+chapters=(\d)\s+comments=(\d)\s+description=(\d)\s+thumbnail=(\d)/
      .exec(line);
  if (!match) {
    return null;
  }

  const [, subs, autosubs, chapters, comments, description, thumbnail] = match;
  const offered = new Set<ExtraKind>();
  // Auto-captions count: a video with only rolling auto-transcripts has
  // subtitles for our purposes, and --write-auto-subs will fetch them.
  if (subs === "1" || autosubs === "1") offered.add("subtitles");
  if (thumbnail === "1") offered.add("thumbnail");
  if (description === "1") offered.add("description");
  if (comments === "1") offered.add("comments");
  if (chapters === "1") offered.add("chapters");
  return offered;
}

/** Why a run came up short, as far as the last stderr lines can say. */
export type PartialReason = "rate-limited" | "error";

/** What one extras-only retry managed to bring back. */
export interface SyncExtrasResult {
  url: string;
  /** "recovered" clears the last gap; "unchanged" leaves the chip where it was. */
  status: "recovered" | "unchanged" | "failed";
  recovered: ExtraKind[];
  stillMissing: ExtraKind[];
  reason: PartialReason | null;
}

/**
 * Classifies the tail of a run's stderr.
 *
 * YouTube answers a throttled sidecar with `HTTP Error 429` or `Too Many
 * Requests`; anything else is just an error. The distinction is what makes a
 * scheduled retry worth running, so it is decided once, here.
 */
export function classifyStderrReason(
  stderrTail: string,
): PartialReason | null {
  if (!stderrTail.trim()) {
    return null;
  }
  return /HTTP Error 429|Too Many Requests/i.test(stderrTail)
    ? "rate-limited"
    : "error";
}

if (!isNaN(config.maxFileNameLength) && config.maxFileNameLength > 0) {
  downloadOptions.push("--trim-filenames");
  downloadOptions.push(`${config.maxFileNameLength}`);
}

if (config.forceOverwrites) {
  downloadOptions.push("--force-overwrites");
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
  spawnedProcess?:
    | { kill: (signal: string) => boolean }
    | ManagedProcess
    | null;
}

export interface ListingRequestBody {
  urlList: string[];
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
  /**
   * Opt back into per-playlist progress emits even when isScheduledUpdate is
   * set. Batch re-index reuses the scheduled-update listing path but is user
   * initiated, so it still wants the UI to follow along; the nightly cron
   * leaves this unset and stays silent.
   */
  emitProgress?: boolean;
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

/**
 * What a cancel request actually found.
 *
 * "killed" and "queued" are both success but not the same thing to the user:
 * one had a yt-dlp process running that is now gone, the other was still
 * waiting for a slot and will never take it. Anything that reported a single
 * "cancelled" for both would be claiming to have stopped work it never began.
 */
export type CancelOutcome = "killed" | "queued" | "not-found";

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
  /**
   * The item's 1-based position in the playlist, as the source reports it.
   *
   * yt-dlp emits this on every `--dump-json` line and it counts the items it
   * skipped, which is the whole reason it is read: emission order does not.
   */
  playlist_index?: number;
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
  /**
   * One entry per ingested item whose mapping already existed under the same
   * video URL but at a different position — i.e. the playlist shifted under
   * us (prepended-to front, head deletions) rather than gaining a genuinely
   * new video. `mappingId` is the `PlaylistVideoMapping` row that was moved.
   *
   * Empty for exact-position fast-skips and for genuinely new videos.
   */
  moves: StreamingVideoMove[];
}

/**
 * A known video observed at a new playlist position.
 */
export interface StreamingVideoMove {
  videoUrl: string;
  mappingId: string;
  oldPosition: number;
  newPosition: number;
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
  /**
   * Sidecars the source offered, this deployment asked for, and that did not
   * land. Null when the run was complete — an extra that never existed is not
   * a gap.
   */
  missingExtras: ExtraKind[] | null;
  /**
   * The tail of the run's stderr, kept because nothing else survives it: the
   * exit code says "1" and the log has scrolled away by morning.
   */
  lastDownloadError: string | null;
  /** Classified once, here, so the retry job does not re-read the text. */
  downloadFailureReason: PartialReason | null;
  /** Bumped by every sidecar retry, so one row cannot be retried forever. */
  extrasSyncAttempts: number;
}

export interface DownloadProcessEntry extends ProcessLike {
  url: string;
  title: string;
  queuePosition: number;
  /**
   * Set by `cancelDownload` while this entry is still queued for a slot.
   *
   * A queued download has no process to kill, so a cancellation can only be a
   * note the download reads for itself when it finally gets one.
   */
  cancelled?: boolean;
}

export interface ListingProcessEntry extends ProcessLike {
  url: string;
  type: string;
  monitoringType: string;
}

export type SafeEmit = (event: string, payload: unknown) => void;
export type SiteArgBuilder = (url: string, config: AppConfig) => string[];
export type StreamTextChunks = (
  stream: ReadableStream<Uint8Array>,
) => AsyncGenerator<string>;
export type StreamLines = (
  stream: ReadableStream<Uint8Array>,
) => AsyncGenerator<string>;
export type SpawnPythonProcess = (args: string[]) => ManagedProcess;
export type HttpError = Error & { status?: number };

export interface PipelineHandlerDependencies {
  safeEmit: SafeEmit;
  buildSiteArgs: SiteArgBuilder;
  spawnPythonProcess: SpawnPythonProcess;
  streamTextChunks: StreamTextChunks;
  streamLines: StreamLines;
}

export interface CleanupOptions {
  maxIdleTime?: number;
  maxLifetime?: number;
  forceKill?: boolean;
}

export type CleanupStaleProcesses = (
  processMap: Map<string, ProcessLike>,
  options: CleanupOptions | undefined,
  processType: string,
) => number;

export type ListItemsConcurrently = (
  items: ListingItem[],
  chunkSize: number,
  isScheduledUpdate: boolean,
) => Promise<ListingResult[]>;

export enum ProcessExitCodes {
  SUCCESS = 0,
  PARTIAL_ERROR = 1, // Often generated when only partial list/data is scraped, or minor warning
  SIGTERM = 143, // Process was killed (e.g. by user/timeout sending SIGTERM)
}

/**
 * A listing subprocess that ended on a non-success exit code.
 *
 * The exit code is carried as a field so consumers can tell a cancellation
 * (`null`, `SIGTERM`) from a genuine failure without parsing `message`. The
 * message keeps its historical `Process exited with code <n>[: reason]` shape
 * for logs and for the `listing-error` event the frontend renders.
 */
export class ListingProcessError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly reason: string = "",
  ) {
    super(
      reason
        ? `Process exited with code ${exitCode}: ${reason}`
        : `Process exited with code ${exitCode}`,
    );
    this.name = "ListingProcessError";
  }

  /**
   * True when the exit means "we stopped this ourselves" rather than
   * "this listing failed": no code at all, or a SIGTERM we sent.
   */
  get isDeliberateTermination(): boolean {
    return this.exitCode === null || this.exitCode === ProcessExitCodes.SIGTERM;
  }
}
