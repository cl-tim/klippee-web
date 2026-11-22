import {
  localDevUser,
  oauthStateCookieName,
  oauthStateMaxAgeSeconds,
  sessionCookieName,
  sessionMaxAgeSeconds,
} from "../constants";
import { readDb, writeDb } from "../db";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  json,
  oauthStateCookie,
  parseCookies,
  readJsonBody,
  redirect,
  sessionCookie,
} from "../http";
import { enforceRateLimit } from "../rateLimit";
import { AuthRepository } from "../repositories/AuthRepository";
import { AppStateRepository } from "../repositories/AppStateRepository";
import { unwrapDatabaseError } from "../databaseErrors";
import {
  expiredAuthCleanupBatchSize,
  maxActiveOAuthStates,
  maxActiveSessionsPerUser,
} from "../storageLimits";
import type {
  Env,
  OAuthProvider,
  ProviderProfile,
  UserRow,
} from "../types";
import {
  base64Url,
  futureIso,
  hashToken,
  isLocalHostname,
  isProvider,
  nowIso,
  randomToken,
  safeRedirectPath,
  sha256Hex,
} from "../util";
import {
  contentSnapshotMaxBytes,
  decodeContentSnapshot,
  encodeContentSnapshot,
  isContentSnapshotEnvelope,
} from "../../src/contentSnapshot";

const pkceVerifierPattern = /^[A-Za-z0-9_-]{43}$/;
const selfHostedUser: UserRow = {
  id: "self-hosted-user",
  display_name: "Local workspace",
  avatar_url: null,
};

export function usesLocalWorkspace(env: Env) {
  return env.SELF_HOSTED_AUTH_MODE === "local";
}

type AppStateRecord = Record<string, unknown>;

function isAppStateRecord(value: unknown): value is AppStateRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAppState(state: AppStateRecord) {
  const sanitized: AppStateRecord = { ...state };
  let changed = false;

  if (Object.hasOwn(sanitized, "values")) {
    delete sanitized.values;
    changed = true;
  }

  if (Array.isArray(sanitized.printers)) {
    sanitized.printers = sanitized.printers.map((printer) => {
      if (!isAppStateRecord(printer) || !Object.hasOwn(printer, "variableValues")) {
        return printer;
      }

      const sanitizedPrinter = { ...printer };
      delete sanitizedPrinter.variableValues;
      changed = true;
      return sanitizedPrinter;
    });
  }

  return { changed, state: sanitized };
}

async function appStateRevision(stateJson: string | null | undefined) {
  return stateJson === null || stateJson === undefined ? null : sha256Hex(stateJson);
}

