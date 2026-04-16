// deno-lint-ignore-file no-explicit-any
export interface HttpSocketLike {
  remoteAddress?: string;
}

export interface HttpRequestLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined> & {
    authorization?: string;
    Authorization?: string;
    range?: string;
    "accept-encoding"?: string;
  };
  socket: HttpSocketLike;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  destroy(): void;
}

export interface HttpResponseLike {
  headersSent: boolean;
  setHeader(name: string, value: string | number): unknown;
  writeHead(
    statusCode: number,
    headers?: Record<string, string | number>,
  ): unknown;
  write(chunk: string | Uint8Array): unknown;
  end(chunk?: string | Uint8Array): unknown;
}
