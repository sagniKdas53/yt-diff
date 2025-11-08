#!/usr/bin/env node
"use strict";
// Script: find_untracked.js
// Purpose: Scan download directory and list/delete/move files not tracked in the DB
//          (i.e., files that don't match any VideoMetadata filename/metadata fields)

const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function usageAndExit(msg) {
    if (msg) console.error(`\nError: ${msg}`);
    console.log('\nUsage: node scripts/find_untracked.js [--delete | --trash | --move-to=<path>] [--dry-run] [--results-file=path/to/results.json]');
    console.log('  --dry-run           Print what would be done without making changes (implied if no action given)');
    console.log('  --delete            Permanently delete untracked files (BE CAREFUL!)');
    console.log('  --trash             Move untracked files to trash (safer option)');
    console.log('  --move-to=<path>    Move untracked files to the specified directory');
    console.log('  --results-file=<path> Save results to JSON file (default: untracked_YYYYMMDD_HHMMSS.json)');
    process.exit(msg ? 1 : 0);
}

// Arg parsing
const args = process.argv.slice(2);
const shouldDelete = args.includes('--delete');
const shouldTrash = args.includes('--trash');
let moveToPath = null;
let resultsFile = null;

for (const arg of args) {
    if (arg.startsWith('--results-file=')) {
        resultsFile = arg.split('=')[1];
    } else if (arg.startsWith('--move-to=')) {
        moveToPath = arg.split('=')[1];
    }
}

const shouldMove = !!moveToPath;

// Validate mutual exclusivity of actions
const actionCount = [shouldDelete, shouldTrash, shouldMove].filter(Boolean).length;
if (actionCount > 1) {
    usageAndExit('Cannot specify more than one of --delete, --trash, or --move-to');
}

// Determine active mode
const dryRun = args.includes('--dry-run') || actionCount === 0;

// Validate move-to path if specified
if (shouldMove) {
    if (!moveToPath) {
        usageAndExit('--move-to requires a directory path');
    }
    // Resolve to absolute path
    moveToPath = path.resolve(moveToPath);

    // Ensure it exists and is a directory (unless it's a dry run, but even then it's good to warn)
    try {
        if (!fs.existsSync(moveToPath)) {
            usageAndExit(`Destination path does not exist: ${moveToPath}`);
        }
        if (!fs.statSync(moveToPath).isDirectory()) {
            usageAndExit(`Destination is not a directory: ${moveToPath}`);
        }
    } catch (e) {
        usageAndExit(`Invalid destination path: ${moveToPath} (${e.message})`);
    }
}

// If no results file specified, create a timestamped one
if (!resultsFile) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '').split('T');
    resultsFile = `untracked_${timestamp[0]}_${timestamp[1].slice(0, 6)}.json`;
}

if (!dryRun && (shouldDelete || shouldTrash || shouldMove)) {
    console.log(`Starting ${shouldDelete ? 'DELETE' : (shouldTrash ? 'TRASH' : 'MOVE')} run...`);
} else if (actionCount > 0) {
    console.log('DRY RUN: No changes will be made.');
}

// Check for trash-cli is available
async function hasTrash() {
    try {
        await execFileAsync('trash', ['--version']);
        return true;
    } catch (e) {
        return false;
    }
}

// Move file to trash using trash-cli
async function moveToTrash(filePath) {
    try {
        await execFileAsync('trash', [filePath]);
        return true;
    } catch (e) {
        // console.error handled by caller for consistent logging
        throw e;
    }
}

// Track detailed results for JSON output
const results = {
    timestamp: new Date().toISOString(),
    configuration: {
        dryRun: dryRun,
        action: shouldDelete ? 'delete' : (shouldTrash ? 'trash' : (shouldMove ? 'move' : 'list')),
        moveToPath: moveToPath
    },
    summary: {},
    files: []
};

// DB and save path defaults mirrored from index.js
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USERNAME || process.env.DB_USER || 'ytdiff';
const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE || 'vidlist';
let DB_PASSWORD = process.env.DB_PASSWORD || "3z$sF?O-<^cHA8!M:,C@1?ow{;3%[&1p";
if (!DB_PASSWORD && process.env.DB_PASSWORD_FILE) {
    try {
        DB_PASSWORD = fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim();
    } catch (e) {
        console.error('Unable to read DB_PASSWORD_FILE:', e.message);
        process.exit(2);
    }
}

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
    fileName: { type: DataTypes.STRING },
    descriptionFile: { type: DataTypes.STRING },
    commentsFile: { type: DataTypes.STRING },
    subTitleFile: { type: DataTypes.STRING },
    thumbNailFile: { type: DataTypes.STRING }
}, { timestamps: false });