function appStateConflict(revision: string | null) {
  return json({
    code: "app_state_conflict",
    currentRevision: revision,
    error: "Cloud state changed; reload it before saving again",
  }, { status: 409 });
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

function providerConfig(provider: OAuthProvider, env: Env) {
  if (provider === "github") {
    return {
      authUrl: "https://github.com/login/oauth/authorize",
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      profileUrl: "https://api.github.com/user",
      scope: "read:user",
      tokenUrl: "https://github.com/login/oauth/access_token",
    };
  }

  return {
    authUrl: "https://discord.com/oauth2/authorize",
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    profileUrl: "https://discord.com/api/users/@me",
    scope: "identify",
    tokenUrl: "https://discord.com/api/oauth2/token",
  };
}

function callbackUrl(provider: OAuthProvider, env: Env) {
  return `${env.APP_ORIGIN}/api/auth/${provider}/callback`;
}

export async function removeExpiredSessions(
  env: Env,
  limit = expiredAuthCleanupBatchSize,
) {
  const result = await AuthRepository.removeExpiredSessions(writeDb(env), nowIso(), limit);
  return result.meta.changes ?? 0;
}

export async function removeExpiredOAuthStates(
  env: Env,
  limit = expiredAuthCleanupBatchSize,
) {
  const result = await AuthRepository.removeExpiredStates(writeDb(env), nowIso(), limit);
  return result.meta.changes ?? 0;
}

export function allowsLocalAuthBypass(request: Request, env: Env) {
  const requestUrl = new URL(request.url);
  return env.LOCAL_AUTH_BYPASS === "1" && isLocalHostname(requestUrl.hostname);
}

async function ensureLocalDevUser(env: Env) {
  const timestamp = nowIso();
  await AuthRepository.ensureLocalUser(writeDb(env), localDevUser, timestamp);
}

export async function getSessionUser(request: Request, env: Env) {
  if (usesLocalWorkspace(env)) {
    await AuthRepository.ensureLocalUser(writeDb(env), selfHostedUser, nowIso());
    return selfHostedUser;
  }

  if (allowsLocalAuthBypass(request, env)) {
    await ensureLocalDevUser(env);
    return localDevUser;
  }

  const token = parseCookies(request)[sessionCookieName];
  if (!token) {
    return null;
  }

  const sessionHash = await hashToken(token, env.SESSION_SECRET);
  return AuthRepository.getSessionUser(writeDb(env), sessionHash, nowIso());
}

export async function getLinkedProviders(env: Env, userId: string) {
  const result = await AuthRepository.listProviders(readDb(env), userId);
  return result.map((row) => row.provider).filter(isProvider);
}

export async function getLinkedProvidersForRequest(request: Request, env: Env, userId: string) {
  if (usesLocalWorkspace(env)) return [];

  if (userId === localDevUser.id && allowsLocalAuthBypass(request, env)) {
    return ["github"] satisfies OAuthProvider[];
  }

  return getLinkedProviders(env, userId);
}

export async function startOAuth(request: Request, env: Env, provider: OAuthProvider) {
  if (usesLocalWorkspace(env)) return json({ error: "Not found" }, { status: 404 });

  const limited = await enforceRateLimit(
    env.AUTH_RATE_LIMITER,
    request,
    "oauth-start",
    "Too many sign-in attempts. Try again shortly.",
  );
  if (limited) {
    return limited;
  }

  const config = providerConfig(provider, env);
  const state = randomToken();
  const verifier = randomToken(32);
  const challenge = await pkceChallenge(verifier);
  const url = new URL(request.url);
  const redirectTo = safeRedirectPath(url.searchParams.get("redirect_to"));
  const createdAt = nowIso();
  const expiresAt = futureIso(oauthStateMaxAgeSeconds);
  const db = writeDb(env);

  const writes = await AuthRepository.createOAuthState(db, { id: state, provider, redirectTo, expiresAt, createdAt, verifier, limit: maxActiveOAuthStates });
  if ((writes[1]?.meta.changes ?? 0) !== 1) {
    return json({ error: "Sign-in is temporarily busy. Try again shortly." }, { status: 503 });
  }

  const authUrl = new URL(config.authUrl);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", callbackUrl(provider, env));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", config.scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return redirect(authUrl.toString(), {
    "set-cookie": oauthStateCookie(state, expiresAt),
  });
}

async function exchangeCodeForToken(
  provider: OAuthProvider,
  env: Env,
  code: string,
  verifier: string,
) {
  const config = providerConfig(provider, env);
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: callbackUrl(provider, env),
  });

  const response = await fetch(config.tokenUrl, {
    body,
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed for ${provider}`);
  }

  const tokenResponse = (await response.json()) as { access_token?: string };
  if (!tokenResponse.access_token) {
    throw new Error(`Token exchange response did not include an access token for ${provider}`);
  }

  return tokenResponse.access_token;
}

async function fetchProviderProfile(provider: OAuthProvider, env: Env, accessToken: string): Promise<ProviderProfile> {
  const config = providerConfig(provider, env);
  const response = await fetch(config.profileUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "Klippee",
    },
  });

  if (!response.ok) {
    throw new Error(`Profile fetch failed for ${provider}`);
  }

  const profile = (await response.json()) as Record<string, unknown>;

  if (provider === "github") {
    const id = String(profile.id);
    const login = String(profile.login ?? "GitHub user");
    return {
      avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
      displayName: typeof profile.name === "string" && profile.name ? profile.name : login,
      id,
      username: login,
    };
  }

  const id = String(profile.id);
  const username = String(profile.username ?? "Discord user");
  const avatarHash = typeof profile.avatar === "string" ? profile.avatar : null;
  return {
    avatarUrl: avatarHash ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png` : null,
    displayName: typeof profile.global_name === "string" && profile.global_name ? profile.global_name : username,
    id,
    username,
  };
}

