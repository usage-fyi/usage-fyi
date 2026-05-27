import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Tiny `http.createServer` wrapper for tests. Mirrors enough of the Bun.serve
 * affordances we relied on (port-0 binding, JSON-body parsing, JSON responses,
 * one-line stop) so individual tests stay terse.
 */

export interface JsonResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface RawResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

export type TestHandler = (req: {
  method: string;
  pathname: string;
  json: () => Promise<unknown>;
}) => Promise<JsonResponse | RawResponse> | JsonResponse | RawResponse;

export interface TestServer {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startTestServer(
  handler: TestHandler,
): Promise<TestServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let cachedBody: string | undefined;
        const result = await handler({
          method: req.method ?? "GET",
          pathname: url.pathname,
          json: async () => {
            cachedBody ??= await readBody(req);
            return JSON.parse(cachedBody);
          },
        });
        const status = result.status ?? 200;
        const isRaw = typeof result.body === "string";
        const headers = {
          "Content-Type": isRaw
            ? "text/plain; charset=utf-8"
            : "application/json; charset=utf-8",
          ...result.headers,
        };
        res.writeHead(status, headers);
        res.end(isRaw ? (result.body as string) : JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const port = addr.port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
