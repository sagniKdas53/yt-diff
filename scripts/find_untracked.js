#!/usr/bin/env node
"use strict";
// Script: find_untracked.js
// Purpose: Scan download directory and list/delete files not tracked in the DB
//          (i.e., files that don't match any VideoMetadata filename/metadata fields)

const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');

function usageAndExit(msg) {
    if (msg) console.error(msg);
    console.log('\nUsage: node scripts/find_untracked.js [--delete] [--dry-run]');
    console.log('  --dry-run   Print what would be done without making changes (implied if --delete not given)');
    console.log('  --delete    Actually delete untracked files (BE CAREFUL!)');
    process.exit(msg ? 1 : 0);
}

// Simple arg parsing
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || !args.includes('--delete');
const shouldDelete = args.includes('--delete');

if (shouldDelete && dryRun) {
    console.log('Note: --dry-run takes precedence over --delete');
}

// DB and save path defaults mirrored from index.js
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USERNAME || process.env.DB_USER || 'ytdiff';
const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE || 'vidlist';
let DB_PASSWORD = process.env.DB_PASSWORD || 'ytd1ff';
if (!DB_PASSWORD && process.env.DB_PASSWORD_FILE) {
    try {
        DB_PASSWORD = fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim();
    } catch (e) {
        console.error('Unable to read DB_PASSWORD_FILE:', e.message);
        process.exit(2);
    }
}

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
    thumbNailFile: { type: DataTypes.STRING }
}, { timestamps: false });

const PlaylistMetadata = sequelize.define('playlist_metadata', {
    playlistUrl: { type: DataTypes.STRING, primaryKey: true },
    title: { type: DataTypes.STRING },
    saveDirectory: { type: DataTypes.STRING }
}, { timestamps: false });

// Helper to recursively list files
async function* walkDir(dir) {
    const files = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of files) {
        const res = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            yield* walkDir(res);
        } else {
            yield res;
        }
    }
}

// Extract sets of known filenames from DB records
async function getKnownFiles() {
    const knownFiles = new Set();
    const videos = await VideoMetadata.findAll({
        attributes: ['fileName', 'descriptionFile', 'commentsFile', 'subTitleFile', 'thumbNailFile']
    });

    // Track both exact names and partial matches (for .part files, etc)
    for (const video of videos) {
        const fields = ['fileName', 'descriptionFile', 'commentsFile', 'subTitleFile', 'thumbNailFile'];
        for (const field of fields) {
            if (video[field]) {
                const name = video[field];
                knownFiles.add(name);
                // Add partial matches for common extensions and temp files
                const base = path.parse(name).name;
                knownFiles.add(`${base}.part`); // in-progress download
                knownFiles.add(`${base}.ytdl`);  // temp metadata
                knownFiles.add(`${base}.temp.mkv`); // temp video
                knownFiles.add(`${base}.temp.mp4`);
                knownFiles.add(`${base}.temp.webm`);
            }
        }
    }
    return knownFiles;
}

async function run() {
    try {
        await sequelize.authenticate();
    } catch (e) {
        console.error('DB connect failed:', e.message);
        process.exit(2);
    }

    // Get list of playlists and their save directories
    const playlists = await PlaylistMetadata.findAll({
        attributes: ['saveDirectory']
    });

    // Build set of directories to scan
    const scanDirs = new Set([SAVE_PATH]);
    for (const pl of playlists) {
        if (pl.saveDirectory) {
            const fullPath = path.join(SAVE_PATH, pl.saveDirectory);
            scanDirs.add(fullPath);
        }
    }

    // Get all known filenames from DB
    const knownFiles = await getKnownFiles();
    console.log(`Found ${knownFiles.size} known files in DB`);

    // Track stats
    const stats = {
        scanned: 0,
        untracked: 0,
        deleted: 0,
        errors: 0,
        bytes: 0
    };

    // Scan each directory
    for (const dir of scanDirs) {
        try {
            if (!fs.existsSync(dir)) {
                console.warn('Directory does not exist, skipping:', dir);
                continue;
            }

            console.log('\nScanning directory:', dir);
            for await (const filePath of walkDir(dir)) {
                stats.scanned++;
                const relativePath = path.relative(dir, filePath);
                const fileName = path.basename(filePath);

                // Skip .git and node_modules
                if (relativePath.includes('.git/') || relativePath.includes('node_modules/')) {
                    continue;
                }

                // If file not known in DB
                if (!knownFiles.has(fileName)) {
                    stats.untracked++;
                    try {
                        const stat = await fs.promises.stat(filePath);
                        stats.bytes += stat.size;

                        // Report or delete
                        if (shouldDelete && !dryRun) {
                            try {
                                await fs.promises.unlink(filePath);
                                console.log('[DEL] Deleted:', relativePath, `(${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
                                stats.deleted++;
                            } catch (e) {
                                console.error('[ERR] Failed to delete:', relativePath, e.message);
                                stats.errors++;
                            }
                        } else {
                            console.log('[LST] Found:', relativePath, `(${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
                        }
                    } catch (e) {
                        console.error('[ERR] Failed to stat:', relativePath, e.message);
                        stats.errors++;
                    }
                }
            }
        } catch (e) {
            console.error('Error scanning directory:', dir, e.message);
            stats.errors++;
        }
    }

    // Print summary
    console.log('\nSummary:');
    console.log(`- Scanned files: ${stats.scanned}`);
    console.log(`- Untracked files: ${stats.untracked}`);
    console.log(`- Total size: ${(stats.bytes / 1024 / 1024).toFixed(2)} MB`);
    if (shouldDelete && !dryRun) {
        console.log(`- Files deleted: ${stats.deleted}`);
    }
    if (stats.errors > 0) {
        console.log(`- Errors encountered: ${stats.errors}`);
    }

    if (dryRun && shouldDelete) {
        console.log('\nThis was a dry run. Use --delete without --dry-run to actually delete files.');
    }

    process.exit(stats.errors ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal:', err && err.message || err);
    process.exit(2);
});