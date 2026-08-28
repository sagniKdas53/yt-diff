import { z } from "zod";

import { API_ENDPOINTS } from "./endpoints.ts";
import {
  IsRegistrationAllowedSchema,
  UserAuthSchema,
} from "../middleware/validator.ts";

/**
 * The response half of the API contract.
 *
 * The request half lives in the endpoint records (`endpoints.ts`, one zod
 * schema per route, applied before every handler). Until now the response
 * half existed nowhere at all — every handler built its body inline, and the
 * types stopped dead at the network boundary, which is how a Sequelize
 * association name reached the frontend as an undocumented field name.
 *
 * One schema per success body here, keyed by path. They are documentation
 * that can be checked: `tests/api_codegen.test.ts` pins both generated
 * artifacts against this module, so a handler whose shape drifts from its
 * entry here is caught when the artifacts are regenerated.
 *
 * Error bodies are deliberately not enumerated per route. A refused request
 * answers either `{status: "error", message}` or `{error}`, depending on
 * which of the two response eras wrote the handler, and the frontend client
 * already reads both — see `ApiError` in `frontend/src/api/client.js`.
 */

const ListingItemSchema = z.object({
  url: z.string(),
  type: z.string(),
  currentMonitoringType: z.string().optional(),
  previousMonitoringType: z.string().optional(),
  reason: z.string(),
});

/** What `/getsub` rows carry: the mapping, plus the video behind it. */
export const SubListVideoRowSchema = z.object({
  id: z.string(),
  positionInPlaylist: z.number(),
  playlistUrl: z.string(),
  video_metadatum: z.object({
    title: z.string().optional(),
    videoId: z.string().optional(),
    videoUrl: z.string().optional(),
    downloadStatus: z.boolean().optional(),
    isAvailable: z.boolean().optional(),
    fileName: z.string().nullable().optional(),
    thumbNailFile: z.string().nullable().optional(),
    onlineThumbnail: z.string().nullable().optional(),
    subTitleFile: z.string().nullable().optional(),
    descriptionFile: z.string().nullable().optional(),
    isMetaDataSynced: z.boolean().optional(),
    saveDirectory: z.string().nullable().optional(),
  }),
});

