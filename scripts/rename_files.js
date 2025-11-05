#!/usr/bin/env node
"use strict";
// Script: rename_files.js
// Purpose: For videos belonging to a given playlist, rename downloaded video files
//          from id.ext -> "<title> [<id>].ext" and likewise rename metadata files.
//          Updates DB rows with new file names. Supports --dry-run flag.

const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.log('\nUsage: node scripts/rename_files.js --playlist="<playlistUrl>" [--dry-run]');
  process.exit(msg ? 1 : 0);
}

// Simple arg parsing
const args = process.argv.slice(2);
let playlistUrl = null;
let dryRun = false;
for (const arg of args) {
  if (arg.startsWith('--playlist=')) playlistUrl = arg.split('=')[1];
  if (arg === '--dry-run') dryRun = true;
}
if (!playlistUrl) usageAndExit('Missing --playlist parameter');

// DB and save path defaults mirrored from index.js
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USERNAME || process.env.DB_USER || 'ytdiff';
const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE || 'vidlist';
let DB_PASSWORD = process.env.DB_PASSWORD || "ytd1ff";
if (!DB_PASSWORD && process.env.DB_PASSWORD_FILE) {
  try {
    DB_PASSWORD = fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim();
  } catch (e) {
    console.error('Unable to read DB_PASSWORD_FILE:', e.message);
    process.exit(2);
  }
}
if (!DB_PASSWORD) DB_PASSWORD = '';

const SAVE_PATH = process.env.SAVE_PATH || '/home/sagnik/Videos/yt-dlp/';

// Connect to DB
const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  dialect: 'postgres',
  logging: false,
});

// Minimal model definitions (fields we need)
const VideoMetadata = sequelize.define('video_metadata', {
  videoUrl: { type: DataTypes.STRING, primaryKey: true },
  videoId: { type: DataTypes.STRING },
  title: { type: DataTypes.STRING },
  fileName: { type: DataTypes.STRING },
  descriptionFile: { type: DataTypes.STRING },
  commentsFile: { type: DataTypes.STRING },
  subTitleFile: { type: DataTypes.STRING },
  thumbNailFile: { type: DataTypes.STRING },
  downloadStatus: { type: DataTypes.BOOLEAN }
}, { timestamps: false });

const PlaylistVideoMapping = sequelize.define('playlist_video_mapping', {
  id: { type: DataTypes.UUID, primaryKey: true },
  videoUrl: { type: DataTypes.STRING },
  playlistUrl: { type: DataTypes.STRING },
  positionInPlaylist: { type: DataTypes.INTEGER }
}, { timestamps: false });

const PlaylistMetadata = sequelize.define('playlist_metadata', {
  playlistUrl: { type: DataTypes.STRING, primaryKey: true },
  title: { type: DataTypes.STRING },
  saveDirectory: { type: DataTypes.STRING }
}, { timestamps: false });

// Associate for convenience
PlaylistVideoMapping.belongsTo(VideoMetadata, { foreignKey: 'videoUrl', targetKey: 'videoUrl' });

