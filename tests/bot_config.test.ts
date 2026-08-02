import { assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import { buildPublicOrigin, resolveBotConfig } from "../src/config.ts";

/** Builds an env lookup over a plain object. */
function env(vars: Record<string, string>) {
  return (key: string) => vars[key];
}

function unreadableFile(): string {
  throw new Deno.errors.NotFound("no such file");
}

const VALID = {
  BOT_ENABLED: "true",
  BOT_ALLOWED_CHAT_IDS: "123456",
  BOT_TELEGRAM_TOKEN: "test-token",
};

Deno.test("botConfig - disabled by default", () => {
  const bot = resolveBotConfig(env({}), unreadableFile);
  assertEquals(bot.enabled, false);
  assertEquals(bot._configError, null);
});

Deno.test("botConfig - fully configured enables the bot", () => {
  const bot = resolveBotConfig(env(VALID), unreadableFile);
  assertEquals(bot.enabled, true);
  assertEquals(bot._configError, null);
  assertEquals(bot.allowedChatIds, ["123456"]);
  assertEquals(bot.telegramToken, "test-token");
});

Deno.test("botConfig - fails closed on an empty allowlist", () => {
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_ALLOWED_CHAT_IDS: "" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertStringIncludes(bot._configError?.message ?? "", "BOT_ALLOWED_CHAT_IDS");
});

Deno.test("botConfig - fails closed on a whitespace-only allowlist", () => {
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_ALLOWED_CHAT_IDS: " , ,  " }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertEquals(bot.allowedChatIds, []);
});

