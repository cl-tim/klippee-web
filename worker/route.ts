import { readDb, writeDb } from "./db";
import { json } from "./http";
import { RepositoryRepository } from "./repositories/RepositoryRepository";
import { requireUser } from "./routes/auth";
import type { D1Client, Env, RepositoryRow, UserRow } from "./types";

export type RouteParams = Record<string, string>;

export type RouteHandler = (
  request: Request,
  env: Env,
  params: RouteParams,
  url: URL,
) => Promise<Response> | Response;

export type Route = {
  method: string | string[];
  pattern: string;
  handler: RouteHandler;
};

/**
 * Matches `pattern` (e.g. "/api/repos/:id/versions" or "/api/cad/*") against
 * `pathname`. Path segments starting with ":" become named params; a trailing
 * "*" captures the remainder into `params.rest` (slash-separated).
 *
 * Returns the param map on match, or null when the path doesn't match.
 */
export function matchRoute(pattern: string, pathname: string): RouteParams | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  const isWildcard = patternParts.length > 0 && patternParts[patternParts.length - 1] === "*";

  if (isWildcard) {
    if (pathParts.length < patternParts.length - 1) {
      return null;
    }
  } else if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: RouteParams = {};
  const fixedLength = isWildcard ? patternParts.length - 1 : patternParts.length;

  for (let index = 0; index < fixedLength; index += 1) {
    const part = patternParts[index];
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(pathParts[index]);
    } else if (part !== pathParts[index]) {
      return null;
    }
  }

  if (isWildcard) {
    params.rest = pathParts
      .slice(fixedLength)
      .map((part) => decodeURIComponent(part))
      .join("/");
  }

  return params;
}

export type RouteDispatchResult =
  | { handler: RouteHandler; params: RouteParams }
  | { methodMismatch: string[] };

/**
 * Finds the first route whose pattern and method both match. When at least one
 * pattern matches but no method does, returns `{ methodMismatch }` listing the
 * methods those routes accept so the caller can answer 405 with an Allow
 * header instead of a misleading 404.
 */
export function dispatchRoute(
  routes: Route[],
  request: Request,
  url: URL,
): RouteDispatchResult | null {
  const mismatchedMethods: string[] = [];
  for (const route of routes) {
    const params = matchRoute(route.pattern, url.pathname);
    if (!params) {
      continue;
    }
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.includes(request.method)) {
      return { handler: route.handler, params };
    }
    for (const method of methods) {
      if (!mismatchedMethods.includes(method)) {
        mismatchedMethods.push(method);
      }
    }
  }
  return mismatchedMethods.length > 0 ? { methodMismatch: mismatchedMethods } : null;
}

export type AuthenticatedRouteHandler = (
  request: Request,
  env: Env,
  user: UserRow,
  params: RouteParams,
  url: URL,
) => Promise<Response> | Response;

/**
 * Wraps a handler with the session-user guard so route modules do not repeat
 * the `requireUser` prologue. The wrapped handler only runs for an
 * authenticated user; unauthenticated requests get the canonical 401.
 */
export function withUser(handler: AuthenticatedRouteHandler): RouteHandler {
  return async (request, env, params, url) => {
    const { response, user } = await requireUser(request, env);
    if (response) {
      return response;
    }
    return handler(request, env, user, params, url);
  };
}

export type OwnedRepositoryContext = {
  db: D1Client;
  repo: RepositoryRow;
  user: UserRow;
};

export type OwnedRepositoryRouteHandler = (
  request: Request,
  env: Env,
  context: OwnedRepositoryContext,
  params: RouteParams,
  url: URL,
) => Promise<Response> | Response;

/**
 * Wraps a handler for routes shaped like `/api/repos/:id/...`: requires a
 * session user, resolves `params.id` against that user's repositories on the
 * requested D1 session, and returns the canonical 404 when the repository is
 * missing or owned by someone else. The resolved `db` session is shared with
 * the handler so ownership check and follow-up reads stay consistent.
 */
export function withOwnedRepository(
  dbMode: "read" | "write",
  handler: OwnedRepositoryRouteHandler,
): RouteHandler {
  return withUser(async (request, env, user, params, url) => {
    const db = dbMode === "write" ? writeDb(env) : readDb(env);
    const repo = await RepositoryRepository.getOwned(db, user.id, params.id);
    if (!repo) {
      return json({ error: "Repository not found" }, { status: 404 });
    }
    return handler(request, env, { db, repo, user }, params, url);
  });
}
