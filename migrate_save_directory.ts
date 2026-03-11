/// <reference lib="deno.ns" />
/**
 * Migration script: Backfills the `saveDirectory` column on `video_metadata`.
 *
 * How it works:
 *   1. Connects to the DB using the same env vars as index.ts.
 *   2. Adds the `saveDirectory` column if it doesn't already exist
 *      (Sequelize sync() would do this too, but this script can run
 *      independently before the app starts).
 *   3. For every downloaded video (downloadStatus = true) whose
 *      saveDirectory is NULL, it looks at each playlist the video
 *      belongs to and checks whether the file exists on disk under
 *      that playlist's saveDirectory.  The first match wins.
 *   4. If no match is found the video is assumed to be in the save
 *      root (saveDirectory = "").
 *
 * Usage:
 *   DB_HOST=... DB_USERNAME=... DB_PASSWORD=... SAVE_PATH=... \
 *     deno run --allow-all migrate_save_directory.ts
 *
 *   Or, using the password-file pattern:
 *   DB_HOST=... DB_USERNAME=... DB_PASSWORD_FILE=./db_password.txt SAVE_PATH=... \
 *     deno run --allow-all migrate_save_directory.ts
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { DataTypes, Sequelize } from "sequelize";

// ── Config ───────────────────────────────────────────────────────────────────
const dbPassword = Deno.env.get("DB_PASSWORD_FILE")
  ? fs.readFileSync(Deno.env.get("DB_PASSWORD_FILE")!, "utf8").trim()
  : Deno.env.get("DB_PASSWORD")?.trim();

if (!dbPassword) {
  console.error("DB_PASSWORD or DB_PASSWORD_FILE must be set");
  Deno.exit(1);
}

const saveLocation =
  Deno.env.get("SAVE_PATH") ||
  "/home/sagnik/Documents/syncthing/pi5/yt-diff-data/";

const sequelize = new Sequelize({
  host: Deno.env.get("DB_HOST") || "localhost",
  dialect: "postgres",
  dialectModule: pg,
  logging: false,
  username: Deno.env.get("DB_USERNAME") || "ytdiff",
  password: dbPassword,
  database: "vidlist",
});

// ── Minimal model definitions (just what we need) ────────────────────────────
const VideoMetadata = sequelize.define(
  "video_metadata",
  {
    videoUrl: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    fileName: { type: DataTypes.STRING, allowNull: true },
    downloadStatus: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    saveDirectory: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
  },
  { timestamps: true },
);

const PlaylistMetadata = sequelize.define(
  "playlist_metadata",
  {
    playlistUrl: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    saveDirectory: { type: DataTypes.STRING, allowNull: false },
  },
  { timestamps: true },
);

const PlaylistVideoMapping = sequelize.define(
  "playlist_video_mapping",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    videoUrl: { type: DataTypes.STRING, allowNull: false },
    playlistUrl: { type: DataTypes.STRING, allowNull: false },
  },
  { timestamps: false },
);

PlaylistVideoMapping.belongsTo(VideoMetadata, { foreignKey: "videoUrl" });
PlaylistVideoMapping.belongsTo(PlaylistMetadata, { foreignKey: "playlistUrl" });
VideoMetadata.hasMany(PlaylistVideoMapping, { foreignKey: "videoUrl" });
PlaylistMetadata.hasMany(PlaylistVideoMapping, { foreignKey: "playlistUrl" });

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

  // Step 2: Find downloaded videos with NULL saveDirectory
  const videos = (await VideoMetadata.findAll({
    where: {
      downloadStatus: true,
      saveDirectory: null,
    },
  })) as any[];

  console.log(`  Found ${videos.length} downloaded video(s) with NULL saveDirectory`);

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
      await video.update({ saveDirectory: "" });
      defaulted++;
      continue;
    }

    // Find all playlists this video belongs to
    const mappings = await PlaylistVideoMapping.findAll({
      where: { videoUrl: video.videoUrl },
      include: [{ model: PlaylistMetadata, attributes: ["saveDirectory"] }],
    });

    let found = false;

    for (const mapping of mappings as any[]) {
      const playlistDir = mapping.playlist_metadatum?.saveDirectory ?? "";
      const filePath = path.join(saveLocation, playlistDir, fileName);

      if (fs.existsSync(filePath)) {
        await video.update({ saveDirectory: playlistDir });
        console.log(`  ✓ ${video.videoUrl} → "${playlistDir}" (found at ${filePath})`);
        found = true;
        updated++;
        break;
      }
    }

    // Also check root if not found in any playlist dir
    if (!found) {
      const rootPath = path.join(saveLocation, fileName);
      if (fs.existsSync(rootPath)) {
        await video.update({ saveDirectory: "" });
        console.log(`  ✓ ${video.videoUrl} → "" (found at root)`);
        updated++;
      } else {
        // File not found anywhere — default to root
        await video.update({ saveDirectory: "" });
        console.log(`  ⚠ ${video.videoUrl} → "" (file not found, defaulting to root)`);
        defaulted++;
      }
    }
  }

  console.log(
    `\n✓ Migration complete: ${updated} located, ${defaulted} defaulted to root`,
  );
  await sequelize.close();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  Deno.exit(1);
});
