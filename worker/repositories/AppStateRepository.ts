import { and, eq } from "drizzle-orm";
import { drizzleDb } from "../db";
import { userAppState } from "../schema";
import type { AppStateRow, D1Client } from "../types";

export const AppStateRepository = {
  get(db: D1Client, userId: string) {
    return drizzleDb(db).select({ state_json: userAppState.stateJson, updated_at: userAppState.updatedAt })
      .from(userAppState).where(eq(userAppState.userId, userId)).get().then(row => row ?? null);
  },
  getContent(db: D1Client, userId: string) {
    return drizzleDb(db).select({ state_json: userAppState.stateJson }).from(userAppState)
      .where(eq(userAppState.userId, userId)).get().then(row => row ?? null);
  },
  normalize(db: D1Client, userId: string, previous: AppStateRow, stateJson: string) {
    return drizzleDb(db).update(userAppState).set({ stateJson }).where(and(eq(userAppState.userId, userId),
      eq(userAppState.stateJson, previous.state_json), eq(userAppState.updatedAt, previous.updated_at))).run();
  },
  create(db: D1Client, userId: string, stateJson: string, updatedAt: string) {
    return drizzleDb(db).insert(userAppState).values({ userId, stateJson, updatedAt })
      .onConflictDoNothing({ target: userAppState.userId }).run();
  },
  save(db: D1Client, userId: string, previousJson: string, stateJson: string, updatedAt: string) {
    return drizzleDb(db).update(userAppState).set({ stateJson, updatedAt })
      .where(and(eq(userAppState.userId, userId), eq(userAppState.stateJson, previousJson))).run();
  },
};
