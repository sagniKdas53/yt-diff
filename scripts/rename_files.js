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
  console.log('       Use --playlist="*" to process all playlists');
  process.exit(msg ? 1 : 0);
}

// Simple arg parsing
const args = process.argv.slice(2);
let playlistUrl = null;
let dryRun = false;
for (const arg of args) {
  if (arg.startsWith('--playlist=')) playlistUrl = arg.split('=').slice(1).join('=');
  if (arg === '--dry-run') dryRun = true;
}
if (!playlistUrl) usageAndExit('Missing --playlist parameter');
let resultsFile = null;
for (const arg of args) {
  if (arg.startsWith('--results-file=')) {
    resultsFile = arg.split('=')[1];
  }
}
// If no results file specified, create a timestamped one
if (!resultsFile) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').split('T');
  resultsFile = `renaming_${timestamp[0]}_${timestamp[1].slice(0, 6)}.json`;
}
console.log(`Results will be saved to: ${resultsFile}`);

// DB and save path defaults mirrored from index.js
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USERNAME || process.env.DB_USER || 'ytdiff';
const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE || 'vidlist';
let DB_PASSWORD = process.env.DB_PASSWORD || "";
if (!DB_PASSWORD && process.env.DB_PASSWORD_FILE) {
  try {
    DB_PASSWORD = fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim();
  } catch (e) {
    console.error('Unable to read DB_PASSWORD_FILE:', e.message);
    process.exit(2);
  }
}
if (!DB_PASSWORD) DB_PASSWORD = '';

const SAVE_PATH = process.env.SAVE_PATH || '/mnt/nvme/stuff/yt-diff/';

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

// Track detailed results for JSON output
const results = {
  timestamp: new Date().toISOString(),
  dryRun: dryRun,
  files: []
};

