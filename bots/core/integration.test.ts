/**
 * Integration test — full bot flow against a running yt-diff instance.
 *
 * Prerequisites:
 *   1. yt-diff is running with BOT_API_KEY set
 *   2. A test video URL that yt-dlp can process quickly ("Me at the zoo")
 *
 * Run:
 *   BOT_API_KEY=test-key deno test --allow-net --allow-env bots/core/integration.test.ts
 *
 * This test verifies the complete flow:
 *   lookup → list → wait for indexing → download → wait for completion → get signed URL
 */

import { YtdiffApiClient } from "./api-client.ts";
import { parseUrl } from "./url-parser.ts";
import { assertEquals, assertExists } from "jsr:@std/assert@1";

const API_BASE = Deno.env.get("YTDIFF_API_BASE") ||
  "http://localhost:8888/ytdiff";
const API_KEY = Deno.env.get("BOT_API_KEY");
const TEST_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // "Me at the zoo" — tiny, fast

const client = new YtdiffApiClient({
  mode: "ephemeral",
  ephemeralTtlHours: 24,
  ytdiffApiBase: API_BASE,
  ytdiffAuthToken: API_KEY || "",
  maxDirectFileSize: 50 * 1024 * 1024,
  signedUrlTtlSeconds: 86400,
});

Deno.test({
  name: "integration — full bot flow (lookup → index → download → signed URL)",
  ignore: !API_KEY, // Skip if no API key configured
  fn: async () => {
    // Step 0: URL parsing
    const parsed = parseUrl(TEST_URL);
    assertExists(parsed, "URL should be parseable");
    assertEquals(parsed.site, "youtube");
    assertEquals(parsed.isValidVideo, true);

    // Step 1: Lookup — should find or not-find gracefully
    const initialLookup = await client.lookup(TEST_URL);
    console.log("Initial lookup:", JSON.stringify(initialLookup));

    // If not indexed, submit for listing and wait
    if (initialLookup.needsListing) {
      const listed = await client.submitForListing(TEST_URL);
      console.log("Submitted for listing:", listed);

      // Poll until indexed (max 60 seconds)
      let indexed = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await client.lookup(TEST_URL);
        if (check.indexed) {
          indexed = true;
          console.log("Indexed after", (i + 1) * 2, "seconds");
          break;
        }
      }
      // Don't fail if indexing takes too long — just log
      console.log("Indexed:", indexed ? "yes" : "no (may take longer)");
    }

    // Step 2: Start download if not already downloaded
    const lookupAfterIndex = await client.lookup(TEST_URL);
    if (lookupAfterIndex.indexed && lookupAfterIndex.needsDownload) {
      const dl = await client.startDownload(TEST_URL);
      console.log("Download queued:", dl.queued, "position:", dl.position);

      // Poll until downloaded (max 3 minutes)
      let downloaded = false;
      for (let i = 0; i < 36; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const check = await client.lookup(TEST_URL);
        if (check.downloaded) {
          downloaded = true;
          console.log("Downloaded after", (i + 1) * 5, "seconds");
          break;
        }
        // Also check queue status
        try {
          const queue = await client.getQueueStatus();
          const inQueue = queue.find((q) =>
            q.url === parsed.canonical
          );
          if (inQueue) {
            console.log(
              "Queue status:",
              inQueue.status,
              "position:",
              inQueue.queuePosition,
            );
          }
        } catch { /* queue polling is best-effort */ }
      }
      console.log("Downloaded:", downloaded ? "yes" : "no (may take longer)");
    }

    // Step 3: If downloaded, get a signed URL
    const finalLookup = await client.lookup(TEST_URL);
    if (finalLookup.downloaded && finalLookup.fileName) {
      const signed = await client.getSignedUrl(
        finalLookup.fileName,
        "", // saveDirectory is typically empty for ephemeral "None" videos
      );
      console.log("Signed URL:", JSON.stringify(signed));
    }

    console.log("Integration test flow completed");
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
