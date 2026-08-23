/**
 * Emits both contract artifacts:
 *
 *   - `openapi.json` at the repo root — the human- and tool-readable API
 *     document.
 *   - `frontend/src/api/generated/apiTypes.js` — JSDoc typedefs consumed
 *     through `checkJs` by the frontend's typed client.
 *
 * Run via `deno task gen:api`. Both files are committed; the contract test
 * (`tests/api_contract.test.ts`) regenerates them in memory and fails if
 * either would change, so they cannot drift from `endpoints.ts` silently.
 */

// The endpoint table pulls in `config.ts`, which fails closed on missing
// secrets at import time. Codegen only reads zod schemas — none of which
// touch configuration — so stand-ins are planted before the import rather
// than asking every contributor to export real credentials to regenerate
// documentation.
Deno.env.set("SECRET_KEY", "codegen-stand-in");
Deno.env.set("DB_PASSWORD", "codegen-stand-in");

const { buildOpenApiDocument, emitFrontendTypes } = await import(
  "../src/routes/openapi.ts"
);

const document = JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";
const frontendTypes = emitFrontendTypes();

await Deno.writeTextFile("openapi.json", document);
await Deno.writeTextFile(
  "frontend/src/api/generated/apiTypes.js",
  frontendTypes,
);

console.log(
  "Wrote openapi.json (%d bytes) and frontend/src/api/generated/apiTypes.js (%d bytes)",
  document.length,
  frontendTypes.length,
);
