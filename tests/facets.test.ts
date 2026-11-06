import { assertEquals } from "std/assert/mod.ts";
import { deriveFacets } from "../src/handlers/filing/facets.ts";

Deno.test("facets - www., m. and bare hosts are one site", () => {
  for (
    const url of [
      "https://www.a.example/v",
      "https://m.a.example/v",
      "https://a.example/v",
      "https://A.Example/v",
    ]
  ) {
    assertEquals(deriveFacets(null, url).site, "a.example");
  }
});

Deno.test("facets - extractor_key changes siteName and never site", () => {
  const facets = deriveFacets(
    { extractor_key: "Fancy" },
    "https://www.a.example/v",
  );
  assertEquals(facets.site, "a.example");
  assertEquals(facets.siteName, "Fancy");
  assertEquals(deriveFacets({}, "https://a.example/v").siteName, "a.example");
});

Deno.test("facets - channel_id wins over a differing uploader_id", () => {
  const facets = deriveFacets(
    { channel_id: "UC123", uploader_id: "@Someone" },
    "https://a.example/v",
  );
  assertEquals(facets.channelKey, "a.example:uc123");
  assertEquals(facets.channelHandle, "someone");
});

Deno.test("facets - id order falls through uploader_id, uploader_url, uploader, channel", () => {
  const url = "https://a.example/v";
  assertEquals(
    deriveFacets({ uploader_id: "U", uploader_url: "x", uploader: "y" }, url)
      .channelKey,
    "a.example:u",
  );
  assertEquals(
    deriveFacets({ uploader_url: "https://a.example/u/X", uploader: "y" }, url)
      .channelKey,
    "a.example:https://a.example/u/x",
  );
  assertEquals(
    deriveFacets({ uploader: "Y", channel: "z" }, url).channelKey,
    "a.example:y",
  );
  assertEquals(
    deriveFacets({ channel: "Z" }, url).channelKey,
    "a.example:z",
  );
});

Deno.test("facets - @Name and name give the same key and handle", () => {
  const a = deriveFacets({ uploader_id: "@Name" }, "https://a.example/v");
  const b = deriveFacets({ uploader_id: "name" }, "https://a.example/v");
  assertEquals(a.channelKey, b.channelKey);
  assertEquals(a.channelHandle, "name");
  assertEquals(b.channelHandle, "name");
});

Deno.test("facets - the same id on two sites is two keys", () => {
  const a = deriveFacets({ uploader_id: "same" }, "https://a.example/v");
  const b = deriveFacets({ uploader_id: "same" }, "https://b.example/v");
  assertEquals(a.channelKey === b.channelKey, false);
});

Deno.test("facets - names and urls come from the documented fields", () => {
  const facets = deriveFacets(
    {
      channel: "Chan",
      uploader: "Upl",
      channel_url: "https://a.example/c",
      uploader_url: "https://a.example/u",
      uploader_id: "@Id",
    },
    "https://a.example/v",
  );
  assertEquals(facets.channelName, "Chan");
  assertEquals(facets.channelUrl, "https://a.example/c");

  const fallback = deriveFacets(
    { uploader_url: "https://a.example/u", uploader_id: "@Id" },
    "https://a.example/v",
  );
  assertEquals(fallback.channelName, "@Id");
  assertEquals(fallback.channelUrl, "https://a.example/u");
});

Deno.test("facets - null raw gives a site from the URL and nothing else", () => {
  assertEquals(deriveFacets(null, "https://www.a.example/v"), {
    site: "a.example",
    siteName: "a.example",
    channelKey: null,
    channelName: null,
    channelUrl: null,
    channelHandle: null,
    uploadDate: null,
    durationSeconds: null,
  });
});

Deno.test("facets - NA, empty and whitespace count as missing", () => {
  const facets = deriveFacets(
    {
      channel_id: "NA",
      uploader_id: "   ",
      uploader_url: "",
      uploader: "NA",
      channel: " NA ",
      extractor_key: "NA",
    },
    "https://a.example/v",
  );
  assertEquals(facets.channelKey, null);
  assertEquals(facets.channelName, null);
  assertEquals(facets.siteName, "a.example");
});

Deno.test("facets - long strings truncate and the key leaves room for auto:", () => {
  const long = "x".repeat(400);
  const facets = deriveFacets(
    { channel_id: long, channel: long, channel_url: long },
    "https://a.example/v",
  );
  assertEquals(facets.channelName?.length, 255);
  assertEquals(facets.channelUrl?.length, 255);
  assertEquals((facets.channelKey ?? "").length <= 250, true);
});

Deno.test("facets - upload_date becomes YYYY-MM-DD, a bad one becomes null", () => {
  const url = "https://a.example/v";
  assertEquals(
    deriveFacets({ upload_date: "20240229" }, url).uploadDate,
    "2024-02-29",
  );
  for (
    const bad of ["20240230", "2024-02-29", "abc", "20241301", "", 20240229]
  ) {
    assertEquals(deriveFacets({ upload_date: bad }, url).uploadDate, null);
  }
});

Deno.test("facets - duration must be a positive number", () => {
  const url = "https://a.example/v";
  assertEquals(deriveFacets({ duration: 119.9 }, url).durationSeconds, 119.9);
  for (const bad of ["abc", 0, -5, null, NaN, Infinity]) {
    assertEquals(deriveFacets({ duration: bad }, url).durationSeconds, null);
  }
});
