import { assertEquals, assertExists } from "std/assert/mod.ts";
import { API_ENDPOINTS } from "../src/routes/endpoints.ts";
import {
  buildOpenApiDocument,
  emitFrontendTypes,
  ResponseSchemas,
  SubListVideoRowSchema,
} from "../src/routes/openapi.ts";

/**
 * The contract is only as good as its ability to notice drift. These tests
 * regenerate both generated artifacts in memory and compare them against
 * what is committed, so editing a schema or an endpoint record without
 * re-running `deno task gen:api` fails here first — before a consumer ever
 * sees a shape the types do not describe.
 */

const COMMITTED_OPENAPI = "openapi.json";
const COMMITTED_FRONTEND_TYPES = "frontend/src/api/generated/apiTypes.js";

Deno.test("every endpoint documents a response body", () => {
  for (const endpoint of API_ENDPOINTS) {
    assertExists(
      ResponseSchemas[endpoint.path],
      `${endpoint.path} has no response schema in src/routes/openapi.ts`,
    );
  }
});

Deno.test("only /refresh may omit a request schema", () => {
  for (const endpoint of API_ENDPOINTS) {
    if (endpoint.kind === "authenticated") {
      if (!endpoint.schema && endpoint.path !== "/refresh") {
        throw new Error(
          `${endpoint.path} has no request schema and no documented reason`,
        );
      }
    }
  }
});

Deno.test("the OpenAPI document covers exactly the endpoint table", () => {
  const document = buildOpenApiDocument();
  const paths = Object.keys(document.paths as Record<string, unknown>);
  const expected = API_ENDPOINTS.map((endpoint) => endpoint.path).sort();
  assertEquals([...paths].sort(), expected);
});

Deno.test("committed openapi.json matches the generated document", async () => {
  const committed = await Deno.readTextFile(COMMITTED_OPENAPI);
  assertEquals(
    JSON.stringify(buildOpenApiDocument(), null, 2) + "\n",
    committed,
  );
});

Deno.test("committed frontend apiTypes.js match the generated module", async () => {
  let committed: string;
  try {
    committed = await Deno.readTextFile(COMMITTED_FRONTEND_TYPES);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    // The frontend submodule is absent from some checkouts — CI's unit-test
    // job among them when its recorded pointer predates the generated file.
    // The artifact is derived purely from backend code, so nothing here can
    // be out of sync with it; the comparison still runs anywhere the tree
    // exists, and the CI checkout enables it explicitly.
    console.warn(
      `${COMMITTED_FRONTEND_TYPES} not found (frontend submodule not checked out); skipping`,
    );
    return;
  }
  assertEquals(emitFrontendTypes(), committed);
});

Deno.test("/getsub response schema accepts the rows the handler emits", () => {
  // The shape queries.ts builds by hand — the association name that reached
  // JSX undocumented is now pinned on both sides of the network boundary.
  const result = SubListVideoRowSchema.safeParse({
    id: "0c6f7bd8-9b62-4a5e-8d17-2f0e5b1a3c44",
    positionInPlaylist: 3,
    playlistUrl: "https://example.com/playlist?list=1",
    video_metadatum: {
      title: "A video",
      videoId: "abc123",
      videoUrl: "https://example.com/watch?v=abc123",
      downloadStatus: true,
      isAvailable: true,
      fileName: "abc123.mp4",
      thumbNailFile: null,
      onlineThumbnail: null,
      subTitleFile: null,
      descriptionFile: null,
      isMetaDataSynced: false,
      saveDirectory: "Some Playlist",
    },
  });
  assertEquals(result.success, true);
});
