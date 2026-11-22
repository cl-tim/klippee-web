import { request } from "node:http";
import { Readable } from "node:stream";

// Dial the Compose port while preserving the Host an HTTPS proxy would send.
// Node's fetch replaces a caller-supplied Host with the destination host.
export function requestLocalApp(port, path, { headers, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { connection: "close", ...headers },
      signal: AbortSignal.timeout(180_000),
    }, (incoming) => {
      resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode,
        headers: Object.entries(incoming.headersDistinct).flatMap(
          ([name, values]) => values.map((value) => [name, value]),
        ),
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
