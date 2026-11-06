/**
 * Turns the output of extract.sql into seed.sql.gz, a data pack that is safe to
 * publish in a public repository.
 *
 * The structure of the archive survives: how many videos each channel has, which
 * rows have no metadata, position ties, which uploader id matches which playlist
 * URL, and which month a row was added. Everything that says what the archive
 * contains or whose it is does not: titles, ids, names, folders, file names, paths
 * in URLs, chat ids and error text are replaced. The pack is YouTube only, and the
 * build fails if any other video or playlist reaches it. A stray host inside a
 * metadata field becomes `site-NN.example`.
 *
 * Pseudonyms are an HMAC under SEED_KEY. Keep that key out of the repo, or don't
 * keep it at all: without it, a guessed title or handle can't be confirmed by
 * hashing it. The same input always gives the same output, which is what keeps a
 * playlist URL's handle equal to the matching video's uploader id.
 *
 * Usage, with SEED_KEY set:
 *   deno run -A build_seed.ts <extract output> <seed.sql output>
 */
import { createHmac } from "node:crypto";
import bcrypt from "npm:bcryptjs@3.0.3";

const KEY = Deno.env.get("SEED_KEY");
if (!KEY || KEY.length < 32) {
  throw new Error("SEED_KEY must be set to at least 32 random characters");
}
const [inputPath, outputPath] = Deno.args;
if (!inputPath || !outputPath) {
  throw new Error("usage: build_seed.ts <extract output> <seed output>");
}

/** The only hosts this pack may contain. */
const KEPT_HOSTS = new Set(["youtube.com", "youtu.be"]);
const KEPT_EXTRACTORS = new Set(["Youtube", "YoutubeTab", "Generic"]);
/** URL path words that describe a URL's shape and identify nothing. */
const KEPT_SEGMENTS = new Set([
  "watch",
  "status",
  "video",
  "videos",
  "playlist",
  "profile",
  "shorts",
  "comments",
  "r",
  "user",
  "users",
  "channel",
  "channels",
  "media",
  "feed",
]);
const KEPT_FAILURES = new Set(["error", "rate-limited"]);
const KEPT_EXTRAS = new Set(["subtitles", "comments", "description"]);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function hash(domain: string, value: string, length = 12): string {
  const digest = createHmac("sha256", KEY!).update(`${domain}\0${value}`)
    .digest();
  let out = "";
  for (let i = 0; i < length; i++) out += BASE32[digest[i] % 32];
  return out;
}

function hashUuid(domain: string, value: string): string {
  const hex = createHmac("sha256", KEY!).update(`${domain}\0${value}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${
    hex.slice(17, 20)
  }-${hex.slice(20, 32)}`;
}

/** `"NA"`, blank and missing mean different things to the code; keep each. */
function isSentinel(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && (value.trim() === "" || value === "NA"));
}

/**
 * An id or handle. Case and a leading `@` are ignored when hashing and restored
 * afterwards, so `@Name`, `@name` and `name` still compare equal the way they do
 * in the real data, and a handle in a URL still matches an uploader id.
 */
function pseudoId(value: unknown): unknown {
  if (isSentinel(value)) return value;
  const text = String(value);
  const at = text.startsWith("@") ? "@" : "";
  const bare = at ? text.slice(1) : text;
  const out = hash("id", bare.toLowerCase());
  const first = bare[0];
  const capital = first !== undefined && first !== first.toLowerCase();
  return at + (capital ? out[0].toUpperCase() + out.slice(1) : out);
}

function flavoured(prefix: string, value: string, out: string): string {
  // Keep what breaks naive code: non-ASCII text, quotes, and very long values.
  // deno-lint-ignore no-control-regex
  const nonAscii = /[^\x00-\x7f]/.test(value) ? " テスト" : "";
  const quote = value.includes("'") ? "'s" : "";
  const base = `${prefix}${quote} ${out}${nonAscii}`;
  return value.length > 200 ? base.padEnd(value.length, " x") : base;
}

function pseudoName(value: unknown): unknown {
  if (isSentinel(value)) return value;
  const text = String(value);
  return flavoured("Channel", text, hash("name", text.toLowerCase()));
}

