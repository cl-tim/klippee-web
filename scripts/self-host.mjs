import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

export function readConfig(env) {
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("APP_ORIGIN must be an HTTPS origin, for example https://klippee.example.com");
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || /change.me|example|dev-session/i.test(env.SESSION_SECRET)) {
    throw new Error("Set SESSION_SECRET to a unique random secret of at least 32 characters");
  }
  // Preserve OAuth for upgrades whose existing .env predates AUTH_MODE.
  const authMode = env.AUTH_MODE ?? "oauth";
  if (authMode !== "local" && authMode !== "oauth") {
    throw new Error("AUTH_MODE must be local or oauth");
  }
  if (authMode === "oauth" && !((env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) || (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET))) {
    throw new Error("AUTH_MODE=oauth requires a GitHub or Discord OAuth application");
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
  return {
    origin: origin.origin,
    originHost: origin.host,
    authMode,
    port,
    host: env.HOST ?? "0.0.0.0",
    dataDirectory: resolve(env.KLIPPEE_DATA_DIR ?? "self-hosted/data"),
    bindings: Object.fromEntries([
      ["APP_ORIGIN", origin.origin],
      ["CAD_API_BASE", env.CAD_API_BASE ?? "http://cad:8080"],
      ["LOCAL_AUTH_BYPASS", "0"],
      ["SELF_HOSTED_AUTH_MODE", authMode],
      ...["SESSION_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "LOG_IMPROVEMENT_REVIEW_TOKEN", "STORAGE_MAINTENANCE_TOKEN"]
        .map((name) => [name, env[name] ?? ""]),
    ]),
  };
}

// Migrations include triggers with internal semicolons. Keep each trigger as
// one prepared statement, and execute each file and its ledger row atomically.
export function splitSql(sql) {
  const statements = [];
  let current = "";
  let quote;
  const source = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    current += character;
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) current += source[++index];
        else quote = undefined;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ";") {
      const statement = current.trim();
      if (/^CREATE\s+TRIGGER\b/i.test(statement) && !/^END\s*;$/i.test(statement.split(/\r?\n/).at(-1)?.trim() ?? "")) continue;
      if (statement !== ";") statements.push(statement.slice(0, -1));
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function migrate(db, directory) {
  await db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)").run();
  const applied = new Set((await db.prepare("SELECT name FROM d1_migrations").all()).results.map((row) => row.name));
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()) {
    if (applied.has(file)) continue;
    const statements = splitSql(await readFile(resolve(directory, file), "utf8"));
    await db.batch([
      ...statements.map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(file),
    ]);
    console.log(`Applied ${file}`);
  }
}

export async function startSelfHost(config, { root = resolve("."), maintenanceIntervalMs = 3_600_000 } = {}) {
  await mkdir(config.dataDirectory, { recursive: true });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    name: "klippee-self-hosted",
    host: "127.0.0.1",
    port: 0,
    inspectorHost: "127.0.0.1",
    compatibilityDate: "2026-05-12",
    modules: true,
    scriptPath: resolve(root, "dist/klippee/index.js"),
    bindings: config.bindings,
    resourcePersistencePath: config.dataDirectory,
    telemetry: { enabled: false },
    unsafeDevRegistryPath: "",
    unsafeLocalExplorer: false,
    cf: false,
    assets: {
      directory: resolve(root, "dist/client"),
      binding: "ASSETS",
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: "single-page-application" },
    },
    d1Databases: { DB: "klippee-self-hosted" },
    r2Buckets: { BLOBS: "klippee-self-hosted-blobs" },
    durableObjects: { CANONICAL_BLOB_RECLAIMER: { className: "CanonicalBlobReclaimer", useSQLite: true } },
    ratelimits: Object.fromEntries([
      ["AUTH_RATE_LIMITER", 20], ["CAD_RATE_LIMITER", 20], ["PACKAGE_RATE_LIMITER", 30],
      ["DIAGNOSTIC_UPLOAD_RATE_LIMITER", 4], ["LOG_IMPROVEMENT_RATE_LIMITER", 24],
    ].map(([name, limit]) => [name, { namespace_id: name, simple: { limit, period: 60 } }])),
  }));
  let server;
  let timer;
  let maintenance;
  try {
    const db = await runtime.getD1Database("DB");
    await migrate(db, resolve(root, "migrations"));
    const worker = await runtime.getWorker();
    const runMaintenance = () => {
      if (maintenance) return maintenance;
      maintenance = worker.scheduled({ cron: "0 3 * * *", scheduledTime: Date.now() })
        .catch((error) => console.error("Scheduled maintenance failed:", error.message))
        .finally(() => { maintenance = undefined; });
      return maintenance;
    };
    server = createServer(async (incoming, outgoing) => {
      try {
        // Route only application requests. The runtime's inspector, local
        // scheduled-event trigger and other developer endpoints stay private.
        const url = new URL(incoming.url, config.origin);
        // Local mode gives the caller access to the shared workspace. Require
        // the configured Host to reject requests made through DNS rebinding.
        const healthCheck = incoming.method === "GET" && incoming.url === "/api/health";
        if (config.authMode === "local" && !healthCheck && incoming.headers.host?.toLowerCase() !== config.originHost) {
          outgoing.writeHead(421).end();
          return;
        }
        if (url.origin !== config.origin || url.pathname.startsWith("/cdn-cgi/") || url.pathname.startsWith("/__")) {
          outgoing.writeHead(404).end();
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && !["host", "connection", "transfer-encoding", "cf-connecting-ip", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].includes(name)) {
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
        }
        // Use the transport peer, never a caller-supplied Cloudflare/IP header.
        // Behind a proxy, anonymous limits are shared by that proxy's clients.
        headers.set("cf-connecting-ip", incoming.socket.remoteAddress ?? "unknown");
        headers.set("accept-encoding", "identity");
        const response = await runtime.dispatchFetch(url, {
          method: incoming.method,
          headers,
          body: ["GET", "HEAD"].includes(incoming.method) ? undefined : incoming,
          duplex: "half",
          redirect: "manual",
        });
        const responseHeaders = Object.fromEntries(response.headers);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) responseHeaders["set-cookie"] = cookies;
        outgoing.writeHead(response.status, responseHeaders);
        if (response.body && incoming.method !== "HEAD") await pipeline(Readable.fromWeb(response.body), outgoing);
        else outgoing.end();
      } catch (error) {
        console.error("Request failed:", error.message);
        if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" }).end('{"error":"Internal server error"}');
        else outgoing.destroy();
      }
    });
    server.requestTimeout = 180_000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    timer = setInterval(runMaintenance, maintenanceIntervalMs);
    await runMaintenance();
    return {
      runtime,
      server,
      async close() {
        clearInterval(timer);
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await maintenance;
        await runtime.dispose();
      },
    };
  } catch (error) {
    clearInterval(timer);
    server?.close();
    await runtime.dispose();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = readConfig(process.env);
  const app = await startSelfHost(config);
  console.log(`Klippee listening on ${config.host}:${app.server.address().port} for ${config.origin}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  });
}
