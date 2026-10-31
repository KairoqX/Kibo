import * as net from "net";
import { discoveryPath, readDiscovery, type DiscoveryResult } from "./discovery";
import { buildLine, HOST, type EventMeta } from "./protocol";

export type SendResult = { ok: true } | { ok: false; reason: string };
export type Status = "available" | "unavailable";

export interface ClientOptions {
  discoveryFile?: () => string;
  readDiscoveryImpl?: (file: string) => DiscoveryResult;
  connect?: (port: number, host: string) => net.Socket;
  now?: () => number;
  timeoutMs?: number;
  /** Fired only when availability changes (so a stopped Kibo logs once, not per event). Reasons never contain the token. */
  onStatus?: (s: Status, reason?: string) => void;
}

const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Authenticated, loopback-only client. The discovery file is re-read for every send, so a restarted Kibo (new port and
 * token) is picked up automatically. While Kibo is unavailable, event sends are skipped during an exponential backoff
 * (2 s .. 60 s): no connection storms, no error spam. Events are dropped, never queued (a build result minutes late would mislead).
 */
export class KiboClient {
  private o: Required<Omit<ClientOptions, "onStatus">> & Pick<ClientOptions, "onStatus">;
  private nextAllowed = 0;
  private delay = BACKOFF_START_MS;
  private status: Status | null = null;

  constructor(opts: ClientOptions = {}) {
    this.o = {
      discoveryFile: opts.discoveryFile ?? (() => discoveryPath()),
      readDiscoveryImpl: opts.readDiscoveryImpl ?? ((f) => readDiscovery(f)),
      connect: opts.connect ?? ((port, host) => net.createConnection({ port, host })),
      now: opts.now ?? Date.now,
      timeoutMs: opts.timeoutMs ?? 1500,
      onStatus: opts.onStatus,
    };
  }

  /** Normal event path: honours the backoff. */
  send(event: string, meta: EventMeta = {}): Promise<SendResult> {
    if (this.o.now() < this.nextAllowed) return Promise.resolve({ ok: false, reason: "backoff" });
    return this.attempt(event, meta);
  }

  /** Explicit user action (commands): ignores the backoff so "Check Connection" always really checks. */
  sendNow(event: string, meta: EventMeta = {}): Promise<SendResult> {
    return this.attempt(event, meta);
  }

  private async attempt(event: string, meta: EventMeta): Promise<SendResult> {
    let r: SendResult;
    try { r = await this.exchange(event, meta); } catch { r = { ok: false, reason: "error" }; }
    if (r.ok) {
      this.delay = BACKOFF_START_MS; this.nextAllowed = 0;
      this.setStatus("available");
    } else if (r.reason !== "invalid-event") {
      this.nextAllowed = this.o.now() + this.delay;
      this.delay = Math.min(this.delay * 2, BACKOFF_MAX_MS);
      this.setStatus("unavailable", r.reason);
    }
    return r;
  }

  private setStatus(s: Status, reason?: string) {
    if (this.status === s) return;
    this.status = s;
    try { this.o.onStatus?.(s, reason); } catch { /* logging must never break reporting */ }
  }

  private exchange(event: string, meta: EventMeta): Promise<SendResult> {
    let line: string;
    const d = this.o.readDiscoveryImpl(this.o.discoveryFile());
    if (!d.ok) return Promise.resolve({ ok: false, reason: d.reason });
    try { line = buildLine(d.info.token, event, meta); }
    catch { return Promise.resolve({ ok: false, reason: "invalid-event" }); }

    return new Promise<SendResult>((resolve) => {
      let done = false, reply = "";
      let sock: net.Socket;
      const finish = (r: SendResult) => {
        if (done) return; done = true; clearTimeout(timer);
        try { sock?.destroy(); } catch { /* ignore */ }
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), this.o.timeoutMs);
      try { sock = this.o.connect(d.info.port, HOST); } catch { return finish({ ok: false, reason: "not-running" }); }
      sock.setEncoding("utf8");
      sock.on("connect", () => sock.write(line));
      sock.on("data", (c: string) => {
        reply += c;
        if (reply.length > 128) return finish({ ok: false, reason: "bad-reply" });
        if (reply.includes("\n")) {
          const t = reply.trim();
          finish(t === "ok" ? { ok: true } : { ok: false, reason: /^err [a-z-]{1,40}$/.test(t) ? t.slice(4) : "bad-reply" });
        }
      });
      sock.on("error", () => finish({ ok: false, reason: "not-running" }));
      sock.on("close", () => finish(reply.startsWith("ok") ? { ok: true } : { ok: false, reason: "closed" }));
    });
  }
}