function pseudoTitle(value: unknown, prefix = "Video"): unknown {
  if (isSentinel(value)) return value;
  const text = String(value);
  // A placeholder title is a fact about the data, and it identifies nothing.
  if (/^(untitled|video|unknown|unavailable)$/i.test(text.trim())) return text;
  return flavoured(prefix, text, hash("title", text));
}

function pseudoDir(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return value;
  return `dir-${hash("dir", String(value))}`;
}

function pseudoFile(value: unknown): unknown {
  if (value === null || value === undefined || value === "") return value;
  const text = String(value);
  const ext = text.match(/\.[a-zA-Z0-9]{2,5}$/)?.[0] ?? "";
  return `${hash("file", text)}${ext}`;
}

// --------------------------------------------------------------------------
// Hosts
// --------------------------------------------------------------------------

function splitHost(raw: string): { prefix: string; bare: string } {
  const lower = raw.toLowerCase();
  const prefix = lower.match(/^(www\.|m\.)/)?.[0] ?? "";
  return { prefix, bare: lower.slice(prefix.length) };
}

const hostLabels = new Map<string, string>();

function hostLabel(bare: string): string {
  if (KEPT_HOSTS.has(bare)) return bare;
  const known = hostLabels.get(bare);
  if (known) return known;
  const label = `site-${String(hostLabels.size + 1).padStart(2, "0")}.example`;
  hostLabels.set(bare, label);
  return label;
}

function pseudoHost(raw: string): string {
  const { prefix, bare } = splitHost(raw);
  return prefix + hostLabel(bare);
}

/** Keeps a URL's shape, including `www.` and `m.`; replaces everything it names. */
function pseudoUrl(value: unknown): unknown {
  if (isSentinel(value)) return value;
  const text = String(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `https://unparsed.example/${hash("url", text)}`;
  }
  const path = url.pathname.split("/").map((segment) => {
    if (segment === "" || KEPT_SEGMENTS.has(segment)) return segment;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch { /* a malformed escape is hashed as it stands */ }
    return pseudoId(decoded);
  }).join("/");
  const query = [...url.searchParams.keys()]
    .map((key) =>
      `${/^[a-z_]{1,12}$/.test(key) ? key : hash("qk", key, 6)}=${
        hash("query", url.searchParams.get(key) ?? "")
      }`
    ).join("&");
  return `${url.protocol}//${pseudoHost(url.hostname)}${path}${
    query ? `?${query}` : ""
  }`;
}

/** Playlist keys that aren't URLs ("None", "init") are bookkeeping; keep them. */
function pseudoPlaylistUrl(value: string): string {
  return /^https?:\/\//.test(value) ? String(pseudoUrl(value)) : value;
}

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------

type Row = Record<string, unknown>;
const rows: Record<"playlist" | "mapping" | "bot" | "video", Row[]> = {
  playlist: [],
  mapping: [],
  bot: [],
  video: [],
};
for (const line of (await Deno.readTextFile(inputPath)).split("\n")) {
  if (!line.startsWith("{")) continue;
  const { t, r } = JSON.parse(line) as { t: keyof typeof rows; r: Row };
  rows[t].push(r);
}

// The scope is enforced in extract.sql and again here, because a mistake in that
// query would otherwise be published without anyone noticing.
function requireKeptHost(url: unknown, what: string): void {
  const { bare } = splitHost(new URL(String(url)).hostname);
  if (!KEPT_HOSTS.has(bare)) {
    throw new Error(
      `A ${what} from outside the pack's scope reached the build`,
    );
  }
}
for (const video of rows.video) requireKeptHost(video.videoUrl, "video");
for (const playlist of rows.playlist) {
  if (playlist.playlistUrl !== "None") {
    requireKeptHost(playlist.playlistUrl, "playlist");
  }
}
for (const bot of rows.bot) requireKeptHost(bot.requestedUrl, "bot submission");

// Number the hosts by how often they appear, independently of first-seen order.
const hostCounts = new Map<string, number>();
for (const video of rows.video) {
  try {
    const { bare } = splitHost(new URL(String(video.videoUrl)).hostname);
    hostCounts.set(bare, (hostCounts.get(bare) ?? 0) + 1);
  } catch { /* handled by pseudoUrl */ }
}
for (
  const [bare] of [...hostCounts].sort((a, b) =>
    b[1] - a[1] || hash("h", a[0]).localeCompare(hash("h", b[0]))
  )
) {
  hostLabel(bare);
}

