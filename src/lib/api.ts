export async function apiError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: string; error?: string };
    return body.detail || body.error || fallback;
  } catch {
    return fallback;
  }
}
