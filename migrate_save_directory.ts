/// <reference lib="deno.ns" />
/**
 * Migration script: Backfills the `saveDirectory` column on `video_metadata`.
 *
 * How it works:
 *   1. Connects to the DB using the same env vars as index.ts.
 *   2. Adds the `saveDirectory` column if it doesn't already exist.
 *   3. For every downloaded video (downloadStatus = true) whose
 *      saveDirectory is NULL, it uses a raw SQL join to get all
 *      playlist saveDirectories the video is mapped to.
 *   4. Checks the filesystem for each candidate directory.
 *      The first match wins.
 *   5. If no match is found the video is assumed to be in the save
 *      root (saveDirectory = "").
 *
 * Usage:
 *   DB_PASSWORD=... deno run --allow-all migrate_save_directory.ts
 *
 *   Or with the deno task:
 *   deno task migrate
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { DataTypes, QueryTypes, Sequelize } from "sequelize";

// ── Config ───────────────────────────────────────────────────────────────────
const dbPassword = Deno.env.get("DB_PASSWORD_FILE")
  ? fs.readFileSync(Deno.env.get("DB_PASSWORD_FILE")!, "utf8").trim()
  : Deno.env.get("DB_PASSWORD")?.trim();

if (!dbPassword) {
  console.error("DB_PASSWORD or DB_PASSWORD_FILE must be set");
  Deno.exit(1);
}

const saveLocation = Deno.env.get("SAVE_PATH") ||
  "/mnt/nvme/stuff/yt-diff/";
const dryRun = Deno.env.get("DRY_RUN") === "true";
const targetPlaylistUrl = Deno.env.get("PLAYLIST_URL");

const sequelize = new Sequelize({
  host: Deno.env.get("DB_HOST") || "localhost",
  dialect: "postgres",
  dialectModule: pg,
  logging: false,
  username: Deno.env.get("DB_USERNAME") || "ytdiff",
  password: dbPassword,
  database: "vidlist",
});

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    await sequelize.authenticate();
    console.log("✓ Connected to database");
  } catch (e) {
    console.error("✗ Database connection failed:", (e as Error).message);
    Deno.exit(1);
  }

  // Step 1: Ensure column exists (idempotent)
  const qi = sequelize.getQueryInterface();
  const columns = await qi.describeTable("video_metadata");
  if (!("saveDirectory" in columns)) {
    console.log("  Adding saveDirectory column...");
    await qi.addColumn("video_metadata", "saveDirectory", {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    });
    console.log("✓ Column added");
  } else {
    console.log("✓ saveDirectory column already exists");
  }

  // Step 2: Find downloaded videos with NULL saveDirectory using raw SQL
  let query = `
    SELECT "videoUrl", "fileName"
    FROM video_metadata
    WHERE "downloadStatus" = true AND "saveDirectory" IS NULL
  `;
  const replacements: Record<string, any> = {};

  if (targetPlaylistUrl) {
    console.log(`  Filtering by playlist: ${targetPlaylistUrl}`);
    query = `
      SELECT DISTINCT vm."videoUrl", vm."fileName"
      FROM video_metadata vm
      JOIN playlist_video_mappings pvm ON vm."videoUrl" = pvm."videoUrl"
      WHERE vm."downloadStatus" = true 
        AND vm."saveDirectory" IS NULL 
        AND pvm."playlistUrl" = :targetPlaylistUrl
    `;
    replacements.targetPlaylistUrl = targetPlaylistUrl;
  }

  const videos = await sequelize.query(query, {
    replacements,
    type: QueryTypes.SELECT,
  }) as { videoUrl: string; fileName: string | null }[];

  console.log(
    `  Found ${videos.length} downloaded video(s) with NULL saveDirectory`,
  );

  if (videos.length === 0) {
    console.log("✓ Nothing to migrate");
    await sequelize.close();
    return;
  }

  let updated = 0;
  let defaulted = 0;

  for (const video of videos) {
    const fileName = video.fileName;
    if (!fileName) {
      // No fileName recorded — set to root as best guess
      if (dryRun) {
        console.log(
          `  ⚠ ${video.videoUrl} → "" (no fileName, defaulting to root)`,
        );
        defaulted++;
        continue;
      }
      await sequelize.query(
        `UPDATE video_metadata SET "saveDirectory" = '' WHERE "videoUrl" = :url`,
        { replacements: { url: video.videoUrl }, type: QueryTypes.UPDATE },
      );
      console.log(
        `  ⚠ ${video.videoUrl} → "" (no fileName, defaulting to root)`,
      );
      defaulted++;
      continue;
    }

    // Get all playlist saveDirectories this video is mapped to via raw join
    const playlistDirs = await sequelize.query(
      `SELECT DISTINCT pm."saveDirectory"
       FROM playlist_video_mappings pvm
       JOIN playlist_metadata pm ON pvm."playlistUrl" = pm."playlistUrl"
       WHERE pvm."videoUrl" = :url`,
      { replacements: { url: video.videoUrl }, type: QueryTypes.SELECT },
    ) as { saveDirectory: string }[];

    console.log(
      `  Checking ${video.videoUrl} (${fileName}) against ${playlistDirs.length} playlist dir(s): [${
        playlistDirs.map((d) => `"${d.saveDirectory}"`).join(", ")
      }]`,
    );

    let found = false;

    // Check each playlist's directory for the file
    for (const row of playlistDirs) {
      const dir = row.saveDirectory ?? "";
      const filePath = path.join(saveLocation, dir, fileName);

      if (fs.existsSync(filePath)) {
        if (dryRun) {
          console.log(
            `  ✓ ${video.videoUrl} → "${dir}" (found at ${filePath})`,
          );
          found = true;
          updated++;
          break;
        }
        await sequelize.query(
          `UPDATE video_metadata SET "saveDirectory" = :dir WHERE "videoUrl" = :url`,
          {
            replacements: { dir, url: video.videoUrl },
            type: QueryTypes.UPDATE,
          },
        );
        console.log(`  ✓ ${video.videoUrl} → "${dir}" (found at ${filePath})`);
        found = true;
        updated++;
        break;
      } else {
        console.log(`    ✗ Not at ${filePath}`);
      }
    }

    // Fallback: check root if not found in any playlist dir
    if (!found) {
      const rootPath = path.join(saveLocation, fileName);
      if (fs.existsSync(rootPath)) {
        if (dryRun) {
          console.log(`  ✓ ${video.videoUrl} → "" (found at root)`);
          updated++;
          continue;
        }
        await sequelize.query(
          `UPDATE video_metadata SET "saveDirectory" = '' WHERE "videoUrl" = :url`,
          { replacements: { url: video.videoUrl }, type: QueryTypes.UPDATE },
        );
        console.log(`  ✓ ${video.videoUrl} → "" (found at root)`);
        updated++;
      } else {
        if (dryRun) {
          console.log(
            `  ⚠ ${video.videoUrl} → "" (file not found anywhere, defaulting to root)`,
          );
          defaulted++;
          continue;
        }
        await sequelize.query(
          `UPDATE video_metadata SET "saveDirectory" = '' WHERE "videoUrl" = :url`,
          { replacements: { url: video.videoUrl }, type: QueryTypes.UPDATE },
        );
        console.log(
          `  ⚠ ${video.videoUrl} → "" (file not found anywhere, defaulting to root)`,
        );
        defaulted++;
      }
    }
  }

  console.log(
    `\n✓ Migration complete: ${updated} located on disk, ${defaulted} defaulted to root`,
  );
  await sequelize.close();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  Deno.exit(1);
});
