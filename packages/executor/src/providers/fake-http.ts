import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeProvider, type FakeCall } from "./fake.js";
import {
  PermanentProviderError,
  TransientProviderError,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
} from "./types.js";

/**
 * FakeProvider behind HTTP, so its call log survives the executor being
 * killed (chaos tests, and the PAYMENTS=fake-http demo fallback).
 *
 *   POST /refunds   RefundRequest -> RefundResult | { error, transient }
 *   GET  /calls     FakeCall[]
 *   POST /reset
 */
export function startFakeProviderServer(
  port = 0,
  provider = new FakeProvider(),
): Promise<{ server: Server; url: string; provider: FakeProvider }> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/calls") return send(200, provider.calls);
      if (req.method === "POST" && req.url === "/reset") {
        provider.reset();
        return send(200, { ok: true });
      }
      if (req.method === "POST" && req.url === "/refunds") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        try {
          return send(200, await provider.refund(JSON.parse(raw) as RefundRequest));
        } catch (err) {
          const transient = err instanceof TransientProviderError;
          return send(transient ? 503 : 400, { error: (err as Error).message, transient });
        }
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: (err as Error).message, transient: true });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${actual}`, provider });
    });
  });
}

export class HttpFakeProvider implements PaymentProvider {
  readonly name = "fake-http";

  constructor(private readonly baseUrl: string) {}

  async refund(req: RefundRequest): Promise<RefundResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/refunds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch (err) {
      throw new TransientProviderError(`fake-http: ${(err as Error).message}`);
    }
    const body = (await res.json()) as RefundResult & { error?: string; transient?: boolean };
    if (res.ok) return { refundId: body.refundId };
    if (body.transient) throw new TransientProviderError(body.error ?? `fake-http ${res.status}`);
    throw new PermanentProviderError(body.error ?? `fake-http ${res.status}`);
  }

  async calls(): Promise<FakeCall[]> {
    return (await (await fetch(`${this.baseUrl}/calls`)).json()) as FakeCall[];
  }

  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/reset`, { method: "POST" });
  }
}