// An extractor name gives a host away, so it follows that host's label.
const extractorHosts = new Map<string, Map<string, number>>();
for (const video of rows.video) {
  const key = (video.raw_metadata as Row | null)?.extractor_key;
  if (typeof key !== "string" || KEPT_EXTRACTORS.has(key)) continue;
  try {
    const { bare } = splitHost(new URL(String(video.videoUrl)).hostname);
    const hosts = extractorHosts.get(key) ?? new Map<string, number>();
    hosts.set(bare, (hosts.get(bare) ?? 0) + 1);
    extractorHosts.set(key, hosts);
  } catch { /* no host, so the hashed fallback below applies */ }
}
function pseudoExtractor(value: unknown): unknown {
  if (isSentinel(value)) return value;
  const text = String(value);
  if (KEPT_EXTRACTORS.has(text)) return text;
  const hosts = extractorHosts.get(text);
  const top = hosts && [...hosts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const label = top && !KEPT_HOSTS.has(top)
    ? hostLabel(top).replace(/\.example$/, "").replace(/[^a-z0-9]/g, "")
    : `extractor${hash("ex", text, 6)}`;
  return `${label[0].toUpperCase()}${label.slice(1)}`;
}

// --------------------------------------------------------------------------
// Time
// --------------------------------------------------------------------------

/**
 * Keeps each timestamp's day and its order relative to every other timestamp,
 * ties included, and replaces its time of day. Time ranges and position order
 * still work, and the pack doesn't record when someone was awake.
 */
const stamps = new Set<string>();
const STAMP_FIELDS = [
  "createdAt",
  "updatedAt",
  "expiresAt",
  "lastUpdatedByScheduler",
];
for (const table of Object.values(rows)) {
  for (const row of table) {
    for (const field of STAMP_FIELDS) {
      if (typeof row[field] === "string") stamps.add(row[field] as string);
    }
  }
}
const days = new Map<number, number[]>();
for (const stamp of stamps) {
  const ms = Date.parse(stamp);
  const day = Math.floor(ms / 86_400_000);
  const list = days.get(day) ?? [];
  list.push(ms);
  days.set(day, list);
}
const maskedTime = new Map<number, string>();
for (const [day, list] of days) {
  const distinct = [...new Set(list)].sort((a, b) => a - b);
  distinct.forEach((ms, index) => {
    const offset = Math.floor((index + 1) * 86_400_000 / (distinct.length + 1));
    maskedTime.set(ms, new Date(day * 86_400_000 + offset).toISOString());
  });
}
function mask(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // The epoch placeholder for "never" is a fact worth keeping.
  if (Date.parse(value) === 0) return new Date(0).toISOString();
  return maskedTime.get(Date.parse(value)) ?? null;
}

// --------------------------------------------------------------------------
// Transform
// --------------------------------------------------------------------------

const videoUrls = new Map<string, string>();
const usedVideoUrls = new Set<string>();
function pseudoVideoUrl(value: string): string {
  const known = videoUrls.get(value);
  if (known) return known;
  let out = String(pseudoUrl(value));
  // Ids are case-sensitive in a URL and case-folded here, so two real videos can
  // meet. This is the table's primary key, so keep them apart.
  if (usedVideoUrls.has(out)) out += `#${hash("dup", value, 6)}`;
  usedVideoUrls.add(out);
  videoUrls.set(value, out);
  return out;
}

function pseudoRawMetadata(raw: Row | null): Row | null {
  if (raw === null) return null;
  const out: Row = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "id":
      case "channel_id":
      case "uploader_id":
      case "playlist_id":
        out[key] = pseudoId(value);
        break;
      case "title":
        out[key] = pseudoTitle(value);
        break;
      case "playlist":
      case "playlist_title":
        out[key] = pseudoTitle(value, "Playlist");
        break;
      case "channel":
      case "uploader":
        out[key] = pseudoName(value);
        break;
      case "webpage_url":
      case "original_url":
      case "channel_url":
      case "uploader_url":
      case "playlist_webpage_url":
        out[key] = pseudoUrl(value);
        break;
      case "webpage_url_domain":
        out[key] = isSentinel(value) ? value : pseudoHost(String(value));
        break;
      case "extractor":
      case "extractor_key": {
        const name = pseudoExtractor(raw.extractor_key ?? value);
        out[key] = key === "extractor" && typeof name === "string"
          ? name.toLowerCase()
          : name;
        break;
      }
      case "upload_date":
      case "duration":
      case "filesize_approx":
      case "ext":
      case "vcodec":
      case "acodec":
      case "height":
      case "width":
      case "fps":
      case "playlist_index":
        out[key] = value;
        break;
        // Anything else is a surprise, and a surprise doesn't get published.
    }
  }
  return out;
}

