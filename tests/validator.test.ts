// deno-lint-ignore-file no-explicit-any
// The response mock is cast to the real http type so the validators run against
// their true signatures. Same convention as src/transport/http.ts.
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

// --- C1 / Q7: the /list and /download boundary ------------------------------
//
// Every element of urlList reaches a yt-dlp argv as a positional argument, and
// normalizeUrl hands unparseable strings straight through. These cases pin the
// schema half of that fix; tests/url.test.ts pins the "--" half.

Deno.test("validator - ListingRequestBodySchema requires urlList", () => {
  assertEquals(ListingRequestBodySchema.safeParse({}).success, false);
  assertEquals(
    ListingRequestBodySchema.safeParse({ chunkSize: 5 }).success,
    false,
  );
});

Deno.test("validator - ListingRequestBodySchema rejects argument injection", () => {
  const payloads = [
    "--config-location=/tmp/planted.conf",
    "--exec=touch /tmp/pwned",
    "-o/tmp/out.%(ext)s",
    "file:///etc/passwd",
    "not a url",
  ];

  for (const payload of payloads) {
    const result = ListingRequestBodySchema.safeParse({ urlList: [payload] });
    assertEquals(result.success, false, `accepted ${payload}`);
  }

  // A flag hidden behind a legitimate URL is rejected just the same.
  assertEquals(
    ListingRequestBodySchema.safeParse({
      urlList: ["https://example.com/playlist", "--config-location=/tmp/x"],
    }).success,
    false,
  );
});

Deno.test("validator - DownloadRequestBodySchema rejects argument injection", () => {
  assertEquals(
    DownloadRequestBodySchema.safeParse({
      urlList: ["--config-location=/tmp/planted.conf"],
    }).success,
    false,
  );
  assertEquals(
    DownloadRequestBodySchema.safeParse({
      urlList: ["https://example.com/video"],
      playListUrl: "None",
    }).success,
    true,
  );
});

Deno.test("validator - UpdatePlaylistMonitoringRequestSchema requires both fields", () => {
  assertEquals(
    UpdatePlaylistMonitoringRequestSchema.safeParse({
      url: "https://example.com",
    }).success,
    false,
  );
  assertEquals(
    UpdatePlaylistMonitoringRequestSchema.safeParse({ watch: "Full" }).success,
    false,
  );
  assertEquals(
    UpdatePlaylistMonitoringRequestSchema.safeParse({
      url: "https://example.com",
      watch: "",
    }).success,
    false,
  );
});

Deno.test("validator - delete schemas require a playlist key", () => {
  assertEquals(
    DeletePlaylistRequestBodySchema.safeParse({ deletePlaylist: true }).success,
    false,
  );
  assertEquals(
    DeleteVideosRequestBodySchema.safeParse({ cleanUp: true }).success,
    false,
  );

  // "None" is the pseudo-playlist for unlisted videos, not a URL — it has to
  // keep parsing, which is why these are plain non-empty strings.
  assertEquals(
    DeleteVideosRequestBodySchema.safeParse({
      playListUrl: "None",
      mappingIds: ["m1"],
    }).success,
    true,
  );
});

Deno.test("validator - signed-file schemas require their identifiers", () => {
  assertEquals(
    SignedFileRequestBodySchema.safeParse({ saveDirectory: "dir" }).success,
    false,
  );
  assertEquals(RefreshSignedUrlRequestBodySchema.safeParse({}).success, false);
  assertEquals(
    BulkRefreshSignedUrlsRequestBodySchema.safeParse({}).success,
    false,
  );
  assertEquals(BulkSignedFilesRequestBodySchema.safeParse({}).success, false);

  // Entries inside a bulk request carry the same requirement as a single one.
  assertEquals(
    BulkSignedFilesRequestBodySchema.safeParse({
      files: [{ saveDirectory: "dir" }],
    }).success,
    false,
  );
});
