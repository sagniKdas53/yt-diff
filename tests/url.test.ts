import { assertEquals } from "std/assert/mod.ts";
import {
  appendUrlArg,
  canonicalizePlaylistUrl,
  hasEphemeralThumbnails,
  isHostOrSubdomain,
  isHttpUrl,
  isSiteIwaraDotTv,
  isSiteXDotCom,
  isSiteYouTube,
  normalizeUrl,
  toHttpUrl,
} from "../src/utils/url.ts";

Deno.test("url - isHttpUrl accepts only http and https", () => {
  assertEquals(isHttpUrl("https://example.com/watch?v=abc"), true);
  assertEquals(isHttpUrl("http://example.com"), true);

  // Other schemes parse fine but must not reach a yt-dlp argv.
  assertEquals(isHttpUrl("file:///etc/passwd"), false);
  assertEquals(isHttpUrl("data:text/plain,hi"), false);
  assertEquals(isHttpUrl("ftp://example.com/x"), false);
});

Deno.test("url - isHttpUrl rejects flag-shaped strings", () => {
  // These are the C1 payloads: they never parse as a URL, so normalizeUrl
  // returned them untouched and they landed in argv as options.
  assertEquals(isHttpUrl("--config-location=/tmp/planted.conf"), false);
  assertEquals(isHttpUrl("--exec=touch /tmp/pwned"), false);
  assertEquals(isHttpUrl("-o/tmp/out.%(ext)s"), false);
  assertEquals(isHttpUrl(""), false);
  assertEquals(isHttpUrl("not a url at all"), false);
});

Deno.test("url - appendUrlArg puts the URL behind an option terminator", () => {
  assertEquals(
    appendUrlArg(["--dump-json", "--no-download"], "https://example.com/v"),
    ["--dump-json", "--no-download", "--", "https://example.com/v"],
  );
});

Deno.test("url - appendUrlArg leaves the caller's options untouched", () => {
  const options = ["-P", "home:/data"];
  const args = appendUrlArg(options, "https://example.com/v");

  assertEquals(options, ["-P", "home:/data"]);
  assertEquals(args, ["-P", "home:/data", "--", "https://example.com/v"]);
});

Deno.test("url - a flag-shaped URL stays positional after the terminator", () => {
  // Belt and braces: even if something slips past the schema, "--" keeps the
  // value out of yt-dlp's option namespace.
  const args = appendUrlArg(["--dump-json"], "--config-location=/tmp/x");

  assertEquals(args.indexOf("--") < args.length - 1, true);
  assertEquals(args[args.length - 1], "--config-location=/tmp/x");
});

// --- toHttpUrl: the /list and /download boundary ----------------------------
//
// isHttpUrl above is the bot's bar, where a bare word must stay chatter.
// toHttpUrl is the web form's: it parses rather than validates, so a pasted
// URL without a scheme still works, and every accepted value comes back as a
// serialization that starts with a scheme.

Deno.test("toHttpUrl - accepts scheme-less URLs across supported sites", () => {
  // A spread of shapes from yt-dlp's supported-sites list, as a person would
  // paste them out of an address bar.
  const cases: [string, string][] = [
    [
      "youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
    ],
    [
      "www.youtube.com/@creator/videos",
      "https://www.youtube.com/@creator/videos",
    ],
    ["youtu.be/dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ"],
    ["m.youtube.com/shorts/abc123", "https://m.youtube.com/shorts/abc123"],
    [
      "bilibili.com/video/BV1x411c7mD",
      "https://bilibili.com/video/BV1x411c7mD",
    ],
    ["nicovideo.jp/watch/sm9", "https://nicovideo.jp/watch/sm9"],
    ["vimeo.com/123456789", "https://vimeo.com/123456789"],
    ["soundcloud.com/artist/track", "https://soundcloud.com/artist/track"],
    ["twitch.tv/videos/123", "https://twitch.tv/videos/123"],
    ["iwara.tv/video/abc", "https://iwara.tv/video/abc"],
    ["x.com/user/status/123", "https://x.com/user/status/123"],
  ];

  for (const [input, expected] of cases) {
    assertEquals(toHttpUrl(input), expected, `on ${input}`);
  }
});

Deno.test("toHttpUrl - keeps URLs that already carry a scheme", () => {
  assertEquals(
    toHttpUrl("https://example.com/watch?v=1"),
    "https://example.com/watch?v=1",
  );
  // http is preserved here; normalizeUrl forces https further down.
  assertEquals(toHttpUrl("http://example.com/v"), "http://example.com/v");
  assertEquals(toHttpUrl("HTTPS://Example.COM/v"), "https://example.com/v");
});