const playlistColumns = [
  "playlistUrl",
  "title",
  "sortOrder",
  "monitoringType",
  "saveDirectory",
  "createdAt",
  "updatedAt",
  "lastUpdatedByScheduler",
];
const playlists = rows.playlist.map((p) => ({
  playlistUrl: pseudoPlaylistUrl(String(p.playlistUrl)),
  title: /^https?:/.test(String(p.playlistUrl))
    ? pseudoTitle(p.title, "Playlist")
    : p.title,
  sortOrder: p.sortOrder,
  monitoringType: p.monitoringType,
  saveDirectory: pseudoDir(p.saveDirectory),
  createdAt: mask(p.createdAt),
  updatedAt: mask(p.updatedAt),
  lastUpdatedByScheduler: mask(p.lastUpdatedByScheduler),
}));

const videoColumns = [
  "videoUrl",
  "videoId",
  "title",
  "approximateSize",
  "downloadStatus",
  "isAvailable",
  "fileName",
  "thumbNailFile",
  "subTitleFile",
  "commentsFile",
  "descriptionFile",
  "isMetaDataSynced",
  "createdAt",
  "updatedAt",
  "saveDirectory",
  "onlineThumbnail",
  "raw_metadata",
  "missingExtras",
  "lastDownloadError",
  "downloadFailureReason",
  "extrasSyncAttempts",
  "chapters",
];
const videos = rows.video.map((v) => ({
  videoUrl: pseudoVideoUrl(String(v.videoUrl)),
  videoId: pseudoId(v.videoId),
  title: pseudoTitle(v.title),
  approximateSize: v.approximateSize,
  downloadStatus: v.downloadStatus,
  isAvailable: v.isAvailable,
  fileName: pseudoFile(v.fileName),
  thumbNailFile: pseudoFile(v.thumbNailFile),
  subTitleFile: pseudoFile(v.subTitleFile),
  commentsFile: pseudoFile(v.commentsFile),
  descriptionFile: pseudoFile(v.descriptionFile),
  isMetaDataSynced: v.isMetaDataSynced,
  createdAt: mask(v.createdAt),
  updatedAt: mask(v.updatedAt),
  saveDirectory: pseudoDir(v.saveDirectory),
  onlineThumbnail: v.onlineThumbnail
    ? `https://thumbs.example/${hash("thumb", String(v.onlineThumbnail))}.jpg`
    : v.onlineThumbnail,
  raw_metadata: pseudoRawMetadata(v.raw_metadata as Row | null),
  missingExtras: Array.isArray(v.missingExtras)
    ? v.missingExtras.filter((e) => KEPT_EXTRAS.has(String(e)))
    : v.missingExtras,
  lastDownloadError: v.lastDownloadError === null
    ? null
    : "redacted by the seed builder",
  downloadFailureReason: KEPT_FAILURES.has(String(v.downloadFailureReason))
    ? v.downloadFailureReason
    : null,
  extrasSyncAttempts: v.extrasSyncAttempts,
  chapters: Array.isArray(v.chapters)
    ? (v.chapters as Row[]).map((c, i) => ({
      start: c.start,
      end: c.end,
      title: `Chapter ${i + 1}`,
    }))
    : v.chapters,
}));