Deno.test("botConfig - fails closed with no token", () => {
  const bot = resolveBotConfig(
    env({ BOT_ENABLED: "true", BOT_ALLOWED_CHAT_IDS: "123" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertStringIncludes(bot._configError?.message ?? "", "no bot token");
});

Deno.test("botConfig - fails closed when the token file cannot be read", () => {
  const bot = resolveBotConfig(
    env({
      BOT_ENABLED: "true",
      BOT_ALLOWED_CHAT_IDS: "123",
      BOT_TELEGRAM_TOKEN_FILE: "/nope/token.txt",
      // An inline token must NOT rescue a named-but-unreadable file.
      BOT_TELEGRAM_TOKEN: "inline-token",
    }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertEquals(bot.telegramToken, "");
});

Deno.test("botConfig - reads the token from a secret file", () => {
  const bot = resolveBotConfig(
    env({
      BOT_ENABLED: "true",
      BOT_ALLOWED_CHAT_IDS: "123",
      BOT_TELEGRAM_TOKEN_FILE: "/run/secrets/tok",
    }),
    () => "file-token",
  );
  assertEquals(bot.enabled, true);
  assertEquals(bot.telegramToken, "file-token");
});

Deno.test("botConfig - fails closed on an unknown retention mode", () => {
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_RETENTION_MODE: "forever" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertStringIncludes(bot._configError?.message ?? "", "BOT_RETENTION_MODE");
});

Deno.test("botConfig - accepts persistent retention case-insensitively", () => {
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_RETENTION_MODE: "Persistent" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, true);
  assertEquals(bot.retentionMode, "persistent");
});

Deno.test("botConfig - a misconfigured but disabled bot reports no error", () => {
  // BOT_ENABLED=false means the other values are never consulted.
  const bot = resolveBotConfig(
    env({ BOT_ENABLED: "false", BOT_ALLOWED_CHAT_IDS: "" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertEquals(bot._configError, null);
});

Deno.test("botConfig - trims the allowlist and public base URL", () => {
  const bot = resolveBotConfig(
    env({
      ...VALID,
      BOT_ALLOWED_CHAT_IDS: " 111 , 222 ,333 ",
      BOT_PUBLIC_BASE_URL: "https://yt.example.com///",
    }),
    unreadableFile,
  );
  assertEquals(bot.allowedChatIds, ["111", "222", "333"]);
  // Trailing slashes are stripped so signed URLs concatenate cleanly.
  assertEquals(bot.publicBaseUrl, "https://yt.example.com");
});

Deno.test("botConfig - applies documented defaults", () => {
  const bot = resolveBotConfig(env(VALID), unreadableFile);
  assertEquals(bot.retentionMode, "ephemeral");
  assertEquals(bot.retentionHours, 24);
  assertEquals(bot.reapInterval, "0 * * * *");
  assertEquals(bot.telegramMaxUpload, 50000000);
  assertEquals(bot.maxPendingPerChat, 5);
});

Deno.test("botConfig - retention hours of 0 is honoured, not defaulted", () => {
  // Used to force immediate reaping when testing retention.
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_RETENTION_HOURS: "0" }),
    unreadableFile,
  );
  assertEquals(bot.retentionHours, 0);
});

Deno.test("botConfig - rejects a non-cron reap interval", () => {
  // An invalid expression used to throw inside the CronJob constructor and take
  // the whole server down; it must fail closed at config time instead.
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_REAP_INTERVAL: "not a cron" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertStringIncludes(bot._configError?.message ?? "", "BOT_REAP_INTERVAL");
});

Deno.test("botConfig - accepts 5- and 6-field cron expressions", () => {
  for (const expr of ["*/15 * * * *", "0 2 * * *", "*/30 * * * * *"]) {
    const bot = resolveBotConfig(
      env({ ...VALID, BOT_REAP_INTERVAL: expr }),
      unreadableFile,
    );
    assertEquals(bot.enabled, true, `should accept ${expr}`);
    assertEquals(bot.reapInterval, expr);
  }
});

Deno.test("botConfig - a bad cron is ignored in persistent mode", () => {
  // Persistent mode never builds the job, so the expression cannot break it.
  const bot = resolveBotConfig(
    env({
      ...VALID,
      BOT_RETENTION_MODE: "persistent",
      BOT_REAP_INTERVAL: "nonsense",
    }),
    unreadableFile,
  );
  assertEquals(bot.enabled, true);
  assertEquals(bot._configError, null);
});

Deno.test("botConfig - rejects non-numeric retention hours", () => {
  // NaN would make expiresAt an Invalid Date and silently break reaping.
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_RETENTION_HOURS: "soon" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
  assertStringIncludes(bot._configError?.message ?? "", "BOT_RETENTION_HOURS");
});

Deno.test("botConfig - rejects negative retention hours", () => {
  const bot = resolveBotConfig(
    env({ ...VALID, BOT_RETENTION_HOURS: "-5" }),
    unreadableFile,
  );
  assertEquals(bot.enabled, false);
});

// ---------------------------------------------------------------------------
// Public origin — shared by the startup log line and the bot's download links.
// ---------------------------------------------------------------------------

Deno.test("publicOrigin - omits the port when hidePorts is set", () => {
  // The pi5/local deployments sit behind traefik on 443, so the port must not
  // appear in a link handed to a phone.
  assertEquals(
    buildPublicOrigin({
      protocol: "https",
      host: "pi5.tail9ece4.ts.net",
      port: 8888,
      hidePorts: true,
    }),
    "https://pi5.tail9ece4.ts.net",
  );
});

Deno.test("publicOrigin - includes the port when hidePorts is false", () => {
  assertEquals(
    buildPublicOrigin({
      protocol: "http",
      host: "localhost",
      port: 8888,
      hidePorts: false,
    }),
    "http://localhost:8888",
  );
});

Deno.test("publicOrigin - carries no trailing slash and no urlBase", () => {
  // Callers append urlBase themselves; a trailing slash here would produce
  // "//ytdiff" in every signed link.
  const origin = buildPublicOrigin({
    protocol: "https",
    host: "yt.example.com",
    port: 443,
    hidePorts: true,
  });
  assertEquals(origin.endsWith("/"), false);
  assertEquals(origin.includes("/ytdiff"), false);
});

Deno.test("publicOrigin - an unset BOT_PUBLIC_BASE_URL falls back to it", () => {
  // resolveBotConfig leaves publicBaseUrl empty; createBotService reads that as
  // "use the server origin". Empty must stay falsy for that || to fire.
  const bot = resolveBotConfig(env(VALID), unreadableFile);
  assertEquals(bot.publicBaseUrl, "");
  assertEquals(
    bot.publicBaseUrl || "fallback-would-apply",
    "fallback-would-apply",
  );
});