export const PlaylistDisplayRowSchema = z.object({
  id: z.number(),
  playlistUrl: z.string(),
  title: z.string(),
  monitoringType: z.string(),
  sortOrder: z.number(),
  saveDirectory: z.string().nullable().optional(),
  lastUpdatedByScheduler: z.union([z.string(), z.null()]).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const QueueEntrySchema = z.object({
  url: z.string(),
  title: z.string(),
  status: z.string(),
  queuePosition: z.number(),
});

const TokenResponseSchema = z.object({
  status: z.literal("success"),
  token: z.string(),
  expiresAt: z.number(),
});

const BulkFilesResponseSchema = z.object({
  status: z.literal("success"),
  files: z.record(
    z.string(),
    z.object({
      signedUrlId: z.string().optional(),
      expiry: z.number().optional(),
    }).nullable(),
  ),
});

/**
 * Request bodies for the endpoints whose record carries no schema.
 *
 * The three public handlers read the raw request because they run before
 * authentication, and `/refresh` reads only the verified identity — so no
 * zod schema sits in any of their endpoint records. Their bodies are still
 * part of the contract, so they are named here.
 *
 * `/refresh` takes an empty object rather than nothing at all: the server's
 * `parseRequestJson` refuses a request with no body before the handler runs,
 * so a client that posted literally nothing would get a 400. Describing it as
 * bodyless was the one place the generated contract disagreed with the
 * running server, and it typed the correct call — `post("/refresh", {})` —
 * as the error.
 */
export const UnrecordedRequestSchemas: Record<string, z.ZodType | undefined> = {
  "/login": UserAuthSchema,
  "/register": UserAuthSchema,
  "/isregallowed": IsRegistrationAllowedSchema,
  "/refresh": z.object({}),
};

/**
 * The request schema for one endpoint, wherever it is declared.
 *
 * Most endpoints carry theirs in the record, because the router applies it
 * before the handler. The rest are in `UnrecordedRequestSchemas`. Both
 * generators resolve through here so the OpenAPI document and the frontend
 * typedefs cannot disagree about which routes take a body.
 */
function requestSchemaFor(
  endpoint: typeof API_ENDPOINTS[number],
): z.ZodType | undefined {
  const recorded = "schema" in endpoint ? endpoint.schema : undefined;
  return recorded ?? UnrecordedRequestSchemas[endpoint.path];
}

export const ResponseSchemas: Record<string, z.ZodType> = {
  "/list": z.object({
    status: z.literal("success"),
    message: z.literal("Listing initiated"),
    items: z.array(ListingItemSchema),
    queueDepthBefore: z.number(),
  }),
  "/download": z.object({
    status: z.literal("success"),
    message: z.literal("Downloads initiated"),
    items: z.array(z.object({
      url: z.string(),
      title: z.string(),
      saveDirectory: z.string(),
      videoId: z.string(),
    })),
  }),
  "/watch": z.object({
    status: z.literal("success"),
    message: z.string(),
  }),
  "/getplay": z.object({
    count: z.number(),
    rows: z.array(PlaylistDisplayRowSchema),
  }),
  "/delplay": z.object({
    status: z.literal("success"),
    message: z.string(),
    cleanUp: z.boolean(),
    deletePlaylist: z.boolean(),
    deleteAllVideosInPlaylist: z.boolean(),
  }),
  "/getsub": z.object({
    count: z.number(),
    rows: z.array(SubListVideoRowSchema),
    saveDirectory: z.string(),
    playlistTitle: z.string().nullable(),
  }),
  "/delsub": z.object({
    message: z.string(),
    deleted: z.array(z.string()),
    failed: z.array(z.string()),
    cleanUp: z.boolean(),
    deleteVideoMappings: z.boolean(),
    deleteVideosInDB: z.boolean(),
  }),
  "/getfile": z.object({
    status: z.literal("success"),
    signedUrlId: z.string(),
    expiry: z.number(),
  }),
  "/refreshfile": z.object({
    status: z.literal("success"),
    expiry: z.number(),
  }),
  "/refreshfiles": BulkFilesResponseSchema,
  "/getfiles": BulkFilesResponseSchema,
  "/reindexall": z.object({
    status: z.literal("success"),
    message: z.string(),
    queued: z.number(),
    total: z.number(),
    start: z.number().optional(),
    stop: z.number().optional(),
    siteFilter: z.string().optional(),
    chunkSize: z.number().optional(),
    batchId: z.string().nullable().optional(),
  }),
  "/dedup-unlisted": z.object({
    status: z.literal("success"),
    dryRun: z.boolean().optional(),
    siteFilter: z.string().optional(),
    videoDuplicatesFound: z.number(),
    videoMergedCount: z.number(),
    videoDetails: z.array(z.record(z.string(), z.unknown())),
    playlistDuplicatesFound: z.number().optional(),
    playlistMergedCount: z.number().optional(),
    playlistDetails: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  "/dedup-playlists": z.object({
    status: z.literal("success"),
    dryRun: z.boolean().optional(),
    siteFilter: z.string().optional(),
    videoDuplicatesFound: z.number().optional(),
    videoMergedCount: z.number().optional(),
    videoDetails: z.array(z.record(z.string(), z.unknown())).optional(),
    playlistDuplicatesFound: z.number(),
    playlistMergedCount: z.number(),
    playlistDetails: z.array(z.record(z.string(), z.unknown())),
  }),
  "/queuestatus": z.object({
    status: z.literal("success"),
    generation: z.union([z.string(), z.number()]),
    queue: z.array(QueueEntrySchema),
  }),
  "/refresh": TokenResponseSchema,
  "/login": TokenResponseSchema,
  "/register": z.object({
    status: z.literal("success"),
    message: z.string(),
  }),
  "/isregallowed": z.object({
    registrationAllowed: z.boolean(),
    currentUsers: z.number().optional(),
    maxUsers: z.number().optional(),
  }),
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  // `io: "input"` describes what a caller must send, which is the contract
  // worth documenting: HttpUrlSchema parses scheme-less input into a URL,
  // and both sides of that transform are strings anyway.
  return z.toJSONSchema(schema, { io: "input", reused: "inline" }) as Record<
    string,
    unknown
  >;
}

/** Status each endpoint answers with on success. */
function successStatus(path: string): number {
  return path === "/register" ? 201 : 200;
}

/**
 * Builds the OpenAPI document for the whole HTTP surface.
 *
 * Every path comes from `API_ENDPOINTS`; nothing here names an endpoint a
 * second time except the public bodies and the response schemas above, which
 * are the parts the endpoint records never held.
 */
export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const endpoint of API_ENDPOINTS) {
    const requestSchema = requestSchemaFor(endpoint);
    const responseSchema = ResponseSchemas[endpoint.path];

    const operation: Record<string, unknown> = {
      operationId: endpoint.handler,
      summary: endpoint.summary,
      responses: {
        [String(successStatus(endpoint.path))]: {
          description: "Success",
          ...(responseSchema
            ? {
              content: {
                "application/json": { schema: jsonSchema(responseSchema) },
              },
            }
            : {}),
        },
        "4XX": {
          description:
            "Refused — invalid payload, failed admission, or dead session",
          content: {
            "application/json": {
              schema: jsonSchema(
                z.object({
                  status: z.literal("error").optional(),
                  message: z.string().optional(),
                  error: z.string().optional(),
                }),
              ),
            },
          },
        },
      },
    };

    if (requestSchema) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: jsonSchema(requestSchema) },
        },
      };
    }

    if (endpoint.kind === "authenticated") {
      operation.security = [{ bearerAuth: [] }];
    } else {
      operation.security = [];
    }

    paths[endpoint.path] = { post: operation };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "yt-diff API",
      version: "1.0.0",
      description:
        "Every HTTP endpoint the server exposes. Generated from the one" +
        " endpoint table in src/routes/endpoints.ts — regenerate with" +
        " `deno task gen:api` rather than editing by hand.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    paths,
  };
}