function sanitizeFilename(name, maxLen = 240) {
  if (!name) return '';
  // Remove control chars and reserved path chars
  const replaced = name.replace(/[\\/:*?"<>|\p{C}]/gu, '_');
  // Collapse multiple spaces
  const collapsed = replaced.replace(/\s+/g, ' ').trim();
  // Replace white space with _
  const finalName = collapsed.replace(/\s/g, '_');
  if (finalName.length <= maxLen) return finalName;
  return finalName.slice(0, maxLen).trim();
}

async function findPlaylists(playlistUrl) {
  if (playlistUrl === '*') {
    return PlaylistMetadata.findAll();
  }
  const playlist = await PlaylistMetadata.findOne({ where: { playlistUrl } });
  return playlist ? [playlist] : [];
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

async function processPlaylist(playlist) {
  console.log(`\nProcessing playlist: ${playlist.title || playlist.playlistUrl}`);

  // compute full save directory
  const saveDir = playlist.saveDirectory && playlist.saveDirectory.length ? path.join(SAVE_PATH, playlist.saveDirectory) : SAVE_PATH;
  if (!await ensureDir(saveDir)) {
    console.error('Save directory not accessible:', saveDir);
    return;
  }

  const mappings = await findMappingsForPlaylist(playlist.playlistUrl);
  if (!mappings || mappings.length === 0) {
    console.log('No videos found for playlist', playlist.playlistUrl);
    return;
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

    // read directory once (we may have already done this above when searching)
    const allFiles = await fs.promises.readdir(saveDir);

    if (!currentFilePath) {
      // try to find file starting with videoId
      const match = allFiles.find(f => {
        const parsed = path.parse(f);
        return parsed.name === videoId || parsed.name.startsWith(videoId + ' ') || parsed.name.startsWith(videoId + '.') || parsed.name.includes(`[${videoId}]`);
      });
      if (match) {
        currentFileName = match;
        currentFilePath = path.join(saveDir, match);
      }
    }

    // Determine if any files exist for this video (main or metadata). If none, mark as not downloaded.
    const anyFilesForVideo = allFiles.some(f => {
      const p = path.parse(f);
      return p.name === (v.fileName ? path.parse(v.fileName).name : videoId) || p.name.startsWith((v.fileName ? path.parse(v.fileName).name : videoId) + '.') || p.name.startsWith((v.fileName ? path.parse(v.fileName).name : videoId) + ' ');
    });
    if (!anyFilesForVideo) {
      console.log(`No files found on disk for video ${videoId}. Marking as not downloaded in DB.`);
      try {
        await VideoMetadata.update({ downloadStatus: false, fileName: null, descriptionFile: null, commentsFile: null, subTitleFile: null, thumbNailFile: null }, { where: { videoUrl: v.videoUrl } });
      } catch (e) {
        console.error('Failed to update DB when marking not-downloaded:', e.message);
      }
      continue;
    }
    console.log(`\nFound files for videoId ${videoId}. Current main file: ${currentFileName || 'NOT FOUND'}, anyFilesForVideo: ${anyFilesForVideo}`);

    const parsed = path.parse(currentFileName);
    const oldBase = parsed.name; // likely videoId
    const ext = parsed.ext || '';

    // build new base name: <title> [<id>]
    const sanitizedTitle = sanitizeFilename(title);
    let newBase = '';
    if (videoId !== "NA") {
      newBase = `${sanitizedTitle}_[${videoId}]`;
    } else {
      newBase = `${sanitizedTitle}`;
    }
    const newMainFilename = `${newBase}${ext}`;

    // Find metadata files which start with oldBase OR the original videoId
    const metadataCandidates = allFiles.filter(f => {
      if (f === currentFileName) return false;
      const p = path.parse(f);

      // Check if file matches the current base name (e.g., "Title_[id].description")
      const matchesOldBase = p.name === oldBase || p.name.startsWith(oldBase + '.') || p.name.startsWith(oldBase + ' ');

      // Check if file matches the original videoId (e.g., "id.info.json")
      const matchesVideoId = p.name === videoId || p.name.startsWith(videoId + '.') || p.name.startsWith(videoId + ' ');

      return matchesOldBase || matchesVideoId;
    });
    console.log(`Found ${metadataCandidates.length} metadata candidate(s) for videoId ${videoId}`);

    const plannedMeta = [];
    for (const metaFile of metadataCandidates) {
      let extensionPart;
      console.log('Processing metadata file:', metaFile);
      // Determine which base this file uses
      const p = path.parse(metaFile);
      console.log('Parsed name:', p.name);
      if (p.name === videoId || p.name.startsWith(videoId + '.') || p.name.startsWith(videoId + ' ')) {
        // File still uses videoId as base
        extensionPart = metaFile.substring(videoId.length);
      } else {
        // File uses the current oldBase
        extensionPart = metaFile.substring(oldBase.length);
      }

      const newName = `${newBase}${extensionPart}`;
      console.log(`Planned metadata rename: ${metaFile} -> ${newName}, shouldRename: ${metaFile !== newName}`);
      // if metadata name is already the desired one, skip
      if (metaFile === newName) continue;
      plannedMeta.push({ from: metaFile, to: newName });
    }

    const plannedMain = [];
    if (currentFileName) {
      // if main name is already the desired one, skip
      if (currentFileName !== newMainFilename) plannedMain.push({ from: currentFileName, to: newMainFilename });
    }

    // Show planned actions
    console.log('\n=== Video:', videoId, 'Title:', title, '===');
    for (const item of plannedMeta) console.log((dryRun ? '[DRY] ' : '[DO ]') + ` ${item.from} -> ${item.to}`);
    for (const item of plannedMain) console.log((dryRun ? '[DRY] ' : '[DO ]') + ` ${item.from} -> ${item.to}`);

    // Track this file in results
    const fileEntry = {
      videoId: videoId,
      title: title,
      playlistUrl: playlist.playlistUrl,
      saveDirectory: saveDir,
      plannedRenames: {
        main: plannedMain,
        metadata: plannedMeta
      },
      success: false,
      error: null
    };

    if (!dryRun) {
      // perform renames and update DB
      try {
        // perform metadata renames first
        const renamedMap = {}; // from -> final basename
        for (const item of plannedMeta) {
          const src = path.join(saveDir, item.from);
          const dst = path.join(saveDir, item.to);
          if (!fs.existsSync(src)) {
            console.warn('Source missing, skipping metadata:', src);
            fileEntry.success = false;
            fileEntry.error = 'Source missing';
            continue;
          }
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
          renamedMap[item.from] = path.basename(finalDst);
        }

        // perform main file rename (if any)
        if (plannedMain.length > 0) {
          for (const item of plannedMain) {
            const src = path.join(saveDir, item.from);
            const dst = path.join(saveDir, item.to);
            if (!fs.existsSync(src)) {
              console.warn('Main source missing, skipping main rename:', src);
              continue;
            }
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
            renamedMap[item.from] = path.basename(finalDst);
          }
        }

        // update DB filenames for this video
        const updateData = {};
        // final main filename: if renamedMap has entry for original main, use it; else if currentFileName exists use that; else newMainFilename
        if (currentFileName && renamedMap[currentFileName]) updateData.fileName = renamedMap[currentFileName];
        else if (currentFileName) updateData.fileName = currentFileName;
        else updateData.fileName = newMainFilename;

        // attempt to map metadata fields by extension heuristics using actual renamed names when available
        for (const mf of metadataCandidates) {
          // Get the original extension part (e.g., ".info.json", ".description")
          const extensionPart = mf.substring(oldBase.length);
          // Reconstruct the correct intendedNew name, just like in the planning phase
          const intendedNew = `${newBase}${extensionPart}`;

          const finalName = renamedMap[mf] || (fs.existsSync(path.join(saveDir, intendedNew)) ? intendedNew : null);
          if (!finalName) continue;

          // Check against the reliable "extensionPart" instead of the flawed path.extname
          if (extensionPart === '.description' || extensionPart === '.txt') {
            updateData.descriptionFile = finalName;
          } else if (extensionPart.endsWith('.info.json')) {
            // Correctly assign the full new name (e.g., "...[id].info.json")
            updateData.commentsFile = finalName;
          } else if (extensionPart.endsWith('.vtt') || extensionPart.endsWith('.srt') || extensionPart.endsWith('.sbv')) {
            updateData.subTitleFile = finalName;
          } else if (['.jpg', '.jpeg', '.png', '.webp'].some(e => extensionPart.endsWith(e))) {
            updateData.thumbNailFile = finalName;
          }
        }

        await VideoMetadata.update(updateData, { where: { videoUrl: v.videoUrl } });
        console.log('Updated DB for', videoId);
      } catch (e) {
        console.error('Failed to rename/update for', videoId, e.message);
      }
    }
    fileEntry.success = true;
    results.files.push(fileEntry);
  }

  console.log('\nCompleted operations for playlist:', playlist.title || playlist.playlistUrl);
}

async function run() {
  try {
    await sequelize.authenticate();
  } catch (e) {
    console.error('Unable to connect to DB:', e.message);
    process.exit(2);
  }

  if (playlistUrl === '*') {
    console.log('Processing all playlists');
  } else {
    console.log('Processing playlist:', playlistUrl);
  }
  const playlists = await findPlaylists(playlistUrl);
  if (!playlists || playlists.length === 0) {
    console.error('No playlists found in DB');
    process.exit(1);
  }
  for (const pl of playlists) {
    await processPlaylist(pl);
  }

  console.log('All done.');
  console.log('Writing results...');
  try {
    // Filter out the result entries which had no planned renames
    results.files = results.files.filter(f => f.plannedRenames.main.length > 0 || f.plannedRenames.metadata.length > 0);
    await fs.promises.writeFile(resultsFile, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to: ${resultsFile}`);
  } catch (e) {
    console.error('Failed to save results:', e.message);
    stats.errors++;
  }
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal:', err && err.message || err);
  process.exit(2);
});