async function upsertUserFromProfile(env: Env, provider: OAuthProvider, profile: ProviderProfile) {
  const db = writeDb(env);
  const existingIdentity = await AuthRepository.getIdentity(db, provider, profile.id);

  const timestamp = nowIso();
  const userId = existingIdentity?.user_id ?? crypto.randomUUID();

  await AuthRepository.saveProfile(db, provider, profile, userId, timestamp, Boolean(existingIdentity));

  return userId;
}

async function createSession(env: Env, userId: string) {
  const token = randomToken();
  const sessionHash = await hashToken(token, env.SESSION_SECRET);
  const expiresAt = futureIso(sessionMaxAgeSeconds);
  const createdAt = nowIso();
  const sessionId = crypto.randomUUID();
  const db = writeDb(env);

  await AuthRepository.createSession(db, { id: sessionId, userId, hash: sessionHash, expiresAt, createdAt, retainedOthers: maxActiveSessionsPerUser - 1 });

  return { expiresAt, token };
}

export async function handleOAuthCallback(request: Request, env: Env, provider: OAuthProvider) {
  if (usesLocalWorkspace(env)) return json({ error: "Not found" }, { status: 404 });

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = parseCookies(request)[oauthStateCookieName];
  const clearStateHeaders = {
    "set-cookie": clearOAuthStateCookie(),
  };

  if (!code || !state) {
    return redirect(`${env.APP_ORIGIN}/?auth=missing-code`, clearStateHeaders);
  }

  if (cookieState !== state) {
    return redirect(`${env.APP_ORIGIN}/?auth=invalid-state`, clearStateHeaders);
  }

  const db = writeDb(env);
  const stateRow = await AuthRepository.consumeOAuthState(db, state);

  if (
    !stateRow
    || stateRow.provider !== provider
    || stateRow.expires_at <= nowIso()
    || !stateRow.pkce_verifier
    || !pkceVerifierPattern.test(stateRow.pkce_verifier)
  ) {
    return redirect(`${env.APP_ORIGIN}/?auth=invalid-state`, clearStateHeaders);
  }

  try {
    const accessToken = await exchangeCodeForToken(provider, env, code, stateRow.pkce_verifier);
    const profile = await fetchProviderProfile(provider, env, accessToken);
    const userId = await upsertUserFromProfile(env, provider, profile);
    const session = await createSession(env, userId);
    const headers = new Headers();
    headers.append("set-cookie", clearOAuthStateCookie());
    headers.append("set-cookie", sessionCookie(session.token, session.expiresAt));

    return redirect(new URL(safeRedirectPath(stateRow.redirect_to), env.APP_ORIGIN).toString(), headers);
  } catch {
    return redirect(`${env.APP_ORIGIN}/?auth=failed`, clearStateHeaders);
  }
}

export async function logout(request: Request, env: Env) {
  if (usesLocalWorkspace(env)) return json({ error: "Not found" }, { status: 404 });

  const token = parseCookies(request)[sessionCookieName];
  if (token) {
    try {
      const sessionHash = await hashToken(token, env.SESSION_SECRET);
      await AuthRepository.revokeSession(writeDb(env), sessionHash);
    } catch (caught) {
      const error = unwrapDatabaseError(caught);
      console.error({
        errorMessage: (error instanceof Error ? error.message : "Unknown session cleanup error").slice(0, 2_048),
        errorName: error instanceof Error ? error.name : "UnknownError",
        level: "error",
        type: "auth_logout_session_cleanup_failed",
      });
    }
  }

  return json(
    { ok: true },
    {
      headers: {
        "set-cookie": clearSessionCookie(),
      },
    },
  );
}

export async function requireUser(request: Request, env: Env) {
  const user = await getSessionUser(request, env);
  if (!user) {
    return { response: json({ error: "Authentication required" }, { status: 401 }), user: null };
  }

  return { response: null, user };
}

