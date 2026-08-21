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

Deno.test("validator - ListingRequestBodySchema normalizes scheme-less URLs", () => {
  // The web form takes whatever is pasted, and people rarely type the scheme.
  const result = ListingRequestBodySchema.safeParse({
    urlList: ["youtube.com/watch?v=abc", "https://vimeo.com/1", "iwara.tv/v/2"],
  });

  assertEquals(result.success, true);
  assertEquals(result.success && result.data.urlList, [
    "https://youtube.com/watch?v=abc",
    "https://vimeo.com/1",
    "https://iwara.tv/v/2",
  ]);
});

Deno.test("validator - ListingRequestBodySchema rejects argument injection", () => {
  const payloads = [
    "--config-location=/tmp/planted.conf",
    "--exec=touch /tmp/pwned",
    "-o/tmp/out.%(ext)s",
    "file:///etc/passwd",
    "not a url",
    // yt-dlp's own non-URL prefix forms stay out too.
    "ytsearch:cats",
    ":ytfav",
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
});

Deno.test("validator - bulk signed files stay partial-success", () => {
  // The caller batches one entry per row on screen, including videos it has
  // not downloaded and so cannot name. Those entries are skipped by the
  // handler, not fatal to the batch — the response already carries a null per
  // entry it could not resolve.
  assertEquals(
    BulkSignedFilesRequestBodySchema.safeParse({
      files: [
        { saveDirectory: "dir", fileName: "downloaded.mp4" },
        { saveDirectory: "dir" },
      ],
    }).success,
    true,
  );

  // The name rules still apply to entries that do carry a name.
  assertEquals(
    BulkSignedFilesRequestBodySchema.safeParse({
      files: [{ fileName: "../escape.mp4" }],
    }).success,
    false,
  );
});

Deno.test("validator - fileName accepts what yt-dlp actually writes", () => {
  // Spaces, unicode, emoji, multi-dot extensions, no extension and a leading
  // dot are all legitimate names on disk and must keep resolving.
  const names = [
    "video.mp4",
    "my video (1080p) [id].mkv",
    "Vidéo — épisode 1.mp4",
    "\u65E5\u672C\u8A9E\u306E\u30D3\u30C7\u30AA.webm",
    "clip \u{1F3AC} take 2.mp4",
    "lecture.en.srt",
    "track.f251.m4a",
    "cafe\u0301.opus",
    "Clip.MP4",
    "no-extension",
    ".hidden.mp4",
    "trailing space .mp4",
    "100% done.webm",
    "a'b\"c.mp4",
  ];

  for (const fileName of names) {
    const result = SignedFileRequestBodySchema.safeParse({
      saveDirectory: "some dir",
      fileName,
    });
    assertEquals(result.success, true, `rejected ${JSON.stringify(fileName)}`);
  }
});

Deno.test("validator - fileName rejects what cannot name a file here", () => {
  const names: Record<string, string> = {
    "subdir/file.mp4": "forward slash",
    "subdir\\file.mp4": "backslash",
    "../secret.mp4": "traversal",
    "..": "parent reference",
    ".": "self reference",
    "": "empty",
    "file\u0000.mp4": "null byte",
    "file\n.mp4": "newline",
    "file\r\nlevel=error.mp4": "log forging",
    "file\u007f.mp4": "delete character",
  };

  for (const [fileName, why] of Object.entries(names)) {
    const result = SignedFileRequestBodySchema.safeParse({ fileName });
    assertEquals(result.success, false, `accepted ${why}`);
  }
});

Deno.test("validator - bulk signed files carry the same name rules", () => {
  const result = BulkSignedFilesRequestBodySchema.safeParse({
    files: [
      { saveDirectory: "Some Playlist", fileName: "Vidéo n°1.mp4" },
      { saveDirectory: "", fileName: "track \u{1F3B5}.m4a" },
    ],
  });
  assertEquals(result.success, true);

  assertEquals(
    BulkSignedFilesRequestBodySchema.safeParse({
      files: [{ fileName: "ok.mp4" }, { fileName: "../escape.mp4" }],
    }).success,
    false,
  );

  // A bare directory name clears every rule here — nothing in a string can
  // say "this is a file". That is what the isFile stat in the handler is for.
  assertEquals(
    SignedFileRequestBodySchema.safeParse({ fileName: "Some Playlist" })
      .success,
    true,
  );
});
