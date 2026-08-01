import { logger } from "../logger.ts";
import { stat } from "../utils/fs.ts";
import { join } from "../utils/path.ts";
import type { BotAdapter, DeliveryTarget } from "./types.ts";

export interface DeliveryDependencies {
  createSignedUrlForPath: (
    absPath: string,
    ttlSeconds?: number,
  ) => Promise<{ signedUrlId: string; expiry: number }>;
  saveLocation: string;
  signedUrlTtl: number;
  publicBaseUrl: string;
  urlBase: string;
}

export interface DeliveryRequest {
  adapter: BotAdapter;
  to: DeliveryTarget;
  saveDirectory: string;
  fileName: string;
  caption: string;
  /** /link forces a signed URL even when the file would fit as an upload. */
  forceLink?: boolean;
}

export interface DeliveryOutcome {
  mode: "upload" | "signed_url";
  /** Present when mode is "signed_url". */
  url?: string;
}

export function createDelivery(deps: DeliveryDependencies) {
  /**
   * Builds the externally reachable URL for a signed file.
   *
   * `config.host` is frequently container-internal, so BOT_PUBLIC_BASE_URL is
   * what makes the link work outside the compose network. No new route is
   * needed — the server intercepts any request carrying `?fileId=` before route
   * dispatch.
   */
  function buildSignedUrl(signedUrlId: string): string {
    return `${deps.publicBaseUrl}${deps.urlBase}/file?fileId=${signedUrlId}`;
  }

  async function signAndReturn(absPath: string): Promise<DeliveryOutcome> {
    const { signedUrlId } = await deps.createSignedUrlForPath(
      absPath,
      deps.signedUrlTtl,
    );
    return { mode: "signed_url", url: buildSignedUrl(signedUrlId) };
  }

  /**
   * Sends a finished download to the user, preferring a real file upload.
   *
   * A signed URL is only ever used when the file genuinely exceeds the
   * platform ceiling, the upload call failed, or the user asked for one.
   *
   * @returns How the file was delivered, so the submission can record it
   */
  async function deliver(request: DeliveryRequest): Promise<DeliveryOutcome> {
    const absPath = join(
      deps.saveLocation,
      request.saveDirectory || "",
      request.fileName,
    );

    if (request.forceLink) {
      return await signAndReturn(absPath);
    }

    const { size } = await stat(absPath);

    // Boundary is inclusive: a file exactly at the cap still uploads.
    if (size > request.adapter.maxUploadBytes) {
      logger.debug("File exceeds upload ceiling, sending a link instead", {
        fileName: request.fileName,
        size,
        maxUploadBytes: request.adapter.maxUploadBytes,
      });
      return await signAndReturn(absPath);
    }

    try {
      await request.adapter.sendFile(request.to, absPath, request.caption);
      return { mode: "upload" };
    } catch (error) {
      // An upload failure is not a user-visible failure — it degrades to a link.
      logger.warn("Upload failed, falling back to a signed URL", {
        fileName: request.fileName,
        size,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return await signAndReturn(absPath);
    }
  }

  return { deliver, buildSignedUrl };
}

export type Delivery = ReturnType<typeof createDelivery>;
