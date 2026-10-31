import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const TOKEN = "t".repeat(64);

/** Same wire rules as src-tauri/src/ipc.rs (token check, line, ok/err reply). `lines` never includes the token. */
export interface Mock { file: string; lines: string[]; rawLines: string[]; port: number; close(): Promise<void>; connections(): number }
export async function mockKibo(opts: { reply?: (line: string) => string | null } = {}): Promise<Mock> {
  const rawLines: string[] = [];
  let conns = 0;
  const server = net.createServer((s) => {
    conns++;
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const line = buf.trim();
      rawLines.push(line);
      const custom = opts.reply?.(line);
      if (custom === null) return;                       // never answer (timeout test)
      const p = line.split(/\s+/);
      const good = p[0] === "KIBO/1" && p[1] === TOKEN && !!p[2];
      s.end(custom ?? (good ? "ok\n" : "err unauthorized\n"));
    });
    s.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-vsc-"));
  const file = path.join(dir, "ipc.json");
  fs.writeFileSync(file, JSON.stringify({ v: 1, port, token: TOKEN }));
  return {
    file, port, rawLines, connections: () => conns,
    get lines() { return rawLines.map((l) => l.replace(`KIBO/1 ${TOKEN} `, "")); },
    close: () => new Promise<void>((r) => { server.close(() => r()); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}

/** Deterministic timers + clock. */
export class FakeClock {
  t = 1_000_000; private id = 0; private q = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimer = (fn: () => void, ms: number): unknown => { const id = ++this.id; this.q.set(id, { at: this.t + ms, fn }); return id; };
  clearTimer = (h: unknown) => { this.q.delete(h as number); };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.q].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.q.delete(next[0]); this.t = next[1].at; next[1].fn();
    }
    this.t = end;
  }
  pending() { return this.q.size; }
}

export function tmpFile(content: string): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-vsc-"));
  const file = path.join(dir, "ipc.json");
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
