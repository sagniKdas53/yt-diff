import { existsSync } from "https://deno.land/std@0.224.0/fs/exists.ts";

const STATE_FILE = "iwara_batch_state.json";
const FAILED_FILE = "iwara_failed_urls.json";
const BATCH_SIZE = 10;

interface BatchPayload {
  playListUrl: string;
  urlList: string[];
}

async function run() {
  const fileToRead = Deno.args[0] || "iwara_videos_filtered.json";
  console.log(`Reading from ${fileToRead}...`);

  let text;
  try {
    text = Deno.readTextFileSync(fileToRead);
  } catch (err) {
    console.error(`Failed to read ${fileToRead}. Did you run scratch_export_iwara_videos.ts first?`);
    Deno.exit(1);
  }
  
  const data = JSON.parse(text) as { playlistUrl: string; videoUrl: string }[];

  // Group by playlist
  const byPlaylist: Record<string, string[]> = {};
  for (const item of data) {
    if (!byPlaylist[item.playlistUrl]) {
      byPlaylist[item.playlistUrl] = [];
    }
    if (!byPlaylist[item.playlistUrl].includes(item.videoUrl)) {
      byPlaylist[item.playlistUrl].push(item.videoUrl);
    }
  }

  // Create flatten batches
  const batches: BatchPayload[] = [];
  for (const [playlistUrl, urls] of Object.entries(byPlaylist)) {
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      batches.push({
        playListUrl: playlistUrl,
        urlList: urls.slice(i, i + BATCH_SIZE)
      });
    }
  }

  console.log(`Created ${batches.length} total batches from ${data.length} URLs.`);

  let startIndex = 0;
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(Deno.readTextFileSync(STATE_FILE));
      if (typeof state.lastProcessedBatchIndex === "number") {
        startIndex = state.lastProcessedBatchIndex;
        console.log(`Resuming from batch index ${startIndex}...`);
      }
    } catch (e) {
      console.warn("Could not parse state file, starting from 0");
    }
  }

  const PORT = Deno.env.get("PORT") || "8888";
  const HOST = `http://localhost:${PORT}`;
  const authToken = Deno.env.get("AUTH_TOKEN");
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  } else {
    console.warn("No AUTH_TOKEN environment variable provided. If your yt-diff requires auth, this will fail.");
  }

  let failedUrls: { playlistUrl: string; videoUrl: string }[] = [];
  if (existsSync(FAILED_FILE)) {
    try {
      failedUrls = JSON.parse(Deno.readTextFileSync(FAILED_FILE));
    } catch (e) {
      console.warn("Could not parse failed file, starting fresh.");
    }
  }

  for (let i = startIndex; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[Batch ${i + 1}/${batches.length}] Processing playlist: ${batch.playListUrl} (${batch.urlList.length} videos)`);
    
    let success = false;
    try {
      const response = await fetch(`${HOST}/ytdiff/download`, {
        method: "POST",
        headers,
        body: JSON.stringify(batch)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  Error sending batch: ${response.status} ${errText}`);
      } else {
        console.log(`  Batch queued successfully.`);
        success = true;
      }
    } catch (err) {
      console.error(`  Fetch failed: ${(err as Error).message}. Is yt-diff running?`);
    }

    if (!success) {
      // Append to failed list
      console.warn(`  Recording ${batch.urlList.length} URLs as failed.`);
      const failedEntries = batch.urlList.map(url => ({ playlistUrl: batch.playListUrl, videoUrl: url }));
      failedUrls.push(...failedEntries);
      Deno.writeTextFileSync(FAILED_FILE, JSON.stringify(failedUrls, null, 2));
    }

    // Save state so we can resume
    Deno.writeTextFileSync(STATE_FILE, JSON.stringify({ lastProcessedBatchIndex: i + 1 }, null, 2));

    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log("\nAll batches dispatched!");
  if (failedUrls.length > 0) {
    console.log(`There are ${failedUrls.length} failed URLs stored in ${FAILED_FILE}.`);
  }
}

await run();
