import { assertEquals } from "std/assert/mod.ts";
import {
  BulkRefreshSignedUrlsRequestBodySchema,
  BulkSignedFilesRequestBodySchema,
  DedupRequestBodySchema,
  DeletePlaylistRequestBodySchema,
  DeleteVideosRequestBodySchema,
  DownloadRequestBodySchema,
  IsRegistrationAllowedSchema,
  ListingRequestBodySchema,
  PlaylistDisplayRequestSchema,
  QueueStatusRequestBodySchema,
  RefreshSignedUrlRequestBodySchema,
  ReindexAllRequestBodySchema,
  SignedFileRequestBodySchema,
  SubListRequestSchema,
  UpdatePlaylistMonitoringRequestSchema,
  UserAuthSchema,
  validateBody,
} from "../src/middleware/validator.ts";

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(content: string) {
    this.body = content;
  }
}

Deno.test("validator - validateBody passes valid data to handler", () => {
  let handlerCalled = false;
  let parsedData: any = null;

  const handler = validateBody(UserAuthSchema, (data, _res) => {
    handlerCalled = true;
    parsedData = data;
  });

  const res = new MockResponse() as any;
  const payload = { username: "alice", password: "securepassword" };

  handler(payload, res);

  assertEquals(handlerCalled, true);
  assertEquals(parsedData.username, "alice");
  assertEquals(parsedData.password, "securepassword");
  assertEquals(res.statusCode, 200);
});

Deno.test("validator - validateBody rejects invalid payloads with 400", () => {
  let handlerCalled = false;
  const handler = validateBody(UserAuthSchema, (_data, _res) => {
    handlerCalled = true;
  });

  const res = new MockResponse() as any;
  const payload = { username: "alice" }; // missing password

  handler(payload, res);

  assertEquals(handlerCalled, false);
  assertEquals(res.statusCode, 400);

  const body = JSON.parse(res.body);
  assertEquals(body.status, "error");
  assertEquals(body.message, "Invalid payload");
  assertEquals(Array.isArray(body.errors), true);
});

Deno.test("validator - ListingRequestBodySchema parses valid listings", () => {
  const result = ListingRequestBodySchema.safeParse({
    urlList: ["https://example.com/playlist"],
    chunkSize: 5,
    sleep: true,
    monitoringType: "Full",
  });
  assertEquals(result.success, true);
});

Deno.test("validator - DownloadRequestBodySchema enforces mandatory fields", () => {
  const result = DownloadRequestBodySchema.safeParse({});
  assertEquals(result.success, false);
});

Deno.test("validator - UpdatePlaylistMonitoringRequestSchema parsing", () => {
  const result = UpdatePlaylistMonitoringRequestSchema.safeParse({
    url: "https://example.com",
    watch: "Full",
  });
  assertEquals(result.success, true);
});

Deno.test("validator - PlaylistDisplayRequestSchema parsing", () => {
  const result = PlaylistDisplayRequestSchema.safeParse({
    start: 0,
    stop: 10,
    sort: "title",
    order: "asc",
    query: "search term",
  });
  assertEquals(result.success, true);
});

Deno.test("validator - DeletePlaylistRequestBodySchema parsing", () => {
  const result = DeletePlaylistRequestBodySchema.safeParse({
    playListUrl: "https://example.com",
    deleteAllVideosInPlaylist: true,
    deletePlaylist: false,
    cleanUp: true,
  });
  assertEquals(result.success, true);
});

Deno.test("validator - SubListRequestSchema parsing", () => {
  const result = SubListRequestSchema.safeParse({
    url: "https://example.com",
    start: 0,
    stop: 10,
    query: "query",
    sortDownloaded: true,
  });
  assertEquals(result.success, true);
});

Deno.test("validator - DeleteVideosRequestBodySchema parsing", () => {
  const result = DeleteVideosRequestBodySchema.safeParse({
    playListUrl: "https://example.com",
    mappingIds: ["id1", "id2"],
    videoUrls: ["url1"],
    cleanUp: true,
    deleteVideoMappings: true,
    deleteVideosInDB: false,
  });
  assertEquals(result.success, true);
});

Deno.test("validator - ReindexAllRequestBodySchema parsing", () => {
  const result = ReindexAllRequestBodySchema.safeParse({
    start: 0,
    stop: 10,
    siteFilter: "youtube",
    chunkSize: 5,
  });
  assertEquals(result.success, true);
});

Deno.test("validator - SignedFileRequestBodySchema rejects traversal", () => {
  const okResult = SignedFileRequestBodySchema.safeParse({
    saveDirectory: "some_dir",
    fileName: "file.txt",
  });
  assertEquals(okResult.success, true);

  const badResult = SignedFileRequestBodySchema.safeParse({
    saveDirectory: "some_dir",
    fileName: "subdir/file.txt", // contains slash
  });
  assertEquals(badResult.success, false);
});

Deno.test("validator - RefreshSignedUrlRequestBodySchema parsing", () => {
  const result = RefreshSignedUrlRequestBodySchema.safeParse({
    fileId: "uuid-123",
  });
  assertEquals(result.success, true);
});

Deno.test("validator - BulkRefreshSignedUrlsRequestBodySchema parsing", () => {
  const result = BulkRefreshSignedUrlsRequestBodySchema.safeParse({
    fileIds: ["id1", "id2"],
  });
  assertEquals(result.success, true);
});

Deno.test("validator - BulkSignedFilesRequestBodySchema parsing", () => {
  const result = BulkSignedFilesRequestBodySchema.safeParse({
    files: [
      { saveDirectory: "dir1", fileName: "file1.txt" },
      { saveDirectory: "dir2", fileName: "file2.txt" },
    ],
  });
  assertEquals(result.success, true);
});

Deno.test("validator - IsRegistrationAllowedSchema parsing", () => {
  const result = IsRegistrationAllowedSchema.safeParse({
    sendStats: true,
  });
  assertEquals(result.success, true);
});

Deno.test("validator - DedupRequestBodySchema parsing", () => {
  const result = DedupRequestBodySchema.safeParse({
    dryRun: false,
    siteFilter: "youtube",
  });
  assertEquals(result.success, true);
});

Deno.test("validator - QueueStatusRequestBodySchema parsing", () => {
  const result = QueueStatusRequestBodySchema.safeParse({});
  assertEquals(result.success, true);
});
