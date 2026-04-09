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

export interface AppConfig {
  protocol: string;
  host: string;
  port: number;
  nativeHttps: boolean;
  hidePorts: boolean;
  defaultCORSMaxAge: number;
  urlBase: string;
  ssl: {
    key: string | null;
    cert: string | null;
    passphrase: string | null;
  };
  db: {
    host: string;
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
    reqPerIP: number;
    actionReqPerIP: number;
    actionWindowSec: number;
  };
  queue: {
    maxListings: number;
    maxDownloads: number;
    cleanUpInterval: string;
    maxIdle: number;
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
  maxClients: number;
  connectedClients: number;
}

interface IwaraConfigInput {
  username?: string;
  password?: string;
}

export const config: AppConfig = {
  protocol: Deno.env.get("PROTOCOL") || "http",
  host: Deno.env.get("HOSTNAME") || "localhost",
  port: +(Deno.env.get("PORT") || 8888),
  nativeHttps: Deno.env.get("USE_NATIVE_HTTPS") === "true" || false,
  hidePorts: Deno.env.get("HIDE_PORTS") === "true",
  defaultCORSMaxAge: 2592000,
  urlBase: Deno.env.get("BASE_URL") || "/ytdiff",
  ssl: {
    key: Deno.env.get("SSL_KEY") || null,
    cert: Deno.env.get("SSL_CERT") || null,
    passphrase: Deno.env.get("SSL_PASSPHRASE") || null,
  },
  db: {
    host: Deno.env.get("DB_HOST") || "localhost",
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
    reqPerIP: parseInt(
      Deno.env.get("RATE_LIMIT_GLOBAL_MAX_REQUESTS") ?? "0",
      10,
    ),
    actionReqPerIP: parseInt(
      Deno.env.get("RATE_LIMIT_ACTION_MAX_REQUESTS") ?? "0",
      10,
    ),
    actionWindowSec: +(Deno.env.get("ACTION_WINDOW_SEC") || 3600),
  },
  queue: {
    maxListings: +(Deno.env.get("MAX_LISTINGS") || 2),
    maxDownloads: +(Deno.env.get("MAX_DOWNLOADS") || 2),
    cleanUpInterval: Deno.env.get("CLEANUP_INTERVAL") || "*/10 * * * *",
    maxIdle: +(Deno.env.get("PROCESS_MAX_AGE") || 5 * 60 * 1000),
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
  maxClients: 10,
  connectedClients: 0,
};

export const YT_DLP_PATCHED_CMD =
  "import curl_cffi.curl; curl_cffi.curl.Curl.reset = lambda self: None; import sys, yt_dlp; sys.exit(yt_dlp.main())";