// ---------------------------------------------------------------------------
// Frontend type emission
//
// The generated artifact is plain JS with JSDoc typedefs, consumed through
// `checkJs` — the frontend stays JavaScript, but `post("/getsub", …)` now
// has real request and response types at the call site.
// ---------------------------------------------------------------------------

/** PascalCase type-name stem for a route path: "/dedup-unlisted" -> "DedupUnlisted". */
function typeNameStem(path: string): string {
  return path
    .replace(/^\//, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Renders one JSON Schema (as produced by `jsonSchema` above) as a
 * TypeScript type expression usable inside a JSDoc typedef.
 *
 * Deliberately small: the contract uses objects, arrays, primitives,
 * literals, unions, nullability and records, and nothing else. Unions are
 * wrapped in parentheses unconditionally so they stay correct wherever an
 * expression can be embedded (`Array<…>`, a property position).
 */
function renderTsType(schema: unknown, indent: string): string {
  if (typeof schema !== "object" || schema === null) return "unknown";
  const s = schema as Record<string, unknown>;

  if (typeof s.const === "string") return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) {
    return `(${s.enum.map((v) => JSON.stringify(v)).join(" | ")})`;
  }
  if (Array.isArray(s.anyOf)) {
    return `(${
      (s.anyOf as unknown[]).map((branch) => renderTsType(branch, indent))
        .join(" | ")
    })`;
  }
  if (typeof s.$ref === "string") return "unknown"; // reused:"inline" keeps these away

  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = renderTsType(s.items, indent);
      return `Array<${items}>`;
    }
    case "object": {
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required ?? []) as string[]);
      const entries = Object.entries(properties);

      const additional = s.additionalProperties;
      if (entries.length === 0) {
        return additional && typeof additional === "object"
          ? `{ [key: string]: ${renderTsType(additional, indent)} }`
          : "Record<string, never>";
      }

      const nested = indent + "  ";
      const lines = entries.map(([name, prop]) => {
        const opt = required.has(name) ? "" : "?";
        return `${nested}${JSON.stringify(name)}${opt}: ${
          renderTsType(prop, nested)
        },`;
      });
      const extra = additional && typeof additional === "object"
        ? [`${nested}[key: string]: ${renderTsType(additional, nested)},`]
        : [];
      return ["{", ...lines, ...extra, `${indent}}`].join("\n");
    }
    default:
      return "unknown";
  }
}

