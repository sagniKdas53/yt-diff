import { assertEquals } from "std/assert/mod.ts";
import { Op } from "sequelize";
import { VideoMetadata } from "../src/db/models.ts";
import { listOrder, rowsBefore } from "../src/handlers/playlists/order.ts";

Deno.test("playlist order - Unlisted is newest first, with the id breaking ties", () => {
  assertEquals(listOrder("None", false), [
    ["positionInPlaylist", "DESC"],
    ["id", "DESC"],
  ]);
});

Deno.test("playlist order - Unlisted downloaded-first keeps newest first inside each group", () => {
  assertEquals(listOrder("None", true), [
    [VideoMetadata, "downloadStatus", "DESC"],
    ["positionInPlaylist", "DESC"],
    ["id", "DESC"],
  ]);
});

Deno.test("playlist order - a real playlist is unchanged", () => {
  assertEquals(listOrder("https://x", false), [
    ["positionInPlaylist", "ASC"],
    ["id", "ASC"],
  ]);
  assertEquals(listOrder("https://x", true), [
    [VideoMetadata, "downloadStatus", "DESC"],
    ["positionInPlaylist", "ASC"],
    ["id", "ASC"],
  ]);
});

Deno.test("playlist order - rows before a mapping flip with the order", () => {
  assertEquals(rowsBefore("None", 5, "m"), {
    playlistUrl: "None",
    [Op.or]: [
      { positionInPlaylist: { [Op.gt]: 5 } },
      { positionInPlaylist: 5, id: { [Op.gt]: "m" } },
    ],
  });
  assertEquals(rowsBefore("https://x", 5, "m"), {
    playlistUrl: "https://x",
    [Op.or]: [
      { positionInPlaylist: { [Op.lt]: 5 } },
      { positionInPlaylist: 5, id: { [Op.lt]: "m" } },
    ],
  });
});
