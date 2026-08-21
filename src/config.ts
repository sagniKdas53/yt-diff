function readTrimmedFile(filePath: string): string {
  return Deno.readTextFileSync(filePath).trim();
}

function fileExists(filePath: string): boolean {
  try {
    Deno.statSync(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export type BotConfig = AppConfig["bot"];

/**
 * Cheap structural check for a cron expression.
 *
 * Not a full parser — the CronJob constructor is the real authority — but it
 * catches the common typo before it can throw during job construction, where an
 * uncaught error would take the whole server down rather than just the bot.
 */
function looksLikeCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return false;
  }
  return fields.every((field) => /^[0-9*/,\-?A-Za-z]+$/.test(field));
}

/**
 * Builds the bot configuration and decides whether it is safe to enable.
 *
 * Fails closed: an open bot on a yt-dlp box lets anyone who can message it make
 * the server fetch arbitrary URLs and fill the disk, so every misconfiguration
 * disables the bot outright rather than degrading it. The reason is returned in
 * `_configError` for the bootstrap to log, because config.ts cannot import the
 * logger without a cycle.
 *
 * Dependencies are injected so the guard can be tested without mutating the
 * process environment.
 *
 * @param getEnv - Environment lookup
 * @param readFile - Reads and trims a secret file
 */
export function resolveBotConfig(
  getEnv: (key: string) => string | undefined,
  readFile: (path: string) => string,
): AppConfig["bot"] {
  const requested = getEnv("BOT_ENABLED") === "true";

  const allowedChatIds = (getEnv("BOT_ALLOWED_CHAT_IDS") || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  const rawRetentionMode = (getEnv("BOT_RETENTION_MODE") || "ephemeral")
    .toLowerCase();
  const retentionMode = rawRetentionMode === "persistent"
    ? "persistent" as const
    : "ephemeral" as const;

  const reapInterval = getEnv("BOT_REAP_INTERVAL") || "0 * * * *";
  const retentionHours = +(getEnv("BOT_RETENTION_HOURS") ?? 24);

  let telegramToken = "";
  let configError: Error | null = null;
  const tokenFile = getEnv("BOT_TELEGRAM_TOKEN_FILE");
  try {
    telegramToken = tokenFile
      ? readFile(tokenFile)
      : getEnv("BOT_TELEGRAM_TOKEN")?.trim() || "";
  } catch (e) {
    // A token file that was named but cannot be read is a misconfiguration,
    // not a reason to silently fall back to an inline token.
    configError = e instanceof Error ? e : new Error(String(e));
  }

  if (requested && !configError) {
    if (allowedChatIds.length === 0) {
      configError = new Error(
        "BOT_ENABLED is true but BOT_ALLOWED_CHAT_IDS is empty; refusing to start an unrestricted bot",
      );
    } else if (!telegramToken) {
      configError = new Error(
        "BOT_ENABLED is true but no bot token was provided; set BOT_TELEGRAM_TOKEN_FILE or BOT_TELEGRAM_TOKEN",
      );
    } else if (rawRetentionMode !== retentionMode) {
      configError = new Error(
        `BOT_RETENTION_MODE must be "ephemeral" or "persistent", got "${rawRetentionMode}"`,
      );
    } else if (!Number.isFinite(retentionHours) || retentionHours < 0) {
      configError = new Error(
        `BOT_RETENTION_HOURS must be a non-negative number, got "${
          getEnv("BOT_RETENTION_HOURS")
        }"`,
      );
    } else if (retentionMode === "ephemeral" && !looksLikeCron(reapInterval)) {
      // Only relevant in ephemeral mode; persistent never builds the job.
      configError = new Error(
        `BOT_REAP_INTERVAL must be a cron expression, got "${reapInterval}"`,
      );
    }
  }

  return {
    enabled: requested && configError === null,
    telegramToken,
    allowedChatIds,
    publicBaseUrl: (getEnv("BOT_PUBLIC_BASE_URL") || "").replace(/\/+$/, ""),
    retentionMode,
    retentionHours,
    reapInterval,
    telegramMaxUpload: +(getEnv("BOT_TELEGRAM_MAX_UPLOAD") || 50000000),
    maxPendingPerChat: +(getEnv("BOT_MAX_PENDING_PER_CHAT") || 5),
    largeFileWarnBytes: +(getEnv("BOT_LARGE_FILE_WARN") || 104857600),
    _configError: configError,
  };
}

/**
 * The origin this server tells the outside world it answers on.
 *
 * Single source of truth for the startup "Server listening on ..." line and for
 * the chat bot's download links, which must agree — a link built from a
 * different origin than the one being logged is the kind of bug you only notice
 * on a phone that cannot resolve it.
 */
export function buildPublicOrigin(
  parts: { protocol: string; host: string; port: number; hidePorts: boolean },
): string {
  const port = parts.hidePorts ? "" : `:${parts.port}`;
  return `${parts.protocol}://${parts.host}${port}`;
}

/** Reads an integer env var, falling back when unset, empty, or unparseable. */
function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Throttling configuration.
 *
 * Two tiers, because they can see different things:
 *
 *   - `auth` / `publicRead` / `action` are *admission* budgets. They run before
 *     authentication, so they can only key on the client address and count
 *     requests. They exist to stop unauthenticated floods.
 *   - `work` is the budget that does the real job. It is charged after the body
 *     is parsed and the user is verified, in units of queued work, so a single
 *     request that queues two hundred playlist re-scans is priced as two
 *     hundred re-scans rather than as one request.
 *
 * Defaults are set well above realistic interactive use and above what the E2E
 * suite generates, so a normal session or a test run never sees a 429. Any
 * budget set to 0 disables that tier, which stays available as an explicit
 * opt-out but is no longer what an operator gets by omitting a variable.
 */
function buildRateLimitConfig(): AppConfig["rateLimit"] {
  const hour = 3600;
  return {
    auth: {
      burst: envInt("RATE_LIMIT_AUTH_BURST", 30),
      refill: envInt("RATE_LIMIT_AUTH_REFILL", 30),
      periodSec: envInt("RATE_LIMIT_AUTH_PERIOD_SEC", hour),
    },
    publicRead: {
      burst: envInt("RATE_LIMIT_PUBLIC_BURST", 240),
      refill: envInt("RATE_LIMIT_PUBLIC_REFILL", 240),
      periodSec: envInt("RATE_LIMIT_PUBLIC_PERIOD_SEC", hour),
    },
    action: {
      burst: envInt("RATE_LIMIT_ACTION_BURST", 600),
      refill: envInt("RATE_LIMIT_ACTION_REFILL", 600),
      periodSec: envInt("RATE_LIMIT_ACTION_PERIOD_SEC", hour),
    },
    work: {
      burst: envInt("RATE_LIMIT_WORK_BURST", 3000),
      refill: envInt("RATE_LIMIT_WORK_REFILL", 3000),
      periodSec: envInt("RATE_LIMIT_WORK_PERIOD_SEC", hour),
    },
    weights: {
      requestBase: envInt("RATE_LIMIT_WEIGHT_BASE", 1),
      listFullScan: envInt("RATE_LIMIT_WEIGHT_LIST_FULL", 10),
      listIncremental: envInt("RATE_LIMIT_WEIGHT_LIST_INCREMENTAL", 2),
      download: envInt("RATE_LIMIT_WEIGHT_DOWNLOAD", 1),
    },
  };
}

export interface AppConfig {
  protocol: string;
  host: string;
  port: number;
  nativeHttps: boolean;
  hidePorts: boolean;
  defaultCORSMaxAge: number;
  urlBase: string;
  /** protocol://host[:port], no trailing slash and no urlBase. */
  publicOrigin: string;
  ssl: {
    key: string | null;
    cert: string | null;
    passphrase: string | null;
  };
  db: {
    host: string;
    port: number;
    user: string;
    name: string;
    password: string | Error | undefined;
  };
  redis: {
    host: string;
    port: number;
    password: string | null;
  };
  cache: {
    maxItems: number;
    maxAge: number;
  };
  rateLimit: {
    /** Login and registration. Kept tight — this is the brute-force surface. */
    auth: { burst: number; refill: number; periodSec: number };
    /** Unauthenticated reads such as `/isregallowed`. */
    publicRead: { burst: number; refill: number; periodSec: number };
    /** Pre-auth admission for `/list` and `/download`. Counts requests only. */
    action: { burst: number; refill: number; periodSec: number };
    /** Post-auth budget, charged in units of queued work per user. */
    work: { burst: number; refill: number; periodSec: number };
    weights: {
      requestBase: number;
      listFullScan: number;
      listIncremental: number;
      download: number;
    };
  };
  queue: {
    maxListings: number;
    maxDownloads: number;
    cleanUpInterval: string;
    maxIdle: number;
    maxLifetime: number;
  };
  registration: {
    allowed: boolean;
    maxUsers: number;
  };
  saveLocation: string;
  cookiesFile: string | false | Error | undefined;
  proxy_string: string | Error;
  sleepTime: string;
  chunkSize: number;
  scheduledUpdateStr: string;
  pruneInterval: string;
  timeZone: string;
  saveSubs: boolean;
  saveDescription: boolean;
  saveComments: boolean;
  saveThumbnail: boolean;
  restrictFilenames: boolean;
  maxFileNameLength: number;
  forceOverwrites: boolean;
  logLevel: string;
  logDisableColors: boolean;
  maxTitleLength: number;
  saltRounds: number;
  secretKey: string | Error;
  iwara: {
    username: string;
    password: string;
    _parseError: Error | null;
  };
  youtubeApi: {
    mode: "oauth" | "apikey";
    apiKey?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
  } | null;
  bot: {
    /**
     * Effective switch. False whenever the bot is misconfigured, so that a
     * broken config can never result in a running, unguarded bot.
     */
    enabled: boolean;
    telegramToken: string;
    /** Chats permitted to command the bot. Empty means the bot stays off. */
    allowedChatIds: string[];
    /** External origin for signed URLs; config.host is often container-internal. */
    publicBaseUrl: string;
    retentionMode: "ephemeral" | "persistent";
    retentionHours: number;
    reapInterval: string;
    telegramMaxUpload: number;
    maxPendingPerChat: number;
    /** Warn in chat when a queued item's size estimate exceeds this. */
    largeFileWarnBytes: number;
    /** Why the bot refused to enable itself; logged once during bootstrap. */
    _configError: Error | null;
  };
  maxClients: number;
  connectedClients: number;
}

interface IwaraConfigInput {
  username?: string;
  password?: string;
}

// Lifted out of the object literal so publicOrigin can be derived from them
// rather than repeating the same four env reads.
//
// Note `protocol` here is PROTOCOL as configured. index.ts later rewrites
// `config.protocol` to match the listener (HTTP unless USE_NATIVE_HTTPS), which
// behind a TLS-terminating proxy is not what the outside world sees. publicOrigin
// is deliberately computed before that rewrite: it describes the origin a browser
// or phone connects to, not the socket the process opened.
const protocol = Deno.env.get("PROTOCOL") || "http";
const host = Deno.env.get("HOSTNAME") || "localhost";
const port = +(Deno.env.get("PORT") || 8888);
const hidePorts = Deno.env.get("HIDE_PORTS") === "true";

export const config: AppConfig = {
  protocol,
  host,
  port,
  nativeHttps: Deno.env.get("USE_NATIVE_HTTPS") === "true" || false,
  hidePorts,
  defaultCORSMaxAge: 2592000,
  urlBase: Deno.env.get("BASE_URL") || "/ytdiff",
  publicOrigin: buildPublicOrigin({ protocol, host, port, hidePorts }),
  ssl: {
    key: Deno.env.get("SSL_KEY") || null,
    cert: Deno.env.get("SSL_CERT") || null,
    passphrase: Deno.env.get("SSL_PASSPHRASE") || null,
  },
  db: {
    host: Deno.env.get("DB_HOST") || "localhost",
    // Inside the compose network this is always 5432; it is configurable so a
    // host-side dev run can reach a container published on a different port.
    port: +(Deno.env.get("DB_PORT") || 5432),
    user: Deno.env.get("DB_USERNAME") || "ytdiff",
    name: "vidlist",
    password: (() => {
      try {
        return Deno.env.get("DB_PASSWORD_FILE")
          ? readTrimmedFile(Deno.env.get("DB_PASSWORD_FILE")!)
          : Deno.env.get("DB_PASSWORD") && Deno.env.get("DB_PASSWORD")!.trim()
          ? Deno.env.get("DB_PASSWORD")
          : new Error(
            "DB_PASSWORD or DB_PASSWORD_FILE environment variable must be set",
          );
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    })(),
  },
  redis: {
    host: Deno.env.get("REDIS_HOST") || "localhost",
    port: +(Deno.env.get("REDIS_PORT") || 6379),
    password: Deno.env.get("REDIS_PASSWORD") || null,
  },
  cache: {
    maxItems: +(Deno.env.get("CACHE_MAX_ITEMS") || 500),
    maxAge: +(Deno.env.get("CACHE_MAX_AGE") || 3600),
  },
  rateLimit: buildRateLimitConfig(),
  queue: {
    // Parallelims be damned, I don't care.
    maxListings: +(Deno.env.get("MAX_LISTINGS") || 1),
    maxDownloads: +(Deno.env.get("MAX_DOWNLOADS") || 1),
    cleanUpInterval: Deno.env.get("CLEANUP_INTERVAL") || "*/10 * * * *",
    maxIdle: +(Deno.env.get("PROCESS_MAX_AGE") || 5 * 60 * 1000),
    maxLifetime: +(Deno.env.get("PROCESS_MAX_LIFETIME") || 15 * 60 * 1000),
  },
  registration: {
    allowed: Deno.env.get("ALLOW_REGISTRATION") !== "false",
    maxUsers: +(Deno.env.get("MAX_USERS") || 15),
  },
  saveLocation: Deno.env.get("SAVE_PATH") ||
    "/home/sagnik/Documents/syncthing/pi5/yt-diff-data/",
  cookiesFile: Deno.env.get("COOKIES_FILE")
    ? fileExists(Deno.env.get("COOKIES_FILE")!)
      ? Deno.env.get("COOKIES_FILE")
      : new Error(`Cookies file not found: ${Deno.env.get("COOKIES_FILE")}`)
    : false,
  proxy_string: (() => {
    try {
      return Deno.env.get("PROXY_STRING_FILE")
        ? readTrimmedFile(Deno.env.get("PROXY_STRING_FILE")!)
          .replace(/['"\n]+/g, "")
        : Deno.env.get("PROXY_STRING") && Deno.env.get("PROXY_STRING")!.trim()
        ? `${Deno.env.get("PROXY_STRING")!.trim().replace(/['"\n]+/g, "")}`
        : "";
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })(),
  sleepTime: Deno.env.get("SLEEP") ?? "3",
  chunkSize: +(Deno.env.get("CHUNK_SIZE_DEFAULT") || 10),
  scheduledUpdateStr: Deno.env.get("UPDATE_SCHEDULED") || "*/10 * * * *",
  pruneInterval: Deno.env.get("PRUNE_INTERVAL") || "*/10 * * * *",
  timeZone: Deno.env.get("TZ_PREFERRED") || "Asia/Kolkata",
  saveSubs: Deno.env.get("SAVE_SUBTITLES") !== "false",
  saveDescription: Deno.env.get("SAVE_DESCRIPTION") !== "false",
  saveComments: Deno.env.get("SAVE_COMMENTS") !== "false",
  saveThumbnail: Deno.env.get("SAVE_THUMBNAIL") !== "false",
  restrictFilenames: Deno.env.get("RESTRICT_FILENAMES") !== "false",
  maxFileNameLength: +(Deno.env.get("MAX_FILENAME_LENGTH") || NaN),
  forceOverwrites: Deno.env.get("FORCE_OVERWRITES") === "true",
  logLevel: (Deno.env.get("LOG_LEVELS") || "trace").toLowerCase(),
  logDisableColors: Deno.env.get("NO_COLOR") === "true",
  maxTitleLength: 255,
  saltRounds: 10,
  secretKey: (() => {
    try {
      return Deno.env.get("SECRET_KEY_FILE")
        ? readTrimmedFile(Deno.env.get("SECRET_KEY_FILE")!)
        : Deno.env.get("SECRET_KEY") && Deno.env.get("SECRET_KEY")!.trim()
        ? Deno.env.get("SECRET_KEY")!.trim()
        : new Error(
          "SECRET_KEY or SECRET_KEY_FILE environment variable must be set",
        );
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })(),
  iwara: (() => {
    let conf: IwaraConfigInput = {};
    let parseError: Error | null = null;
    try {
      const confStr = Deno.env.get("IWARA_CONF_FILE")
        ? readTrimmedFile(Deno.env.get("IWARA_CONF_FILE")!)
        : Deno.env.get("IWARA_CONF") && Deno.env.get("IWARA_CONF")!.trim()
        ? Deno.env.get("IWARA_CONF")!.trim()
        : "";
      if (confStr) {
        conf = JSON.parse(confStr) as IwaraConfigInput;
      }
    } catch (e) {
      parseError = e instanceof Error ? e : new Error(String(e));
    }
    return {
      username: Deno.env.get("IWARA_USERNAME") || conf.username || "",
      password: Deno.env.get("IWARA_PASSWORD") || conf.password || "",
      _parseError: parseError,
    };
  })(),
  youtubeApi: (() => {
    const getEnvOrFile = (envVar: string, fileVar: string) => {
      try {
        return Deno.env.get(fileVar)
          ? readTrimmedFile(Deno.env.get(fileVar)!)
          : Deno.env.get(envVar) || "";
      } catch {
        return Deno.env.get(envVar) || "";
      }
    };

    const clientId = getEnvOrFile(
      "YOUTUBE_CLIENT_ID",
      "YOUTUBE_CLIENT_ID_FILE",
    );
    const clientSecret = getEnvOrFile(
      "YOUTUBE_CLIENT_SECRET",
      "YOUTUBE_CLIENT_SECRET_FILE",
    );
    const refreshToken = getEnvOrFile(
      "YOUTUBE_REFRESH_TOKEN",
      "YOUTUBE_REFRESH_TOKEN_FILE",
    );
    const apiKey = getEnvOrFile("YOUTUBE_API_KEY", "YOUTUBE_API_KEY_FILE");

    // OAuth takes priority — covers both public and private playlists
    if (clientId && clientSecret && refreshToken) {
      return {
        mode: "oauth" as const,
        clientId,
        clientSecret,
        refreshToken,
      };
    }

    // API key — public/unlisted playlists only
    if (apiKey) {
      return {
        mode: "apikey" as const,
        apiKey,
      };
    }

    return null;
  })(),

  bot: resolveBotConfig(
    (key) => Deno.env.get(key),
    readTrimmedFile,
  ),

  maxClients: 10,
  connectedClients: 0,
};

export const YT_DLP_PATCHED_CMD =
  "import curl_cffi.curl; curl_cffi.curl.Curl.reset = lambda self: None; import sys, yt_dlp; sys.exit(yt_dlp.main())";
