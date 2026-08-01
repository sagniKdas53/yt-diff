import { assertEquals } from "std/assert/mod.ts";
import { createDelivery } from "../src/bot/delivery.ts";
import type { BotAdapter, DeliveryTarget, MessageRef } from "../src/bot/types.ts";

const TARGET: DeliveryTarget = { platform: "telegram", chatId: "42" };

interface FakeAdapterCalls {
  sendFile: { absPath: string; caption: string }[];
}

function fakeAdapter(
  maxUploadBytes: number,
  opts: { failSend?: boolean } = {},
): { adapter: BotAdapter; calls: FakeAdapterCalls } {
  const calls: FakeAdapterCalls = { sendFile: [] };

  const adapter: BotAdapter = {
    platform: "telegram",
    maxUploadBytes,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendText: () =>
      Promise.resolve({
        platform: "telegram",
        chatId: "42",
        messageId: "1",
      } as MessageRef),
    editText: () => Promise.resolve(),
    sendFile: (_to, absPath, caption) => {
      calls.sendFile.push({ absPath, caption });
      if (opts.failSend) {
        return Promise.reject(new Error("upload exploded"));
      }
      return Promise.resolve({
        platform: "telegram",
        chatId: "42",
        messageId: "2",
      } as MessageRef);
    },
  };

  return { adapter, calls };
}

/** Creates a temp save root containing one file of exactly `size` bytes. */
async function withFile(
  size: number,
  fn: (saveLocation: string, fileName: string) => Promise<void>,
) {
  const saveLocation = await Deno.makeTempDir();
  const fileName = "video.mp4";
  await Deno.writeFile(`${saveLocation}/${fileName}`, new Uint8Array(size));
  try {
    await fn(saveLocation, fileName);
  } finally {
    await Deno.remove(saveLocation, { recursive: true });
  }
}

function deliveryFor(saveLocation: string) {
  const signed: { absPath: string; ttl?: number }[] = [];
  const delivery = createDelivery({
    createSignedUrlForPath: (absPath, ttlSeconds) => {
      signed.push({ absPath, ttl: ttlSeconds });
      return Promise.resolve({ signedUrlId: "sig-1", expiry: 0 });
    },
    saveLocation,
    signedUrlTtl: 21600,
    publicBaseUrl: "https://yt.example.com",
    urlBase: "/ytdiff",
  });
  return { delivery, signed };
}

Deno.test("delivery - a file exactly at the cap is uploaded", async () => {
  await withFile(100, async (saveLocation, fileName) => {
    const { adapter, calls } = fakeAdapter(100);
    const { delivery, signed } = deliveryFor(saveLocation);

    const outcome = await delivery.deliver({
      adapter,
      to: TARGET,
      saveDirectory: "",
      fileName,
      caption: "A video",
    });

    assertEquals(outcome.mode, "upload");
    assertEquals(outcome.sizeBytes, 100);
    assertEquals(calls.sendFile.length, 1);
    assertEquals(signed.length, 0);
  });
});

Deno.test("delivery - one byte over the cap is signed instead", async () => {
  await withFile(101, async (saveLocation, fileName) => {
    const { adapter, calls } = fakeAdapter(100);
    const { delivery, signed } = deliveryFor(saveLocation);

    const outcome = await delivery.deliver({
      adapter,
      to: TARGET,
      saveDirectory: "",
      fileName,
      caption: "A video",
    });

    assertEquals(outcome.mode, "signed_url");
    assertEquals(outcome.url, "https://yt.example.com/ytdiff/file?fileId=sig-1");
    // The measured size and reason drive the in-chat explanation.
    assertEquals(outcome.sizeBytes, 101);
    assertEquals(outcome.reason, "too_large");
    // No upload should even be attempted.
    assertEquals(calls.sendFile.length, 0);
    assertEquals(signed.length, 1);
    assertEquals(signed[0].ttl, 21600);
  });
});

Deno.test("delivery - a failed upload degrades to a signed URL", async () => {
  await withFile(10, async (saveLocation, fileName) => {
    const { adapter, calls } = fakeAdapter(100, { failSend: true });
    const { delivery, signed } = deliveryFor(saveLocation);

    const outcome = await delivery.deliver({
      adapter,
      to: TARGET,
      saveDirectory: "",
      fileName,
      caption: "A video",
    });

    // The upload was tried first, then fell back rather than erroring.
    assertEquals(calls.sendFile.length, 1);
    assertEquals(outcome.mode, "signed_url");
    assertEquals(outcome.reason, "upload_failed");
    assertEquals(signed.length, 1);
  });
});

Deno.test("delivery - /link signs without stat-ing or uploading", async () => {
  await withFile(10, async (saveLocation, fileName) => {
    const { adapter, calls } = fakeAdapter(100);
    const { delivery, signed } = deliveryFor(saveLocation);

    const outcome = await delivery.deliver({
      adapter,
      to: TARGET,
      saveDirectory: "",
      fileName,
      caption: "A video",
      forceLink: true,
    });

    assertEquals(outcome.mode, "signed_url");
    assertEquals(outcome.reason, "requested");
    // /link still measures the file so the reply can state its size.
    assertEquals(outcome.sizeBytes, 10);
    assertEquals(calls.sendFile.length, 0);
    assertEquals(signed.length, 1);
  });
});

Deno.test("delivery - joins the save directory into the path", async () => {
  await withFile(10, async (saveLocation, fileName) => {
    await Deno.mkdir(`${saveLocation}/Some Playlist`);
    await Deno.writeFile(
      `${saveLocation}/Some Playlist/${fileName}`,
      new Uint8Array(10),
    );

    const { adapter, calls } = fakeAdapter(100);
    const { delivery } = deliveryFor(saveLocation);

    await delivery.deliver({
      adapter,
      to: TARGET,
      saveDirectory: "Some Playlist",
      fileName,
      caption: "A video",
    });

    assertEquals(
      calls.sendFile[0].absPath,
      `${saveLocation}/Some Playlist/${fileName}`,
    );
  });
});

Deno.test("delivery - buildSignedUrl composes base and urlBase", () => {
  const { delivery } = deliveryFor("/tmp");
  assertEquals(
    delivery.buildSignedUrl("abc"),
    "https://yt.example.com/ytdiff/file?fileId=abc",
  );
});

Deno.test("delivery - an unknown (-1) estimate never triggers a size warning", () => {
  // yt-dlp writes -1 when it has no estimate, which is the norm for x.com.
  // The store normalises that to 0 so `size > threshold` cannot fire on it.
  const normalise = (raw: number) => Math.max(0, Number(raw ?? 0) || 0);
  assertEquals(normalise(-1), 0);
  assertEquals(normalise(0), 0);
  assertEquals(normalise(68645179), 68645179);
});