const PlaylistMetadata = sequelize.define('playlist_metadata', {
    playlistUrl: { type: DataTypes.STRING, primaryKey: true },
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

    for (const video of videos) {
        const fields = ['fileName', 'descriptionFile', 'commentsFile', 'subTitleFile', 'thumbNailFile'];
        for (const field of fields) {
            if (video[field]) {
                const name = video[field];
                knownFiles.add(name);
                const base = path.parse(name).name;
                knownFiles.add(`${base}.part`);
                knownFiles.add(`${base}.ytdl`);
                knownFiles.add(`${base}.temp.mkv`);
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

    if (shouldTrash && !dryRun && !(await hasTrash())) {
        console.error('Error: trash-cli not found. Please install it first.');
        process.exit(3);
    }

    // Get playlists and build scan directories
    const playlists = await PlaylistMetadata.findAll({ attributes: ['saveDirectory'] });
    const scanDirs = new Set([SAVE_PATH]);
    for (const pl of playlists) {
        if (pl.saveDirectory) {
            scanDirs.add(path.join(SAVE_PATH, pl.saveDirectory));
        }
    }

    const knownFiles = await getKnownFiles();
    console.log(`Found ${knownFiles.size} known files in DB across ${scanDirs.size} potential directories.`);

    const stats = {
        scanned: 0, untracked: 0, deleted: 0, trashed: 0, moved: 0, errors: 0, bytes: 0
    };

    for (const dir of scanDirs) {
        try {
            if (!fs.existsSync(dir)) continue;
            console.log('\nScanning:', dir);

            for await (const filePath of walkDir(dir)) {
                stats.scanned++;
                const relativePath = path.relative(dir, filePath);
                const fileName = path.basename(filePath);

                if (relativePath.includes('.git/') || relativePath.includes('node_modules/')) continue;

                if (!knownFiles.has(fileName)) {
                    stats.untracked++;
                    try {
                        const stat = await fs.promises.stat(filePath);
                        stats.bytes += stat.size;
                        const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

                        const fileEntry = {
                            originalPath: filePath,
                            relativePath,
                            sizeBytes: stat.size,
                            action: 'listed',
                            success: true
                        };

                        if (dryRun) {
                            let prefix = 'LST';
                            if (shouldDelete) { prefix = 'DEL?'; fileEntry.action = 'would_delete'; }
                            else if (shouldTrash) { prefix = 'TRS?'; fileEntry.action = 'would_trash'; }
                            else if (shouldMove) {
                                prefix = 'MOV?';
                                fileEntry.action = 'would_move';
                                fileEntry.intendedDestination = path.join(moveToPath, relativePath);
                            }
                            console.log(`[${prefix}] ${relativePath} (${sizeMB} MB)`);
                        } else {
                            // Perform Actions
                            try {
                                if (shouldDelete) {
                                    await fs.promises.unlink(filePath);
                                    console.log(`[DEL] ${relativePath} (${sizeMB} MB)`);
                                    stats.deleted++;
                                    fileEntry.action = 'deleted';
                                } else if (shouldTrash) {
                                    await moveToTrash(filePath);
                                    console.log(`[TRS] ${relativePath} (${sizeMB} MB)`);
                                    stats.trashed++;
                                    fileEntry.action = 'trashed';
                                } else if (shouldMove) {
                                    // Preserve relative structure in destination to avoid collisions
                                    const destPath = path.join(moveToPath, relativePath);
                                    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
                                    await fs.promises.rename(filePath, destPath);
                                    console.log(`[MOV] ${relativePath} -> ${destPath}`);
                                    stats.moved++;
                                    fileEntry.action = 'moved';
                                    fileEntry.destinationPath = destPath;
                                } else {
                                    console.log(`[LST] ${relativePath} (${sizeMB} MB)`);
                                }
                            } catch (actErr) {
                                console.error(`[ERR] Action failed for ${relativePath}: ${actErr.message}`);
                                stats.errors++;
                                fileEntry.success = false;
                                fileEntry.error = actErr.message;
                            }
                        }
                        results.files.push(fileEntry);
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

    // Summary and Save
    console.log('\nSummary:');
    console.log(`- Scanned: ${stats.scanned} | Untracked: ${stats.untracked} | Size: ${(stats.bytes / 1024 / 1024).toFixed(2)} MB`);
    if (!dryRun && (shouldDelete || shouldTrash || shouldMove)) {
        console.log(`- Actions taken: Deleted(${stats.deleted}), Trashed(${stats.trashed}), Moved(${stats.moved})`);
    }
    if (stats.errors > 0) console.log(`- Errors: ${stats.errors}`);

    results.summary = stats;
    try {
        await fs.promises.writeFile(resultsFile, JSON.stringify(results, null, 2));
        console.log(`Results saved to: ${resultsFile}`);
    } catch (e) {
        console.error('Failed to save results file:', e.message);
        process.exit(1);
    }

    process.exit(stats.errors ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(2);
});