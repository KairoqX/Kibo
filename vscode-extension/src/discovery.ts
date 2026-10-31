import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const APP_ID = "dev.kairoqx.kibo";
const MAX_FILE_BYTES = 4096;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/; // no whitespace: a token can never inject extra protocol fields

/** Same convention as scripts/kibo-report.mjs (Tauri's app_local_data_dir + ipc.json). */
export function discoveryPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string {
  if (env.KIBO_IPC_FILE) return env.KIBO_IPC_FILE;
  const p = platform === "win32" ? path.win32 : path.posix;
  let base: string;
  if (platform === "win32") base = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
  else if (platform === "darwin") base = p.join(home, "Library", "Application Support");
  else base = env.XDG_DATA_HOME || p.join(home, ".local", "share");
  return p.join(base, APP_ID, "ipc.json");
}

export interface Discovery { port: number; token: string }
export type DiscoveryResult =
  | { ok: true; info: Discovery }
  | { ok: false; reason: "not-running" | "invalid-discovery" };

/** Reads and validates the discovery file. Never throws; the token never appears in any returned reason. */
export function readDiscovery(file: string, readFile: (f: string) => string = (f) => fs.readFileSync(f, "utf8")): DiscoveryResult {
  let text: string;
  try { text = readFile(file); } catch { return { ok: false, reason: "not-running" }; }
  if (text.length > MAX_FILE_BYTES) return { ok: false, reason: "invalid-discovery" };
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return { ok: false, reason: "invalid-discovery" }; }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, reason: "invalid-discovery" };
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return { ok: false, reason: "invalid-discovery" };
  const { port, token } = o;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: "invalid-discovery" };
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, reason: "invalid-discovery" };
  return { ok: true, info: { port, token } };
}
