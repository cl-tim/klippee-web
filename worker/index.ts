/// <reference types="vite/client" />
import { Container } from "@cloudflare/containers";
import {
  CanonicalBlobBudgetError,
  CanonicalBlobReclaimInProgressError,
  canonicalBlobBudgetResponse,
  canonicalBlobReclaimInProgressResponse,
} from "./blobBudget";
import { json, withSecurityHeaders } from "./http";
import { handleApi } from "./router";
import { runScheduledMaintenance } from "./scheduledMaintenance";
import { unwrapDatabaseError } from "./databaseErrors";
import type { Env } from "./types";

export { CanonicalBlobReclaimer } from "./canonicalBlobReclaimer";

export class CadEngineContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/registry" || url.pathname === "/registry/") {
        url.pathname = "/shared-configs";
        return withSecurityHeaders(Response.redirect(url.toString(), 308));
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }

      return withSecurityHeaders(await env.ASSETS.fetch(request), { viteDevelopment: import.meta.env.DEV });
    } catch (caught) {
      const err = unwrapDatabaseError(caught);
      if (err instanceof CanonicalBlobBudgetError) {
        return withSecurityHeaders(canonicalBlobBudgetResponse(err));
      }
      if (
        err instanceof CanonicalBlobReclaimInProgressError
        || (err instanceof Error && err.message.toLowerCase().includes("reclamation in progress"))
      ) {
        return withSecurityHeaders(canonicalBlobReclaimInProgressResponse());
      }
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;

      console.error(
        JSON.stringify({
          level: "error",
          type: "unhandled_exception",
          method: request.method,
          path: url.pathname,
          message,
          stack,
        }),
      );

      return json({ error: "Internal server error" }, { status: 500 });
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledMaintenance(controller, env));
  },
};
