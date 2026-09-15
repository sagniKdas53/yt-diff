import type { HttpRequestLike, HttpResponseLike } from "../transport/http.ts";

export type RouteRunner = (
  req: HttpRequestLike,
  res: HttpResponseLike,
) => unknown;

export interface RouteDefinition {
  method: string;
  path: string;
  run: RouteRunner;
}

export function dispatchRoute(
  req: HttpRequestLike,
  res: HttpResponseLike,
  routes: RouteDefinition[],
): boolean {
  const route = routes.find((candidate) =>
    candidate.method === req.method && candidate.path === req.url
  );

  if (!route) {
    return false;
  }

  void route.run(req, res);
  return true;
}

/**
 * Whether a path belongs to the API rather than the static asset tree.
 *
 * The two used to be told apart by method — GET meant an asset, POST meant the
 * API — which is not a distinction between concerns at all. A GET to `/getplay`
 * fell through to the asset table, missed, and came back as a 404 with an HTML
 * body; there was no way to add a GET endpoint without going through the asset
 * path; and neither side could be given a header policy of its own, because
 * the branch that separated them was about the verb.
 *
 * Deciding on the path instead means each side owns its own responses. The
 * route table is the authority for what an API path is, so this stays in step
 * with `API_ENDPOINTS` on its own.
 */
export function isApiPath(
  url: string | undefined,
  routes: RouteDefinition[],
): boolean {
  if (!url) {
    return false;
  }
  // Query strings never identify an endpoint here, and the table is keyed on
  // the path alone — the same reason `serveStaticAsset` strips one.
  const at = url.indexOf("?");
  const path = at === -1 ? url : url.slice(0, at);
  return routes.some((candidate) => candidate.path === path);
}

/**
 * The methods an API path accepts, for the `Allow` header on a 405.
 *
 * Every endpoint is POST today, but reading it off the table rather than
 * hardcoding it means a future GET endpoint is announced correctly without
 * anyone remembering to come back here.
 */
export function allowedMethodsFor(
  url: string | undefined,
  routes: RouteDefinition[],
): string[] {
  if (!url) {
    return [];
  }
  const at = url.indexOf("?");
  const path = at === -1 ? url : url.slice(0, at);
  return [
    ...new Set(
      routes
        .filter((candidate) => candidate.path === path)
        .map((candidate) => candidate.method),
    ),
  ];
}