Deno.test("toHttpUrl - handles hosts, ports, IPs and internationalized names", () => {
  // "example.com:8443/v" parses as scheme "example.com:" on its own, so this
  // is the case that a naive protocol check gets wrong.
  assertEquals(toHttpUrl("example.com:8443/v"), "https://example.com:8443/v");
  assertEquals(toHttpUrl("localhost:8080/v"), "https://localhost:8080/v");
  assertEquals(toHttpUrl("127.0.0.1:3000/v"), "https://127.0.0.1:3000/v");
  assertEquals(toHttpUrl("[::1]:8080/v"), "https://[::1]:8080/v");
  // IDN hosts are punycoded by the URL parser rather than rejected.
  assertEquals(
    toHttpUrl("пример.рф/видео"),
    "https://xn--e1afmkfd.xn--p1ai/%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE",
  );
  assertEquals(
    toHttpUrl("  youtube.com/watch?v=1  "),
    "https://youtube.com/watch?v=1",
  );
});

Deno.test("toHttpUrl - rejects the C1 payloads even though prefixing would parse them", () => {
  // "https://" + "--config-location=/tmp/x" parses, with the flag as the
  // hostname. The leading-hyphen check is what stops it being laundered.
  assertEquals(toHttpUrl("--config-location=/tmp/planted.conf"), null);
  assertEquals(toHttpUrl("--exec=touch /tmp/pwned"), null);
  assertEquals(toHttpUrl("-o/tmp/out.%(ext)s"), null);
  assertEquals(toHttpUrl("  --dump-json  "), null);
});

Deno.test("toHttpUrl - rejects other schemes and non-URL text", () => {
  assertEquals(toHttpUrl("file:///etc/passwd"), null);
  assertEquals(toHttpUrl("file://evil.example/x"), null);
  assertEquals(toHttpUrl("data:text/plain,hi"), null);
  assertEquals(toHttpUrl("javascript:alert(1)"), null);
  assertEquals(toHttpUrl("ftp://example.com/x"), null);
  assertEquals(toHttpUrl("/etc/passwd"), null);
  assertEquals(toHttpUrl("notaurl"), null);
  assertEquals(toHttpUrl("not a url"), null);
  assertEquals(toHttpUrl(""), null);
  assertEquals(toHttpUrl("   "), null);
});

Deno.test("toHttpUrl - rejects yt-dlp's non-URL prefix forms", () => {
  // Deliberate: this app keys playlists by URL, and the account-scoped ones
  // would spend the operator's cookies on behalf of whoever submitted them.
  assertEquals(toHttpUrl("ytsearch:cats"), null);
  assertEquals(toHttpUrl("ytsearch10:cats"), null);
  assertEquals(toHttpUrl(":ytfav"), null);
  assertEquals(toHttpUrl(":ytsubs"), null);
  assertEquals(toHttpUrl(":ythistory"), null);
  assertEquals(toHttpUrl("scsearch:jazz"), null);
  assertEquals(toHttpUrl("bilisearch:cats"), null);
});

Deno.test("toHttpUrl - every accepted value is safe to place in an argv", () => {
  const inputs = [
    "youtube.com/watch?v=1",
    "https://example.com/v",
    "example.com:8443/v",
    "//example.com/v",
    "[::1]:8080/v",
    "user:pass@example.com/v",
  ];

  for (const input of inputs) {
    const normalized = toHttpUrl(input);
    assertEquals(normalized !== null, true, `rejected ${input}`);
    // The output invariant C1 rests on: never mistakable for an option.
    assertEquals(
      normalized!.startsWith("https://") || normalized!.startsWith("http://"),
      true,
      `${input} -> ${normalized}`,
    );
  }
});

// --- host predicates -------------------------------------------------------
//
// One matcher underneath all of them. The copies these replace each answered
// "is this an unparseable URL?" differently, so a typo could match on one path
// and miss on another.

Deno.test("url - isHostOrSubdomain matches the domain and its subdomains only", () => {
  assertEquals(isHostOrSubdomain("x.com", "x.com"), true);
  assertEquals(isHostOrSubdomain("sub.x.com", "x.com"), true);
  assertEquals(isHostOrSubdomain("a.b.x.com", "x.com"), true);

  // The suffix trap the string-contains version fell into.
  assertEquals(isHostOrSubdomain("not-x.com", "x.com"), false);
  assertEquals(isHostOrSubdomain("x.com.evil.test", "x.com"), false);
  assertEquals(isHostOrSubdomain("", "x.com"), false);
});

