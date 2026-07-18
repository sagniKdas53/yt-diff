/**
 * yt-diff Telegram Bot (Deno / grammY)
 *
 * Flow:
 *   User sends URL → extract & validate → lookup in yt-diff
 *   → if not indexed: submit for listing → poll until indexed
 *   → start download → poll until downloaded
 *   → deliver: ≤50MB as direct video, >50MB as signed URL
 *
 * Environment variables:
 *   TELEGRAM_TOKEN      — Telegram bot token from @BotFather
 *   BOT_API_KEY         — Shared secret for yt-diff bot auth
 *   YTDIFF_API_BASE     — Base URL of yt-diff (e.g. http://yt-diff:8888/ytdiff)
 *   BOT_MODE            — "ephemeral" or "persistent" (default)
 *   EPHEMERAL_TTL_HOURS — Hours before ephemeral videos are deleted (default 24)
 */

import { Bot } from "https://deno.land/x/grammy@v1.34.0/mod.ts";

const TELEGRAM_TOKEN = Deno.env.get("TELEGRAM_TOKEN");
const BOT_API_KEY = Deno.env.get("BOT_API_KEY");
const YTDIFF_API_BASE = Deno.env.get("YTDIFF_API_BASE") ||
  "http://yt-diff:8888/ytdiff";
const BOT_MODE = Deno.env.get("BOT_MODE") || "persistent";
const EPHEMERAL_TTL_HOURS = parseInt(
  Deno.env.get("EPHEMERAL_TTL_HOURS") || "24",
  10,
);

const MAX_DIRECT_FILE_SIZE = 50 * 1024 * 1024; // Telegram bot API limit
const SIGNED_URL_TTL = 86400;

if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_TOKEN is required");
  Deno.exit(1);
}
if (!BOT_API_KEY) {
  console.error("BOT_API_KEY is required");
  Deno.exit(1);
}

// ── yt-diff API helpers ───────────────────────────────────────────
async function ytPost(endpoint: string, body: Record<string, unknown>) {
  const url = `${YTDIFF_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Key": BOT_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`yt-diff API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function lookupUrl(rawUrl: string) {
  return ytPost("/lookup", { url: rawUrl });
}

async function submitListing(rawUrl: string) {
  return ytPost("/list", {
    urlList: [rawUrl],
    monitoringType: BOT_MODE === "ephemeral" ? "N/A" : "End",
  });
}

async function startDownload(canonicalUrl: string) {
  return ytPost("/download", {
    urlList: [canonicalUrl],
    playListUrl: BOT_MODE === "ephemeral" ? "None" : undefined,
  });
}

async function getSignedUrl(saveDirectory: string, fileName: string) {
  return ytPost("/getfile", { saveDirectory, fileName });
}

const URL_RE = /https?:\/\/[^\s]+/;

// ── Bot ───────────────────────────────────────────────────────────
const bot = new Bot(TELEGRAM_TOKEN);

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const urlMatch = text.match(URL_RE);
  if (!urlMatch) return;

  const rawUrl = urlMatch[0];

  try {
    // Step 1: Lookup
    await ctx.reply("🔍 Checking URL in yt-diff…");
    let lookup = await lookupUrl(rawUrl);

    // Step 2: Index if needed
    if (lookup.status === "not_found") {
      await ctx.reply("📋 URL not indexed. Submitting for indexing…");
      await submitListing(rawUrl);

      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        lookup = await lookupUrl(rawUrl);
        if (lookup.status === "found") break;
      }

      if (lookup.status !== "found") {
        return ctx.reply(
          "⚠️ Indexing timed out. Try again in a minute.",
        );
      }
    }

    const video = lookup.video;
    if (!video) {
      return ctx.reply("⚠️ Could not find video metadata.");
    }

    // Step 3: Download if needed
    if (!video.fileExists) {
      await ctx.reply(`⬇️ Downloading: **${video.title}**…`);
      await startDownload(video.videoUrl);

      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        lookup = await lookupUrl(rawUrl);
        if (lookup.video?.fileExists) break;
      }

      if (!lookup.video?.fileExists) {
        return ctx.reply(
          `⏳ Download still in progress. Check back later.`,
        );
      }

      lookup = await lookupUrl(rawUrl);
    }

    // Step 4: Deliver
    const v = lookup.video;
    const fileSize = v.fileSizeBytes || 0;

    if (fileSize <= MAX_DIRECT_FILE_SIZE && fileSize > 0) {
      const signed = await getSignedUrl(v.saveDirectory || "", v.fileName);
      if (signed.signedUrlId) {
        const dlUrl = `${YTDIFF_API_BASE}/getfile?fileId=${signed.signedUrlId}`;
        await ctx.replyWithVideo(dlUrl, {
          caption: `📹 ${v.title}`,
        });
      }
    } else {
      const signed = await getSignedUrl(v.saveDirectory || "", v.fileName);
      if (signed.signedUrlId) {
        const dlUrl = `${YTDIFF_API_BASE}/getfile?fileId=${signed.signedUrlId}`;
        const expiryDate = new Date(signed.expiry * 1000).toLocaleString();
        const sizeStr = fileSize > 0
          ? `📏 Size: ${(fileSize / 1024 / 1024).toFixed(1)} MB\n`
          : "";
        await ctx.reply(
          `📹 **${v.title}**\n${sizeStr}` +
            `🔗 [Download Link](${dlUrl}) _(expires ${expiryDate})_`,
          { parse_mode: "Markdown" },
        );
      }
    }
  } catch (error) {
    console.error("Bot error:", error);
    await ctx.reply(`❌ Error: ${error.message}`).catch(() => {});
  }
});

bot.start({
  onStart: (info) => {
    console.log(`yt-diff Telegram bot ready — @${info.username}`);
  },
});