/** One `@typedef` block carrying a full type-literal expression. */
function typedef(name: string, schema: unknown): string {
  return `/**
 * @typedef {${renderTsType(schema, "")}} ${name}
 */`;
}

/** One `@typedef` naming the request/response pair shape for one route. */
function routeTypedef(
  path: string,
  hasRequest: boolean,
  hasResponse: boolean,
): string {
  const stem = typeNameStem(path);
  // `request` is present-but-optional rather than absent on bodyless routes,
  // so indexing the pair by path stays well-formed for every member of the
  // union.
  const requestPart = hasRequest
    ? `request: ${stem}Request, `
    : "request?: undefined, ";
  const responsePart = hasResponse
    ? `response: ${stem}Response`
    : `response: ({status: "error", message?: string} | Record<string, never>)`;
  return `/** @typedef {{path: "${path}", ${requestPart}${responsePart}}} ${stem}Route */`;
}

/**
 * Produces the contents of `frontend/src/api/generated/apiTypes.js`.
 *
 * Pure text generation from the same schemas `buildOpenApiDocument`
 * renders, so the OpenAPI file and the frontend types can never disagree
 * about a shape.
 */
export function emitFrontendTypes(): string {
  const header = `/**
 * GENERATED FILE — do not edit.
 *
 * Regenerate from the backend repository with \`deno task gen:api\`. The source
 * of truth is the endpoint table in \`src/routes/endpoints.ts\` plus the
 * response schemas in \`src/routes/openapi.ts\`; \`openapi.json\` at that repo's
 * root is emitted alongside this file and describes the same shapes.
 *
 * Consumed from plain JavaScript through \`checkJs\`: \`post("/getsub", body)\`
 * in \`src/api/client.js\` is typed by the route union below, so both the
 * request body and the parsed response have real types at every call site.
 */

`;

  const blocks: string[] = [];

  for (const endpoint of API_ENDPOINTS) {
    const stem = typeNameStem(endpoint.path);
    const requestSchema = requestSchemaFor(endpoint);
    const responseSchema = ResponseSchemas[endpoint.path];

    if (requestSchema) {
      blocks.push(typedef(`${stem}Request`, jsonSchema(requestSchema)));
    }
    if (responseSchema) {
      blocks.push(typedef(`${stem}Response`, jsonSchema(responseSchema)));
    }
  }

  const routes = API_ENDPOINTS.map((endpoint) =>
    routeTypedef(
      endpoint.path,
      Boolean(requestSchemaFor(endpoint)),
      Boolean(ResponseSchemas[endpoint.path]),
    )
  );

  // The union has to start on the same line as `@typedef {`. TypeScript does
  // not parse a JSDoc type expression that begins on a later line — it takes
  // the typedef as `any` and says nothing, which is what `ApiRoute` silently
  // was: every `post()` accepted every path and returned `any`, so none of
  // this typed anything. Continuation lines are fine; only the first matters.
  const routeNames = API_ENDPOINTS.map((e) => `${typeNameStem(e.path)}Route`);
  const union = routeNames[0] +
    routeNames.slice(1).map((name) => `\n *   | ${name}`).join("");

  // The trailing export marks this as an ES module, which is what lets
  // `import("./generated/apiTypes.js")` type expressions resolve under
  // checkJs despite the file carrying types only.
  return header +
    blocks.join("\n\n") +
    "\n\n" +
    routes.join("\n") +
    `\n\n/**
 * Every route, as a discriminated union on \`path\`.
 *
 * @typedef {${union}} ApiRoute
 */

export {};
`;
}