Deno.test("url - the isSite predicates agree on unparseable input", () => {
  for (const garbage of ["", "notaurl", "--config-location=/tmp/x"]) {
    assertEquals(isSiteXDotCom(garbage), false, `on ${garbage}`);
    assertEquals(isSiteIwaraDotTv(garbage), false, `on ${garbage}`);
    assertEquals(isSiteYouTube(garbage), false, `on ${garbage}`);
    assertEquals(hasEphemeralThumbnails(garbage), false, `on ${garbage}`);
  }
});

Deno.test("url - isSiteXDotCom detects x.com and subdomains", () => {
  assertEquals(isSiteXDotCom("https://x.com/status/123"), true);
  assertEquals(isSiteXDotCom("https://sub.x.com/post"), true);
  assertEquals(isSiteXDotCom("https://not-x.com"), false);
});

Deno.test("url - isSiteYouTube covers every host yt-dlp answers to", () => {
  assertEquals(isSiteYouTube("https://www.youtube.com/watch?v=1"), true);
  assertEquals(isSiteYouTube("https://m.youtube.com/watch?v=1"), true);
  assertEquals(isSiteYouTube("https://music.youtube.com/watch?v=1"), true);
  assertEquals(isSiteYouTube("https://youtu.be/abc"), true);
  assertEquals(isSiteYouTube("https://notyoutube.com/watch?v=1"), false);
});

Deno.test("url - isSiteIwaraDotTv detects iwara.tv and subdomains", () => {
  assertEquals(isSiteIwaraDotTv("https://iwara.tv/video/abc"), true);
  assertEquals(isSiteIwaraDotTv("https://www.iwara.tv/video/abc"), true);
  assertEquals(isSiteIwaraDotTv("https://eviliwara.tv/video/abc"), false);
});

Deno.test("url - hasEphemeralThumbnails identifies transient media sites", () => {
  assertEquals(hasEphemeralThumbnails("https://facebook.com/watch"), true);
  assertEquals(hasEphemeralThumbnails("https://www.instagram.com/p/123"), true);
  assertEquals(hasEphemeralThumbnails("https://pornhub.com/x"), true);
  assertEquals(hasEphemeralThumbnails("https://youtube.com/watch"), false);
});

// --- normalizeUrl: the generic steps ---------------------------------------

Deno.test("url - normalizeUrl forces https and trims trailing slashes", () => {
  assertEquals(
    normalizeUrl("http://example.com/some/path/"),
    "https://example.com/some/path",
  );
  // The root path keeps its slash; there is nothing to trim.
  assertEquals(normalizeUrl("http://example.com/"), "https://example.com/");
});

Deno.test("url - normalizeUrl strips the tracking parameters it documents", () => {
  // Q3: the docstring promised this step for as long as the registry has
  // existed and the implementation went 1 -> 2 -> 4. Since the output is the
  // videoUrl primary key, every share link with a different ?si= became its
  // own row on any site without a rule below.
  assertEquals(
    normalizeUrl(
      "https://example.com/v?utm_source=news&utm_medium=social&fbclid=abc&si=xyz&pp=1&keep=me",
    ),
    "https://example.com/v?keep=me",
  );
  // Case-insensitive, and a URL with nothing but tracking loses its query.
  assertEquals(
    normalizeUrl("https://example.com/v?UTM_Source=news&FBCLID=abc"),
    "https://example.com/v",
  );
  // Parameters that merely look similar are not tracking and stay.
  assertEquals(
    normalizeUrl("https://example.com/v?site=1&pp_id=2&ppid=3"),
    "https://example.com/v?site=1&pp_id=2&ppid=3",
  );
});

Deno.test("url - normalizeUrl hands unparseable input straight back", () => {
  // The C1 payloads reach yt-dlp's argv only if something upstream lets them
  // through; normalizeUrl is not that gate and never was. Pinned so the
  // schema boundary stays the thing that rejects them.
  assertEquals(normalizeUrl("notaurl"), "notaurl");
  assertEquals(
    normalizeUrl("--config-location=/tmp/x"),
    "--config-location=/tmp/x",
  );
});

// --- normalizeUrl: the site registry ---------------------------------------

Deno.test("url - normalizeUrl reduces every YouTube video form to one", () => {
  const canonical = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const forms = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s&list=abc",
    "https://youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=sharetoken",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ];
  for (const form of forms) {
    assertEquals(normalizeUrl(form), canonical, `on ${form}`);
  }
});

