import type { HttpRequestLike, HttpResponseLike } from "./http.ts";

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

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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
    this.headers = normalizeHeaders(request.headers) as HttpRequestLike["headers"];
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
  readonly #chunks: Uint8Array[] = [];
  #status = 200;
  #ended = false;
  #resolveResponse: ((response: Response) => void) | null = null;
  readonly #responsePromise: Promise<Response>;

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

  write(chunk: string | Uint8Array): void {
    if (this.#ended) {
      return;
    }
    this.headersSent = true;
    this.#chunks.push(toUint8Array(chunk));
  }

  end(chunk?: string | Uint8Array): void {
    if (this.#ended) {
      return;
    }
    if (chunk !== undefined) {
      this.write(chunk);
    }
    this.#ended = true;
    const shouldSendBody = this.#requestMethod !== "HEAD" && this.#status !== 204;
    this.#resolveResponse?.(
      new Response(
        shouldSendBody ? toArrayBuffer(concatChunks(this.#chunks)) : null,
        {
          status: this.#status,
          headers: this.#headers,
        },
      ),
    );
  }

  asResponse(): Promise<Response> {
    return this.#responsePromise;
  }
}

export async function handleNodeStyleRequest(
  request: Request,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
  handler: (req: HttpRequestLike, res: HttpResponseLike) => Promise<void> | void,
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
      upstreamSocket.close(event.code, event.reason);
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
      upstreamSocket.close(1011, "Client websocket error");
    }
  };

  upstreamSocket.onerror = () => {
    if (
      clientSocket.readyState === WebSocket.OPEN ||
      clientSocket.readyState === WebSocket.CONNECTING
    ) {
      clientSocket.close(1011, "Upstream websocket error");
    }
  };

  return response;
}
