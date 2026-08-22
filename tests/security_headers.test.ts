import { assert, assertEquals } from "std/assert/mod.ts";
import {
  APP_CSP,
  generateCorsHeaders,
  MIME_TYPES,
  SECURITY_HEADERS,
  SIGNED_FILE_CSP,
} from "../src/utils/http.ts";
import { tryServeNativeFile } from "../src/routes/helpers/serveNativeFile.ts";

const JSON_TYPE = "application/json; charset=utf-8";

Deno.test("security headers - every response carries the base set", () => {
  const headers = generateCorsHeaders(JSON_TYPE);
  assertEquals(headers["X-Content-Type-Options"], "nosniff");
  assertEquals(headers["X-Frame-Options"], "DENY");
  assertEquals(headers["Referrer-Policy"], "no-referrer");
});

Deno.test("security headers - do not displace the CORS contract", () => {
  // The security headers were added to the same builder the CORS tests cover.
  // Nothing they added may shadow a header a browser needs for CORS.
  const headers = generateCorsHeaders(JSON_TYPE, {
    allowedOrigins: ["https://a.example", "https://b.example"],
    requestOrigin: "https://b.example",
  });
  assertEquals(headers["Access-Control-Allow-Origin"], "https://b.example");
  assertEquals(headers["Vary"], "Origin");
  assertEquals(headers["Content-Type"], JSON_TYPE);
});

Deno.test("security headers - the app CSP pins script and connect to this origin", () => {
  // These are the two directives that decide whether an injected script can
  // read the bearer token out of localStorage and post it somewhere. A
  // wildcard in either makes the whole policy decorative.
  assert(APP_CSP.includes("script-src 'self'"));
  assert(!APP_CSP.includes("script-src 'self' *"));
  assert(!/connect-src[^;]*\s\*/.test(APP_CSP));
  assert(!/script-src[^;]*unsafe-(inline|eval)/.test(APP_CSP));
  assertEquals(APP_CSP.includes("frame-ancestors 'none'"), true);
  assertEquals(APP_CSP.includes("object-src 'none'"), true);
});

Deno.test("security headers - the app CSP still allows what the app needs", () => {
  // MUI injects inline <style> at runtime, and thumbnails come from whatever
  // site the video came from. Both are deliberate; assert them so a later
  // tightening pass has to notice it is breaking something.
  assert(/style-src[^;]*'unsafe-inline'/.test(APP_CSP));
  assert(/img-src[^;]*https:/.test(APP_CSP));
  // socket.io needs a ws/wss origin; 'self' alone is not matched against
  // ws: by older browsers.
  assert(/connect-src[^;]*wss?:\/\//.test(APP_CSP));
});

Deno.test("security headers - signed files get the sandbox policy, not the app one", () => {
  const headers = generateCorsHeaders("video/mp4", { csp: SIGNED_FILE_CSP });
  assertEquals(headers["Content-Security-Policy"], SIGNED_FILE_CSP);
  assert(SIGNED_FILE_CSP.includes("sandbox"));
  assert(SIGNED_FILE_CSP.includes("default-src 'none'"));
  // The default stays the app policy for every other call site.
  assertEquals(
    generateCorsHeaders(JSON_TYPE)["Content-Security-Policy"],
    APP_CSP,
  );
});

Deno.test("security headers - SECURITY_HEADERS is what generateCorsHeaders spreads", () => {
  const headers = generateCorsHeaders(JSON_TYPE);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assertEquals(headers[name as keyof typeof headers], value);
  }
});

function corsFor(contentType: string) {
  return generateCorsHeaders(contentType, { csp: SIGNED_FILE_CSP });
}

async function serve(
  fileName: string,
  mimeType: string,
  inline: boolean,
): Promise<Response> {
  const dir = await Deno.makeTempDir();
  const filePath = `${dir}/${fileName}`;
  await Deno.writeTextFile(
    filePath,
    "<svg xmlns='http://www.w3.org/2000/svg'/>",
  );
  try {
    const response = await tryServeNativeFile(
      new Request("http://localhost/ytdiff/file?fileId=x&inline=true"),
      { filePath, mimeType, inline },
      corsFor,
    );
    assert(response !== null);
    // Drain so the open file handle does not leak into the next test.
    await response.arrayBuffer();
    return response;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("signed files - a planted .svg is never rendered inline", async () => {
  // The finding: yt-dlp writes what a remote site handed it, MIME_TYPES maps
  // .svg onto image/svg+xml, and an SVG rendered as a document on this origin
  // can read localStorage. Asking for inline must not get it.
  assertEquals(MIME_TYPES[".svg"], "image/svg+xml");
  const response = await serve("planted.svg", "image/svg+xml", true);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  assert(disposition.startsWith("attachment"), disposition);
  assertEquals(
    response.headers.get("Content-Security-Policy"),
    SIGNED_FILE_CSP,
  );
});

Deno.test("signed files - html and xml are refused inline too", async () => {
  for (
    const [name, type] of [
      ["planted.html", "text/html; charset=utf-8"],
      ["planted.xml", "application/xml"],
      ["planted.xhtml", "application/xhtml+xml"],
    ]
  ) {
    const response = await serve(name, type, true);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    assert(disposition.startsWith("attachment"), `${type}: ${disposition}`);
  }
});

Deno.test("signed files - video and audio still play inline", async () => {
  // The whole point of inline=true. Breaking this to fix the SVG case would
  // trade a conditional exploit for a broken player.
  for (
    const [name, type] of [
      ["clip.mp4", "video/mp4"],
      ["song.m4a", "audio/mp4"],
      ["thumb.jpg", "image/jpeg"],
    ]
  ) {
    const response = await serve(name, type, true);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    assert(disposition.startsWith("inline"), `${type}: ${disposition}`);
  }
});

Deno.test("signed files - inline=false stays an attachment", async () => {
  const response = await serve("clip.mp4", "video/mp4", false);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  assert(disposition.startsWith("attachment"), disposition);
});
