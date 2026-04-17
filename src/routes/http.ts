import type {
  HttpRequestLike,
  HttpResponseLike,
} from "../transport/http.ts";

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
