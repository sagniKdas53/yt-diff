// deno-lint-ignore-file no-explicit-any
import type { HttpRequestLike, HttpResponseLike } from "./http.ts";
import { logger } from "../logger.ts";

type Listener = (...args: any[]) => void;

function normalizeHeaders(
  headers: Headers,
): Record<string, string | string[] | undefined> {
  const normalized: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

function toUint8Array(chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
}

class DenoRequestAdapter implements HttpRequestLike {
  readonly method?: string;
  readonly url?: string;
  readonly headers: HttpRequestLike["headers"];
  readonly socket: HttpRequestLike["socket"];

  #request: Request;
  #listeners = new Map<string, Set<Listener>>();
  #bodyPumpStarted = false;
  #destroyed = false;

  constructor(request: Request, remoteAddress?: string) {
    const url = new URL(request.url);
    this.#request = request;
    this.method = request.method;
    this.url = `${url.pathname}${url.search}`;
    this.headers = normalizeHeaders(
      request.headers,
    ) as HttpRequestLike["headers"];
    this.socket = { remoteAddress };
  }

  on(event: string, listener: Listener): this {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event)?.add(listener);

    if (event === "data" || event === "end" || event === "error") {
      this.#startBodyPump();
    }

    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  #emit(event: string, ...args: unknown[]) {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  #startBodyPump() {
    if (this.#bodyPumpStarted) {
      return;
    }
    this.#bodyPumpStarted = true;

    queueMicrotask(async () => {
      try {
        if (!this.#request.body) {
          if (!this.#destroyed) {
            this.#emit("end");
          }
          return;
        }

        const reader = this.#request.body.getReader();
        while (!this.#destroyed) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            this.#emit("data", value);
          }
        }

        if (!this.#destroyed) {
          this.#emit("end");
        }
      } catch (error) {
        if (!this.#destroyed) {
          this.#emit(
            "error",
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    });
  }
}

class DenoResponseAdapter implements HttpResponseLike {
  headersSent = false;

  readonly #requestMethod: string;
  readonly #headers = new Headers();
  #status = 200;
  #ended = false;
  #resolveResponse: ((response: Response) => void) | null = null;
  readonly #responsePromise: Promise<Response>;

  // Streaming support: when write() is called, we create a ReadableStream
  // and resolve the response promise immediately so the client receives
  // data progressively instead of waiting for the entire body to buffer.
  #streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  #streamStarted = false;

  constructor(requestMethod: string) {
    this.#requestMethod = requestMethod;
    this.#responsePromise = new Promise<Response>((resolve) => {
      this.#resolveResponse = resolve;
    });
  }

  setHeader(name: string, value: string | number): void {
    this.#headers.set(name, String(value));
  }

  writeHead(
    statusCode: number,
    headers?: Record<string, string | number>,
  ): void {
    this.#status = statusCode;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        this.#headers.set(name, String(value));
      }
    }
    this.headersSent = true;
  }

  /**
   * Lazily initialise the ReadableStream and resolve the response promise
   * with it so that Deno.serve starts sending bytes to the client immediately.
   */
  #ensureStream(): void {
    if (this.#streamStarted) {
      return;
    }
    this.#streamStarted = true;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#streamController = controller;
      },
    });

    const shouldSendBody = this.#requestMethod !== "HEAD" &&
      this.#status !== 204;
    this.#resolveResponse?.(
      new Response(shouldSendBody ? stream : null, {
        status: this.#status,
        headers: this.#headers,
      }),
    );
    this.#resolveResponse = null;
  }

  write(chunk: string | Uint8Array): void {
    if (this.#ended) {
      return;
    }
    this.headersSent = true;
    this.#ensureStream();
    const bytes = toUint8Array(chunk);
    // Defensive copy — callers may pass views into a reusable buffer
    this.#streamController?.enqueue(bytes.slice());
  }

  end(chunk?: string | Uint8Array): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;

    if (!this.#streamStarted) {
      // No prior write() — send a simple, non-streaming Response.
      // This is the common path for JSON API responses.
      const shouldSendBody = this.#requestMethod !== "HEAD" &&
        this.#status !== 204;
      let body: BodyInit | null = null;
      if (shouldSendBody && chunk !== undefined) {
        const bytes = toUint8Array(chunk);
        body = bytes.slice().buffer as ArrayBuffer;
      }
      this.#resolveResponse?.(
        new Response(body, {
          status: this.#status,
          headers: this.#headers,
        }),
      );
      return;
    }

    // Stream was already started — enqueue the final chunk and close.
    if (chunk !== undefined) {
      const bytes = toUint8Array(chunk);
      this.#streamController?.enqueue(bytes.slice());
    }
    try {
      this.#streamController?.close();
    } catch {
      // Stream may already be closed or errored (e.g. client disconnected).
    }
  }

  asResponse(): Promise<Response> {
    return this.#responsePromise;
  }
}

