import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteRunner = (
  req: IncomingMessage,
  res: ServerResponse,
) => unknown;

export interface RouteDefinition {
  method: string;
  path: string;
  run: RouteRunner;
}

export function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
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
