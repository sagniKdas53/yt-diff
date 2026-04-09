import type Redis from "ioredis";

export interface SignedFileMetadata {
  filePath: string;
  mimeType: string;
  inline: boolean;
}

/**
 * Retrieves file metadata from Redis based on the fileId in the URL.
 */
export async function getSignedFileMetadata(
  request: Request,
  redis: Redis,
  cacheMaxAge: number,
): Promise<SignedFileMetadata | null> {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("fileId");
  const inline = url.searchParams.get("inline") === "true";

  if (!fileId) {
    return null;
  }

  const cachedEntry = await redis.get(`signed:${fileId}`);
  if (!cachedEntry) {
    return null;
  }

  // Refresh expiration
  await redis.expire(`signed:${fileId}`, cacheMaxAge);

  try {
    const signedEntry = JSON.parse(cachedEntry) as {
      filePath: string;
      mimeType?: string;
    };

    return {
      filePath: signedEntry.filePath,
      mimeType: signedEntry.mimeType || "application/octet-stream",
      inline,
    };
  } catch {
    return null;
  }
}