export async function handleNodeStyleRequest(
  request: Request,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
  handler: (
    req: HttpRequestLike,
    res: HttpResponseLike,
  ) => Promise<void> | void,
): Promise<Response> {
  const remoteAddress = info.remoteAddr.transport === "tcp"
    ? info.remoteAddr.hostname
    : undefined;
  const req = new DenoRequestAdapter(request, remoteAddress);
  const res = new DenoResponseAdapter(request.method);

  await handler(req, res);

  return await res.asResponse();
}

export async function proxyHttpRequest(
  request: Request,
  upstreamOrigin: string,
): Promise<Response> {
  const url = new URL(request.url);
  const upstreamUrl = new URL(`${url.pathname}${url.search}`, upstreamOrigin);
  const headers = new Headers(request.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  return await fetch(upstreamUrl, init);
}

export function proxyWebSocketRequest(
  request: Request,
  upstreamOrigin: string,
): Response {
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(request);
  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    upstreamOrigin,
  );
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";

  const protocolHeader = request.headers.get("sec-websocket-protocol");
  const protocols = protocolHeader?.split(",").map((value) => value.trim())
    .filter(Boolean);

  const upstreamSocket = protocols && protocols.length > 0
    ? new WebSocket(upstreamUrl, protocols)
    : new WebSocket(upstreamUrl);

  const pendingMessages: Array<string | ArrayBuffer | Blob | ArrayBufferView> =
    [];

  clientSocket.binaryType = "arraybuffer";
  upstreamSocket.binaryType = "arraybuffer";

  clientSocket.onmessage = (event) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(event.data);
    } else if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      pendingMessages.push(
        event.data as string | ArrayBuffer | Blob | ArrayBufferView,
      );
    }
  };

  upstreamSocket.onopen = () => {
    for (const message of pendingMessages) {
      upstreamSocket.send(message);
    }
    pendingMessages.length = 0;
  };

  upstreamSocket.onmessage = (event) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(event.data);
    }
  };

  clientSocket.onclose = (event) => {
    if (
      upstreamSocket.readyState === WebSocket.OPEN ||
      upstreamSocket.readyState === WebSocket.CONNECTING
    ) {
      try {
        upstreamSocket.close(event.code, event.reason);
      } catch (error) {
        // WebSocket close code 1000 = normal closure.
        // 1001 = server shutting down or user navigating away.
        // 1006 = abnormal close (network drop, no close frame received).
        // 1008 = policy violation.
        // Codes 4000-4999 are available for your application.
        if (event.code == 1001 || event.code == 1006 || event.code == 1008) {
          logger.warn("Error closing upstream websocket", {
            code: event.code,
            reason: event.reason,
          });
          return;
        }
        logger.error("Error closing upstream websocket", {
          error: error as Error,
        });
      }
    }
  };

  upstreamSocket.onclose = (event) => {
    if (
      clientSocket.readyState === WebSocket.OPEN ||
      clientSocket.readyState === WebSocket.CONNECTING
    ) {
      clientSocket.close(event.code, event.reason);
    }
  };

  clientSocket.onerror = () => {
    if (
      upstreamSocket.readyState === WebSocket.OPEN ||
      upstreamSocket.readyState === WebSocket.CONNECTING
    ) {
      upstreamSocket.close(1000, "Client websocket error");
    }
  };

  upstreamSocket.onerror = () => {
    if (
      clientSocket.readyState === WebSocket.OPEN ||
      clientSocket.readyState === WebSocket.CONNECTING
    ) {
      clientSocket.close(1000, "Upstream websocket error");
    }
  };

  return response;
}
