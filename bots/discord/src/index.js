/**
 * yt-diff Discord Bot
 *
 * Flow:
 *   User sends URL → extract & validate → lookup in yt-diff
 *   → if not indexed: submit for listing → poll until indexed
 *   → start download → poll until downloaded
 *   → deliver: ≤25MB as attachment, >25MB as signed URL
 *
 * Environment variables:
 *   DISCORD_TOKEN       — Discord bot token
 *   BOT_API_KEY         — Shared secret for yt-diff bot auth
 *   YTDIFF_API_BASE     — Base URL of yt-diff (e.g. http://yt-diff:8888/ytdiff)
 *   BOT_MODE            — "ephemeral" (auto-delete after TTL) or "persistent" (default)
 *   EPHEMERAL_TTL_HOURS — Hours before ephemeral videos are deleted (default 24)
 */

import "dotenv/config";
import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BOT_API_KEY = process.env.BOT_API_KEY;
const YTDIFF_API_BASE = process.env.YTDIFF_API_BASE || "http://yt-diff:8888/ytdiff";
const BOT_MODE = process.env.BOT_MODE || "persistent";
const EPHEMERAL_TTL_HOURS = parseInt(process.env.EPHEMERAL_TTL_HOURS || "24", 10);

// Discord file size limits (non-boosted: 25MB, level 1: 50MB — be conservative)
const MAX_DIRECT_FILE_SIZE = 25 * 1024 * 1024;
const SIGNED_URL_TTL = 86400; // 24 hours

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is required");
  process.exit(1);
}
if (!BOT_API_KEY) {
  console.error("BOT_API_KEY is required");
  process.exit(1);
}

// ── URL extraction regex ──────────────────────────────────────────
const URL_RE = /https?:\/\/[^\s]+/;

// ── yt-diff API helpers ───────────────────────────────────────────
async function ytPost(endpoint, body) {
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

async function lookupUrl(rawUrl) {
  return ytPost("/lookup", { url: rawUrl });
}

async function submitListing(rawUrl) {
  return ytPost("/list", {
    urlList: [rawUrl],
    monitoringType: BOT_MODE === "ephemeral" ? "N/A" : "End",
  });
}

async function startDownload(canonicalUrl) {
  return ytPost("/download", {
    urlList: [canonicalUrl],
    playListUrl: BOT_MODE === "ephemeral" ? "None" : undefined,
  });
}

async function getSignedUrl(saveDirectory, fileName) {
  return ytPost("/getfile", { saveDirectory, fileName });
}

async function pollQueueStatus() {
  return ytPost("/queuestatus", {});
}

// ── Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`yt-diff Discord bot ready — logged in as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const urlMatch = message.content.match(URL_RE);
  if (!urlMatch) return;

  const rawUrl = urlMatch[0];
  const reply = (text) =>
    message.reply({ content: text, flags: MessageFlags.SuppressEmbeds });

  try {
    // Step 1: Lookup
    await reply("🔍 Checking URL in yt-diff…");
    let lookup = await lookupUrl(rawUrl);

    // Step 2: Index if needed
    if (lookup.status === "not_found") {
      await reply("📋 URL not indexed. Submitting for indexing…");
      await submitListing(rawUrl);

      // Poll until indexed (max 60 seconds)
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        lookup = await lookupUrl(rawUrl);
        if (lookup.status === "found") break;
      }

      if (lookup.status !== "found") {
        return reply("⚠️ Indexing timed out. The video may still be processing — try again in a minute.");
      }
    }

    const video = lookup.video;
    if (!video) {
      return reply("⚠️ Could not find video metadata.");
    }

    // Step 3: Download if needed
    if (!video.fileExists) {
      await reply(`⬇️ Downloading: **${video.title}**…`);
      await startDownload(video.videoUrl);

      // Poll until downloaded (max 5 minutes)
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        lookup = await lookupUrl(rawUrl);
        if (lookup.video?.fileExists) break;
        // Check queue status for progress
        const queue = await pollQueueStatus();
        const inQueue = queue.queue?.find((q) => q.url === video.videoUrl);
        if (inQueue && inQueue.status === "failed") {
          return reply(`❌ Download failed for: **${video.title}**`);
        }
      }

      if (!lookup.video?.fileExists) {
        return reply(`⏳ Download still in progress for: **${video.title}**. Check back later.`);
      }

      // Refresh after download
      lookup = await lookupUrl(rawUrl);
    }

    // Step 4: Deliver
    const v = lookup.video;
    const fileSize = v.fileSizeBytes || 0;

    if (fileSize <= MAX_DIRECT_FILE_SIZE && fileSize > 0) {
      // Small file — generate signed URL and send as attachment
      const signed = await getSignedUrl(v.saveDirectory || "", v.fileName);
      if (signed.signedUrlId) {
        const dlUrl = `${YTDIFF_API_BASE}/getfile?fileId=${signed.signedUrlId}`;
        await message.reply({
          content: `📹 **${v.title}**`,
          files: [{ attachment: dlUrl, name: v.fileName || "video.mp4" }],
          flags: MessageFlags.SuppressEmbeds,
        });
      } else {
        return reply(`❌ Failed to generate download URL for: **${v.title}**`);
      }
    } else if (fileSize > MAX_DIRECT_FILE_SIZE) {
      // Large file — send signed URL
      const signed = await getSignedUrl(v.saveDirectory || "", v.fileName);
      if (signed.signedUrlId) {
        const dlUrl = `${YTDIFF_API_BASE}/getfile?fileId=${signed.signedUrlId}`;
        const expiryDate = new Date(signed.expiry * 1000).toLocaleString();
        await reply(
          `📹 **${v.title}**\n` +
          `📏 Size: ${(fileSize / 1024 / 1024).toFixed(1)} MB (too large for Discord)\n` +
          `🔗 [Download Link](${dlUrl}) _(expires ${expiryDate})_`,
        );
      } else {
        return reply(`❌ Failed to generate download URL.`);
      }
    } else {
      // Unknown size — fallback to signed URL
      const signed = await getSignedUrl(v.saveDirectory || "", v.fileName);
      if (signed.signedUrlId) {
        const dlUrl = `${YTDIFF_API_BASE}/getfile?fileId=${signed.signedUrlId}`;
        const expiryDate = new Date(signed.expiry * 1000).toLocaleString();
        await reply(
          `📹 **${v.title}**\n🔗 [Download Link](${dlUrl}) _(expires ${expiryDate})_`,
        );
      }
    }
  } catch (error) {
    console.error("Bot error:", error);
    await reply(`❌ Error: ${error.message}`).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
