import { describe, expect, it } from "vitest";
import { dispatchRoute, matchRoute, type Route } from "./route";

const ok = () => new Response(null);

describe("matchRoute", () => {
  it("matches fixed segments and extracts named params", () => {
    expect(matchRoute("/api/repos/:id/versions", "/api/repos/repo_1/versions"))
      .toEqual({ id: "repo_1" });
  });

  it("returns null when segment counts differ", () => {
    expect(matchRoute("/api/repos/:id", "/api/repos/repo_1/versions")).toBeNull();
  });

  it("decodes URI-encoded params", () => {
    expect(matchRoute("/api/repos/:id", "/api/repos/a%20b")).toEqual({ id: "a b" });
  });

  it("captures wildcard remainders into rest", () => {
    expect(matchRoute("/api/cad/*", "/api/cad/render/preview"))
      .toEqual({ rest: "render/preview" });
  });
});

describe("dispatchRoute", () => {
  const routes: Route[] = [
    { handler: ok, method: "GET", pattern: "/api/things" },
    { handler: ok, method: "POST", pattern: "/api/things" },
    { handler: ok, method: ["GET", "POST"], pattern: "/api/things/:id/download" },
  ];

  function request(method: string, path: string) {
    const url = new URL(path, "https://klippee.test");
    return { request: new Request(url, { method }), url };
  }

  it("returns the first route whose pattern and method both match", () => {
    const { request: req, url } = request("POST", "/api/things");
    const result = dispatchRoute(routes, req, url);
    expect(result && "handler" in result).toBe(true);
  });

  it("returns null when no pattern matches at all", () => {
    const { request: req, url } = request("GET", "/api/missing");
    expect(dispatchRoute(routes, req, url)).toBeNull();
  });

  it("reports a method mismatch when the path exists under other methods", () => {
    const { request: req, url } = request("DELETE", "/api/things");
    expect(dispatchRoute(routes, req, url)).toEqual({ methodMismatch: ["GET", "POST"] });
  });

  it("deduplicates allowed methods across matching routes", () => {
    const { request: req, url } = request("PATCH", "/api/things/thing_1/download");
    expect(dispatchRoute(routes, req, url)).toEqual({ methodMismatch: ["GET", "POST"] });
  });
});