function sanitizeFilename(name, maxLen = 240) {
  if (!name) return '';
  // Remove control chars and reserved path chars
  const replaced = name.replace(/[\\/:*?"<>|\p{C}]/gu, '_');
  // Collapse multiple spaces
  const collapsed = replaced.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen).trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findPlaylist(playlistUrl) {
  return PlaylistMetadata.findOne({ where: { playlistUrl } });
}

async function findMappingsForPlaylist(playlistUrl) {
  return PlaylistVideoMapping.findAll({ where: { playlistUrl }, include: [VideoMetadata], order: [['positionInPlaylist', 'ASC']] });
}

async function ensureDir(dir) {
  try {
    await fs.promises.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

async function run() {
  try {
    await sequelize.authenticate();
  } catch (e) {
    console.error('DB connect failed:', e.message);
    process.exit(2);
  }

  const playlist = await findPlaylist(playlistUrl);
  if (!playlist) {
    console.error('Playlist not found in DB:', playlistUrl);
    process.exit(3);
  }

  // compute full save directory
  const saveDir = playlist.saveDirectory && playlist.saveDirectory.length ? path.join(SAVE_PATH, playlist.saveDirectory) : SAVE_PATH;
  if (!await ensureDir(saveDir)) {
    console.error('Save directory not accessible:', saveDir);
    process.exit(4);
  }

  const mappings = await findMappingsForPlaylist(playlistUrl);
  if (!mappings || mappings.length === 0) {
    console.log('No videos found for playlist', playlistUrl);
    process.exit(0);
  }

  console.log(`Found ${mappings.length} mapping(s) for playlist. Dry-run: ${dryRun}`);

  for (const mapping of mappings) {
    const video = mapping.video_metadata || mapping.video_metadata || mapping.videoUrl && (await VideoMetadata.findOne({ where: { videoUrl: mapping.videoUrl } }));
    // the include above should set video on mapping as 'video_metadata' or 'video_metadata'
    let v = mapping.video_metadata || mapping.video_metadata || mapping.VideoMetadata || video;
    if (!v) {
      console.warn('Skipping mapping without video metadata for', mapping.videoUrl);
      continue;
    }

    if (!v.downloadStatus) {
      console.log(`Skipping not-downloaded video: ${v.videoId} (${v.videoUrl})`);
      continue;
    }

    const videoId = v.videoId;
    const title = v.title || videoId;

    // Determine current main file on disk
    let currentFileName = v.fileName || null;
    let currentFilePath = null;
    if (currentFileName) {
      const p = path.join(saveDir, currentFileName);
      if (fs.existsSync(p)) currentFilePath = p; else currentFileName = null;
    }

    if (!currentFilePath) {
      // try to find file starting with videoId
      const files = await fs.promises.readdir(saveDir);
      const match = files.find(f => {
        const parsed = path.parse(f);
        return parsed.name === videoId || parsed.name.startsWith(videoId + ' ') || parsed.name.startsWith(videoId + '.');
      });
      if (match) {
        currentFileName = match;
        currentFilePath = path.join(saveDir, match);
      }
    }

    if (!currentFilePath) {
      console.warn(`Main file for video ${videoId} not found in ${saveDir}. Skipping.`);
      continue;
    }

    const parsed = path.parse(currentFileName);
    const oldBase = parsed.name; // likely videoId
    const ext = parsed.ext || '';

    // build new base name: <title> [<id>]
    const sanitizedTitle = sanitizeFilename(title);
    const newBase = `${sanitizedTitle} [${videoId}]`;
    const newMainFilename = `${newBase}${ext}`;
    const newMainPath = path.join(saveDir, newMainFilename);

    // Find metadata files which start with oldBase (e.g., id.description, id.comments, id.vtt, id.jpg)
    const allFiles = await fs.promises.readdir(saveDir);
    const metadataCandidates = allFiles.filter(f => {
      if (f === currentFileName) return false; // will rename main separately
      const p = path.parse(f);
      return p.name === oldBase || p.name.startsWith(oldBase + '.') || p.name.startsWith(oldBase + ' ');
    });

    const planned = [];
    // main file
    planned.push({ from: currentFileName, to: newMainFilename });

    // metadata
    for (const mf of metadataCandidates) {
      const p = path.parse(mf);
      const newName = `${newBase}${p.ext}`;
      planned.push({ from: mf, to: newName });
    }

    // Show planned actions
    console.log('\n=== Video:', videoId, 'Title:', title, '===');
    for (const item of planned) console.log((dryRun ? '[DRY] ' : '[DO ]') + ` ${item.from} -> ${item.to}`);

    if (!dryRun) {
      // perform renames and update DB
      try {
        // rename metadata first (so if main rename collides it won't lose data)
        for (const item of planned) {
          const src = path.join(saveDir, item.from);
          const dst = path.join(saveDir, item.to);
          if (!fs.existsSync(src)) {
            console.warn('Source missing, skipping:', src);
            continue;
          }
          // if dst exists, avoid overwrite by appending a numeric suffix
          let finalDst = dst;
          if (fs.existsSync(finalDst)) {
            const dstParsed = path.parse(dst);
            let i = 1;
            do {
              finalDst = path.join(dstParsed.dir, `${dstParsed.name} (${i})${dstParsed.ext}`);
              i++;
            } while (fs.existsSync(finalDst));
            console.warn('Destination exists, will use:', finalDst);
          }
          await fs.promises.rename(src, finalDst);
        }

        // update DB filenames for this video
        const updateData = {};
        updateData.fileName = newMainFilename;
        // attempt to map metadata fields by extension heuristics
        for (const item of planned) {
          if (item.to === newMainFilename) continue;
          const extn = path.extname(item.to).toLowerCase();
          if (extn === '.description' || extn === '.txt') updateData.descriptionFile = item.to;
          else if (extn === '.comments') updateData.commentsFile = item.to;
          else if (extn === '.vtt' || extn === '.srt' || extn === '.sbv') updateData.subTitleFile = item.to;
          else if (['.jpg', '.jpeg', '.png', '.webp'].includes(extn)) updateData.thumbNailFile = item.to;
        }

        await VideoMetadata.update(updateData, { where: { videoUrl: v.videoUrl } });
        console.log('Updated DB for', videoId);
      } catch (e) {
        console.error('Failed to rename/update for', videoId, e.message);
      }
    }
  }

  console.log('\nCompleted.');
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal:', err && err.message || err);
  process.exit(2);
});
