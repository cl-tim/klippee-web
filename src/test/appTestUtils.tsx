import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { vi } from "vitest";
import { createAppQueryClient } from "../app/queryClient";
import { accountStorageKey, readHydratedAccountStorageForTests } from "../storage";
import { TestUiProvider } from "./uiTestUtils";

// Query provider for tests that mount KlippeeProvider (or query-backed hooks)
// directly instead of rendering <App />, which brings its own provider. Each
// mount gets a fresh client so query caches never leak between tests.
export function TestQueryClientProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createAppQueryClient);
  return <TestUiProvider><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></TestUiProvider>;
}

export type JsonBody = Record<string, unknown>;

// Shared, per-test mutable state so individual tests can flip the signed-in user
// before rendering <App />.
export const fetchState: { user: JsonBody | null } = { user: null };

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

// Default API responses for the network calls App fires on mount and after
// sign-in. Tests override `fetchState.user` to exercise the signed-in path.
export function defaultRouteResponse(url: string): JsonBody {
  if (/\/api\/public-packages\/[^/]+\/orca-profiles/.test(url)) return { assets: [] };
  if (url.includes("/api/auth/me")) {
    return { user: fetchState.user };
  }
  if (url.includes("/api/private-packages")) {
    return { packages: [] };
  }
  if (url.includes("/api/companion-assets")) {
    return { assets: [] };
  }
  if (url.includes("/api/packages")) {
    return { packages: [] };
  }
  if (url.includes("/api/printers")) {
    return { printers: [] };
  }
  if (url.includes("/api/repos")) {
    return { repositories: [] };
  }
  return {};
}

export type RouteOverride = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response> | undefined;

// Installs a `fetch` stub whose handler first consults the per-test override
// and falls back to the shared default route table above. Returns the mock so
// tests can assert on recorded calls.
export function stubApiRoutes(overrides?: RouteOverride) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const overridden = await overrides?.(url, init);
    if (overridden) return overridden;
    return jsonResponse(defaultRouteResponse(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function setAccountStored<T>(key: string, value: T, userId = fetchState.user?.id ?? null) {
  localStorage.setItem(accountStorageKey(userId, key), JSON.stringify(value));
}

export function getAccountStored<T>(key: string, fallback: T, userId = fetchState.user?.id ?? null): T {
  const hydrated = readHydratedAccountStorageForTests(userId, key, fallback);
  if (hydrated !== undefined) return hydrated;
  const value = localStorage.getItem(accountStorageKey(userId, key));
  return value ? JSON.parse(value) as T : fallback;
}

export function workspaceTestPrinter(id = "workspace-printer") {
  return {
    appliedVersionId: 0,
    createdAt: "2026-07-24T00:00:00.000Z",
    description: "Test workspace printer",
    id,
    latestVersionId: 0,
    make: "",
    model: "",
    name: "Workspace printer",
    packageIds: [],
    repositoryId: null,
    source: "manual",
    updatedAt: "2026-07-24T00:00:00.000Z",
    variableValues: {},
  };
}

export function stubWorkspacePrinterApi(
  printer = workspaceTestPrinter(),
  cloudData: { companionAssets?: unknown[]; privatePackages?: unknown[] } = {},
) {
  stubApiRoutes((url) => {
    if (url.includes("/api/auth/me")) return jsonResponse({ user: fetchState.user });
    if (url.endsWith("/api/app-state")) return jsonResponse({ state: null, updatedAt: null });
    if (url.endsWith("/api/printers")) return jsonResponse({ printers: [printer] });
    if (url.includes("/api/private-packages")) return jsonResponse({ packages: cloudData.privatePackages ?? [] });
    if (url.includes("/api/companion-assets")) return jsonResponse({ assets: cloudData.companionAssets ?? [] });
    if (url.includes("/api/packages")) return jsonResponse({ packages: [] });
    if (url.includes("/api/repos")) return jsonResponse({ repositories: [] });
    return jsonResponse({});
  });
  return printer;
}