Deno.test("url - normalizeUrl appends /videos to YouTube channel handles", () => {
  assertEquals(
    normalizeUrl("https://www.youtube.com/@some_creator"),
    "https://www.youtube.com/@some_creator/videos",
  );
});

Deno.test("url - normalizeUrl applies the per-site rules", () => {
  const cases: [string, string][] = [
    // iwara: the trailing title slug is decoration.
    [
      "https://iwara.tv/video/12345/some-title-slug",
      "https://iwara.tv/video/12345",
    ],
    // spankbang: same, one segment over.
    [
      "https://spankbang.com/abcde/video/some-slug",
      "https://spankbang.com/abcde/video",
    ],
    // pornhub: the viewkey is the whole identity.
    [
      "https://www.pornhub.com/view_video.php?viewkey=ph12345&other=garbage",
      "https://www.pornhub.com/view_video.php?viewkey=ph12345",
    ],
    // xhamster: the path identifies the video, the query never does.
    [
      "https://xhamster.com/videos/some-title-9876543?from=search",
      "https://xhamster.com/videos/some-title-9876543",
    ],
  ];
  for (const [input, expected] of cases) {
    assertEquals(normalizeUrl(input), expected, `on ${input}`);
  }
});

Deno.test("url - normalizeUrl strips the x.com share parameters", () => {
  // Q2's headline divergence: dedup.ts *appended* ?s=20 here, so its canonical
  // x.com form was one the ingest path would never write. Stripping is the
  // direction where the two paths meet.
  assertEquals(
    normalizeUrl("https://x.com/user/status/123?s=20&t=AbCdEf"),
    "https://x.com/user/status/123",
  );
  assertEquals(
    normalizeUrl("https://twitter.com/user/status/123?s=46"),
    "https://twitter.com/user/status/123",
  );
  assertEquals(
    normalizeUrl("https://x.com/user/status/123"),
    "https://x.com/user/status/123",
  );
});

Deno.test("url - normalizeUrl is idempotent on every site it handles", () => {
  // The property the dedup path actually needs: re-canonicalizing a stored
  // videoUrl has to be a no-op, or /dedup rewrites rows forever. The ?s=20
  // append violated exactly this.
  const inputs = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/@some_creator",
    "https://iwara.tv/video/12345/some-title-slug",
    "https://spankbang.com/abcde/video/some-slug",
    "https://www.pornhub.com/view_video.php?viewkey=ph12345&x=1",
    "https://xhamster.com/videos/some-title-9876543?from=search",
    "https://x.com/user/status/123?s=20",
    "http://example.com/some/path/?utm_source=news",
  ];
  for (const input of inputs) {
    const once = normalizeUrl(input);
    assertEquals(normalizeUrl(once), once, `not idempotent on ${input}`);
  }
});

// --- canonicalizePlaylistUrl -----------------------------------------------

Deno.test("url - canonicalizePlaylistUrl standardizes playlists", () => {
  assertEquals(
    canonicalizePlaylistUrl(
      "https://www.youtube.com/playlist?list=PL123&index=4",
    ),
    "https://www.youtube.com/playlist?list=PL123",
  );
  assertEquals(
    canonicalizePlaylistUrl("https://iwara.tv/playlist/123?sort=date&page=2"),
    "https://iwara.tv/playlist/123",
  );
  assertEquals(
    canonicalizePlaylistUrl("https://spankbang.com/abc-nohrcs/playlist"),
    "https://spankbang.com/abc/playlist",
  );
  assertEquals(
    canonicalizePlaylistUrl(
      "https://xhamster.com/creators/somebody/videos/1",
    ),
    "https://xhamster.com/creators/somebody",
  );
});

Deno.test("url - canonicalizePlaylistUrl keeps the list, not the video", () => {
  // The reason this is not just normalizeUrl: on a watch URL carrying a list=,
  // the playlist's identity is the parameter that normalizeUrl throws away.
  assertEquals(
    canonicalizePlaylistUrl(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
    ),
    "https://www.youtube.com/playlist?list=PL123",
  );
  assertEquals(
    normalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

Deno.test("url - canonicalizePlaylistUrl shares the generic steps", () => {
  assertEquals(
    canonicalizePlaylistUrl("http://example.com/list/1/?utm_source=news"),
    "https://example.com/list/1",
  );
  assertEquals(
    canonicalizePlaylistUrl("https://x.com/someone/media?s=20"),
    "https://x.com/someone/media",
  );
  assertEquals(canonicalizePlaylistUrl("notaurl"), "notaurl");
});