export async function getAppState(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const db = writeDb(env);
  let row = await AppStateRepository.get(db, user.id);

  if (!row) {
    return json({ state: null, updatedAt: null, revision: null });
  }

  const rawState = JSON.parse(row.state_json) as unknown;
  const storedState = isContentSnapshotEnvelope(rawState)
    ? await decodeContentSnapshot(rawState)
    : rawState;
  if (!isAppStateRecord(storedState)) {
    return json({ state: null, updatedAt: row.updated_at, revision: await appStateRevision(row.state_json) });
  }

  const sanitized = sanitizeAppState(storedState);
  if (sanitized.changed || !isContentSnapshotEnvelope(rawState)) {
    let normalizedJson: string;
    try {
      normalizedJson = JSON.stringify(await encodeContentSnapshot(sanitized.state));
    } catch {
      // Older rows accepted before codec complexity limits may still be valid.
      // Preserve their readable shape while applying secret cleanup.
      normalizedJson = JSON.stringify(sanitized.state);
    }
    await AppStateRepository.normalize(db, user.id, row, normalizedJson);

    // A concurrent autosave may have won the compare-and-swap. Always return
    // the current primary row so a cleanup read cannot expose or replace stale
    // account state.
    row = await AppStateRepository.get(db, user.id);
    if (!row) {
      return json({ state: null, updatedAt: null, revision: null });
    }
    const currentRawState = JSON.parse(row.state_json) as unknown;
    const currentState = isContentSnapshotEnvelope(currentRawState)
      ? await decodeContentSnapshot(currentRawState)
      : currentRawState;
    return json({
      state: isAppStateRecord(currentState) ? sanitizeAppState(currentState).state : null,
      updatedAt: row.updated_at,
      revision: await appStateRevision(row.state_json),
    });
  }

  return json({
    state: sanitized.state,
    updatedAt: row.updated_at,
    revision: await appStateRevision(row.state_json),
  });
}

export async function saveAppState(request: Request, env: Env) {
  const { response, user } = await requireUser(request, env);
  if (response) {
    return response;
  }

  const parsedBody = await readJsonBody<unknown>(request, 512_000, "State payload is too large");
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const state =
    typeof parsedBody.value === "object" && parsedBody.value && "state" in parsedBody.value
      ? (parsedBody.value as { state: unknown }).state
      : null;
  if (!isAppStateRecord(state)) {
    return json({ error: "Missing state object" }, { status: 400 });
  }
  const expectedRevision =
    typeof parsedBody.value === "object" && parsedBody.value !== null && "expectedRevision" in parsedBody.value
      ? (parsedBody.value as { expectedRevision: unknown }).expectedRevision
      : undefined;
  if (expectedRevision !== null && typeof expectedRevision !== "string") {
    const current = await AppStateRepository.getContent(writeDb(env), user.id);
    return appStateConflict(await appStateRevision(current?.state_json));
  }

  const sanitized = sanitizeAppState(state);
  let encoded: string;
  try {
    const snapshot = await encodeContentSnapshot(sanitized.state);
    encoded = JSON.stringify(snapshot);
    if (new TextEncoder().encode(encoded).byteLength > contentSnapshotMaxBytes) {
      return json({ error: "State payload is too large" }, { status: 413 });
    }
  } catch {
    return json({ error: "State payload is too large" }, { status: 413 });
  }

  const db = writeDb(env);
  const current = await AppStateRepository.getContent(db, user.id);
  const currentRevision = await appStateRevision(current?.state_json);
  if (expectedRevision === null) {
    if (current) return appStateConflict(currentRevision);
    const updatedAt = nowIso();
    const inserted = await AppStateRepository.create(db, user.id, encoded, updatedAt);
    if ((inserted.meta.changes ?? 0) !== 1) {
      const latest = await AppStateRepository.getContent(db, user.id);
      return appStateConflict(await appStateRevision(latest?.state_json));
    }
    return json({ ok: true, updatedAt, revision: await appStateRevision(encoded) });
  }
  if (!current || currentRevision !== expectedRevision) return appStateConflict(currentRevision);

  const updatedAt = nowIso();
  const updated = await AppStateRepository.save(db, user.id, current.state_json, encoded, updatedAt);
  if ((updated.meta.changes ?? 0) !== 1) {
    const latest = await AppStateRepository.getContent(db, user.id);
    return appStateConflict(await appStateRevision(latest?.state_json));
  }

  return json({ ok: true, updatedAt, revision: await appStateRevision(encoded) });
}
