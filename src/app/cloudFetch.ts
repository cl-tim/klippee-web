type StatusReporter = (status: string) => void;

type CloudFetchMessages<T> = {
  pending?: string;
  ok?: string | ((data: T | null) => string);
  fail?: string;
  error?: string;
};

type CloudFetchOptions<T> = Omit<RequestInit, "body"> & {
  json?: unknown;
  onStatus?: StatusReporter;
  messages?: CloudFetchMessages<T>;
  /**
   * Optional runtime validator for the parsed JSON body. Returns the typed
   * value on success or `null` to reject the response shape. When the
   * validator rejects, the result's `data` is `null` and `ok` stays as the
   * HTTP response's ok-ness — callers should check `data` before use.
   */
  validate?: (raw: unknown) => T | null | Promise<T | null>;
};

export type CloudFetchResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
};

/**
 * Wraps `fetch` with the recurring klippee pattern: credentialed JSON request,
 * automatic JSON parse, try/catch error reporting, and optional status string
 * dispatch on pending/ok/fail/error transitions.
 */
export async function cloudFetch<T = unknown>(
  url: string,
  options: CloudFetchOptions<T> = {},
): Promise<CloudFetchResult<T>> {
  const { json, onStatus, messages, headers, validate, ...init } = options;

  if (messages?.pending && onStatus) {
    onStatus(messages.pending);
  }

  const finalHeaders: Record<string, string> = {
    accept: "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  let body: BodyInit | undefined;
  if (json !== undefined) {
    body = JSON.stringify(json);
    finalHeaders["content-type"] = "application/json";
  }

  try {
    const response = await fetch(url, {
      credentials: "include",
      ...init,
      body,
      headers: finalHeaders,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const raw = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : null;
    const data: T | null = validate ? (raw === null ? null : await validate(raw)) : (raw as T | null);

    if (response.ok) {
      if (messages?.ok && onStatus) {
        const message = typeof messages.ok === "function" ? messages.ok(data) : messages.ok;
        onStatus(message);
      }
      return { ok: true, status: response.status, data };
    }

    if (onStatus) {
      const serverError = typeof raw === "object"
        && raw !== null
        && "error" in raw
        && typeof raw.error === "string"
        ? raw.error.trim()
        : "";
      if (serverError || messages?.fail) {
        onStatus(serverError || messages?.fail || "Request failed");
      }
    }
    return { ok: false, status: response.status, data };
  } catch {
    if (messages?.error && onStatus) {
      onStatus(messages.error);
    }
    return { ok: false, status: 0, data: null };
  }
}
