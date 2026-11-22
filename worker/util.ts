import type { OAuthProvider } from "./types";

export function nowIso() {
  return new Date().toISOString();
}

export function futureIso(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function base64Url(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64(data: ArrayBuffer | Uint8Array) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export async function sha256Hex(data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function hashToken(token: string, secret: string) {
  const encoded = new TextEncoder().encode(`${secret}:${token}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64Url(digest);
}

export function isLocalHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

export function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function safeRedirectPath(value: string | null) {
  if (!value || !value.startsWith("/")) {
    return "/";
  }

  try {
    const base = new URL("https://redirect.invalid/");
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) {
      return "/";
    }

    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

export function parseJsonFallback<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function isProvider(value: string): value is OAuthProvider {
  return value === "github" || value === "discord";
}
