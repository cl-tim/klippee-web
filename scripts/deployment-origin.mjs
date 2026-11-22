export function deploymentOrigin(value, instruction) {
  if (!value) throw new Error(instruction);
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS origin without credentials, a path, query string, or fragment.");
  }
  return url;
}
