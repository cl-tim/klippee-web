import { and, asc, count, desc, eq, gt, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import { drizzleDb, type DrizzleDb } from "../db";
import { oauthStates, sessions, userIdentities, users } from "../schema";
import type { D1Client, OAuthProvider, ProviderProfile, UserRow } from "../types";

const expiredStates = (q: DrizzleDb, timestamp: string, limit: number) => q.select({ id: oauthStates.id }).from(oauthStates)
  .where(lte(oauthStates.expiresAt, timestamp)).orderBy(asc(oauthStates.expiresAt), asc(oauthStates.id)).limit(limit);

export const AuthRepository = {
  removeExpiredSessions(db: D1Client, timestamp: string, limit: number) {
    const q = drizzleDb(db);
    const expired = q.select({ id: sessions.id }).from(sessions).where(lte(sessions.expiresAt, timestamp))
      .orderBy(asc(sessions.expiresAt), asc(sessions.id)).limit(limit);
    return q.delete(sessions).where(inArray(sessions.id, expired)).run();
  },
  removeExpiredStates(db: D1Client, timestamp: string, limit: number) {
    const q = drizzleDb(db);
    return q.delete(oauthStates).where(inArray(oauthStates.id, expiredStates(q, timestamp, limit))).run();
  },
  ensureLocalUser(db: D1Client, user: UserRow, timestamp: string) {
    return drizzleDb(db).insert(users).values({ id: user.id, displayName: user.display_name, avatarUrl: user.avatar_url,
      createdAt: timestamp, updatedAt: timestamp,
    }).onConflictDoUpdate({ target: users.id, set: { displayName: user.display_name, avatarUrl: user.avatar_url, updatedAt: timestamp } }).run();
  },
  getSessionUser(db: D1Client, hash: string, timestamp: string) {
    return drizzleDb(db).select({ id: users.id, display_name: users.displayName, avatar_url: users.avatarUrl })
      .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.sessionHash, hash), gt(sessions.expiresAt, timestamp))).get().then(row => row ?? null);
  },
  listProviders(db: D1Client, userId: string) {
    return drizzleDb(db).select({ provider: userIdentities.provider }).from(userIdentities)
      .where(eq(userIdentities.userId, userId)).orderBy(asc(userIdentities.provider)).all();
  },
  getIdentity(db: D1Client, provider: OAuthProvider, providerUserId: string) {
    return drizzleDb(db).select({ user_id: userIdentities.userId }).from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerUserId, providerUserId))).get().then(row => row ?? null);
  },
  saveProfile(db: D1Client, provider: OAuthProvider, profile: ProviderProfile, userId: string, timestamp: string, existing: boolean) {
    const q = drizzleDb(db);
    if (existing) return q.batch([
      q.update(users).set({ displayName: profile.displayName, avatarUrl: profile.avatarUrl, updatedAt: timestamp }).where(eq(users.id, userId)),
      q.update(userIdentities).set({ providerUsername: profile.username, avatarUrl: profile.avatarUrl, updatedAt: timestamp })
        .where(and(eq(userIdentities.provider, provider), eq(userIdentities.providerUserId, profile.id))),
    ]);
    return q.batch([
      q.insert(users).values({ id: userId, displayName: profile.displayName, avatarUrl: profile.avatarUrl, createdAt: timestamp, updatedAt: timestamp }),
      q.insert(userIdentities).values({ id: crypto.randomUUID(), userId, provider, providerUserId: profile.id,
        providerUsername: profile.username, avatarUrl: profile.avatarUrl, createdAt: timestamp, updatedAt: timestamp }),
    ]);
  },
  createOAuthState(db: D1Client, input: { id: string; provider: OAuthProvider; redirectTo: string; expiresAt: string; createdAt: string; verifier: string; limit: number }) {
    const q = drizzleDb(db);
    const total = q.select({ count: count() }).from(oauthStates).where(gt(oauthStates.expiresAt, input.createdAt));
    return q.batch([
      q.delete(oauthStates).where(inArray(oauthStates.id, expiredStates(q, input.createdAt, 100))),
      q.insert(oauthStates).select(sql`select ${input.id}, ${input.provider}, ${input.redirectTo}, ${input.expiresAt},
        ${input.createdAt}, ${input.verifier} where (${total}) < ${input.limit}`),
    ]);
  },
  consumeOAuthState(db: D1Client, id: string) {
    return drizzleDb(db).delete(oauthStates).where(eq(oauthStates.id, id)).returning({
      provider: oauthStates.provider, redirect_to: oauthStates.redirectTo, expires_at: oauthStates.expiresAt, pkce_verifier: oauthStates.pkceVerifier,
    }).get().then(row => row ?? null);
  },
  createSession(db: D1Client, input: { id: string; userId: string; hash: string; expiresAt: string; createdAt: string; retainedOthers: number }) {
    const q = drizzleDb(db);
    const retained = q.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, input.userId),
      ne(sessions.id, input.id), gt(sessions.expiresAt, input.createdAt)))
      .orderBy(desc(sessions.createdAt), desc(sessions.id)).limit(input.retainedOthers);
    return q.batch([
      q.insert(sessions).values({ id: input.id, userId: input.userId, sessionHash: input.hash, expiresAt: input.expiresAt, createdAt: input.createdAt }),
      q.delete(sessions).where(and(eq(sessions.userId, input.userId), ne(sessions.id, input.id), notInArray(sessions.id, retained))),
    ]);
  },
  revokeSession(db: D1Client, hash: string) {
    return drizzleDb(db).delete(sessions).where(eq(sessions.sessionHash, hash)).run();
  },
};