const mappingColumns = [
  "id",
  "videoUrl",
  "playlistUrl",
  "positionInPlaylist",
  "createdAt",
  "updatedAt",
];
const mappings = rows.mapping.map((m) => ({
  id: hashUuid("mapping", String(m.id)),
  videoUrl: pseudoVideoUrl(String(m.videoUrl)),
  playlistUrl: pseudoPlaylistUrl(String(m.playlistUrl)),
  positionInPlaylist: m.positionInPlaylist,
  createdAt: mask(m.createdAt),
  updatedAt: mask(m.updatedAt),
}));

const botColumns = [
  "id",
  "platform",
  "chatId",
  "messageId",
  "requestedUrl",
  "canonicalUrl",
  "kind",
  "playlistUrl",
  "status",
  "deliveryMode",
  "retention",
  "downloadedByBot",
  "expiresAt",
  "errorMessage",
  "createdAt",
  "updatedAt",
  "requestedDeliveryMode",
];
function numericId(domain: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const digest = createHmac("sha256", KEY!).update(`${domain}\0${value}`)
    .digest();
  return String(100_000_000 + digest.readUInt32BE(0) % 900_000_000);
}
const bots = rows.bot.map((b) => ({
  id: hashUuid("bot", String(b.id)),
  platform: b.platform,
  chatId: numericId("chat", b.chatId),
  messageId: numericId("message", b.messageId),
  requestedUrl: pseudoUrl(b.requestedUrl),
  canonicalUrl: b.canonicalUrl ? pseudoVideoUrl(String(b.canonicalUrl)) : null,
  kind: b.kind,
  playlistUrl: b.playlistUrl ? pseudoPlaylistUrl(String(b.playlistUrl)) : null,
  status: b.status,
  deliveryMode: b.deliveryMode,
  retention: b.retention,
  downloadedByBot: b.downloadedByBot,
  expiresAt: mask(b.expiresAt),
  errorMessage: b.errorMessage === null ? null : "redacted by the seed builder",
  createdAt: mask(b.createdAt),
  updatedAt: mask(b.updatedAt),
  requestedDeliveryMode: b.requestedDeliveryMode,
}));

// --------------------------------------------------------------------------
// Write
// --------------------------------------------------------------------------

function cell(value: unknown): string {
  if (value === null || value === undefined) return "\\N";
  if (typeof value === "boolean") return value ? "t" : "f";
  const text = typeof value === "object"
    ? JSON.stringify(value)
    : String(value);
  return text.replace(/\\/g, "\\\\").replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function copy(table: string, columns: string[], data: Row[]): string {
  const head = `COPY ${table} (${
    columns.map((c) => `"${c}"`).join(", ")
  }) FROM stdin;`;
  const body = data.map((row) => columns.map((c) => cell(row[c])).join("\t"));
  return [head, ...body, "\\.", ""].join("\n");
}

const password = "seed-password";
const salt = await bcrypt.genSalt(10);
const now = "2026-11-06T00:00:00.000Z";
const users = [{
  id: hashUuid("user", "seed-admin"),
  username: "seed-admin",
  passwordHash: await bcrypt.hash(password, salt),
  passwordSalt: salt,
  createdAt: now,
  updatedAt: now,
}];

const sql = [
  "-- Pseudonymized test data for yt-diff. Generated by build_seed.ts; see README.md.",
  `-- Test login: seed-admin / ${password} (not a real account anywhere).`,
  "-- Data only, with explicit column lists: the app creates the schema, so columns",
  "-- added by later plans simply stay null here.",
  "SET client_encoding = 'UTF8';",
  "BEGIN;",
  "TRUNCATE bot_submissions, playlist_video_mappings, video_metadata, playlist_metadata, user_accounts, bot_heartbeats CASCADE;",
  "",
  copy("playlist_metadata", playlistColumns, playlists),
  copy("video_metadata", videoColumns, videos),
  copy("playlist_video_mappings", mappingColumns, mappings),
  copy("bot_submissions", botColumns, bots),
  copy("user_accounts", [
    "id",
    "username",
    "passwordHash",
    "passwordSalt",
    "createdAt",
    "updatedAt",
  ], users),
  "COMMIT;",
  "ANALYZE;",
  "",
].join("\n");

await Deno.writeTextFile(outputPath, sql);
console.log(
  `playlists=${playlists.length} videos=${videos.length} mappings=${mappings.length} bot=${bots.length} bytes=${sql.length}`,
);
