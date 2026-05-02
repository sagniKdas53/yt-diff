import { PlaylistMetadata, sequelize } from "./src/db/models.ts";
import { logger } from "./src/logger.ts";

function canonicalizePlaylistUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);

    // YouTube
    if (
      url.hostname.includes("youtube.com") || url.hostname.includes("youtu.be")
    ) {
      url.hostname = "www.youtube.com";
      const list = url.searchParams.get("list");
      if (list) {
        url.pathname = "/playlist";
        url.search = `?list=${list}`;
      } else if (url.pathname === "/playlist") {
        url.search = "";
      }
    } // Iwara
    else if (url.hostname.includes("iwara.tv")) {
      url.searchParams.delete("sort");
      url.searchParams.delete("page");
    } // Spankbang
    else if (url.hostname.includes("spankbang.com")) {
      url.searchParams.delete("o");
      url.searchParams.delete("p");

      const parts = url.pathname.split("/").filter(Boolean);
      // Format: /<PLAYLIST_ID>/playlist/<SLUG> -> /<PLAYLIST_ID>/playlist
      if (parts.length >= 2 && parts[1] === "playlist") {
        let pid = parts[0];
        // Strip -nohrcs
        if (pid.endsWith("-nohrcs")) {
          pid = pid.replace("-nohrcs", "");
        }
        url.pathname = `/${pid}/playlist`;
      }
    } // XHamster
    else if (url.hostname.includes("xhamster.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      // Format: /creators/<CREATOR_NAME>/newest -> /creators/<CREATOR_NAME>
      if (parts.length >= 2 && parts[0] === "creators") {
        url.pathname = `/creators/${parts[1]}`;
      }
    }

    // General Tracking Strip
    const trackers = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "si",
      "s",
      "rcm",
    ];
    for (const t of trackers) {
      url.searchParams.delete(t);
    }

    return url.toString();
  } catch (_e) {
    return urlStr; // Return original if parsing fails
  }
}

async function checkPlaylistDupes() {
  logger.info("Fetching all playlists...");
  const playlists = await PlaylistMetadata.findAll({
    attributes: ["playlistUrl", "title"],
  });

  logger.info(`Fetched ${playlists.length} playlists.`);

  const canonicalMap = new Map<string, { original: string; title: string }[]>();

  for (const p of playlists) {
    const originalUrl = p.getDataValue("playlistUrl");
    if (originalUrl === "None" || originalUrl === "init") continue;

    const canonicalUrl = canonicalizePlaylistUrl(originalUrl);

    if (!canonicalMap.has(canonicalUrl)) {
      canonicalMap.set(canonicalUrl, []);
    }
    canonicalMap.get(canonicalUrl)!.push({
      original: originalUrl,
      title: p.getDataValue("title"),
    });
  }

  console.log("Canonical Mappings:");
  for (const [canon, items] of canonicalMap.entries()) {
    console.log(`[Canonical] ${canon}`);
    for (const item of items) {
      console.log(`  -> ${item.original}`);
    }
  }

  let dupesFound = 0;
  for (const [canon, items] of canonicalMap.entries()) {
    if (items.length > 1) {
      dupesFound++;
      console.log(`\nDuplicate Group (Canonical: ${canon}):`);
      items.forEach((item) => {
        console.log(`  - [${item.title}] ${item.original}`);
      });
    }
  }

  console.log(`\nFound ${dupesFound} groups of duplicates.`);
}

Deno.env.set("LOG_LEVELS", "info");

try {
  await sequelize.authenticate();
  await checkPlaylistDupes();
} catch (e) {
  console.error("Failed:", e);
} finally {
  await sequelize.close();
}
