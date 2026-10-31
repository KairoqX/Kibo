#!/usr/bin/env node
/**
 * kibo-report: tell a running Kibo that something happened (build started/finished, task done...).
 *
 *   kibo-report build-started   [--source npm]
 *   kibo-report build-succeeded [--duration-ms 84000] [--source cargo]
 *   kibo-report build-failed    [--duration-ms 5200]  [--source cargo]
 *   kibo-report task-done       --duration-ms 120000
 *   kibo-report user-returned
 *   kibo-report run [--source npm] [--no-start] -- <command> [args...]
 *
 * Privacy: only the event type, an optional duration and an optional short source label are sent.
 * Never the command line, its output, file names or any source code. `run` does not read the
 * command's output (stdio is inherited) and always exits with the wrapped command's own exit code.
 * If Kibo is not running the reporter stays silent and exits 0, so it can never break a build.
 *
 * `run` is the outermost reporter of a build: the command it starts inherits KIBO_REPORT_ACTIVE=1, so npm hooks, the
 * `kibo-npm` wrapper or the Vite plugin inside it stay silent (no duplicate/contradictory events). If `run` itself is
 * started inside another reporter, or KIBO_REPORT_DISABLE=1 is set, it just runs the command without reporting.
 * Ctrl+C / killed-by-signal runs report nothing. Automatic integrations: see EVENTS.md (kibo-npm.mjs, integrations/).
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuildRun, MAX_DURATION_MS, childEnv, classifyExit, exitCodeFor, isMainModule, reportingMode, spawnAndWait } from "./integrations/core.mjs";

export const APP_ID = "dev.kairoqx.kibo";
const COMMANDS = {
  "build-started": "build_started",
  "build-succeeded": "build_succeeded",
  "build-failed": "build_failed",
  "task-done": "task_completed",
  "user-returned": "user_returned",
};
const SOURCE_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** Where Kibo publishes its port + token (matches Tauri's app_local_data_dir). */
export function discoveryPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.KIBO_IPC_FILE) return env.KIBO_IPC_FILE;
  // Use the target platform's path rules, not the host's, so the result is correct (and testable) anywhere.
  const p = platform === "win32" ? path.win32 : path.posix;
  let base;
  if (platform === "win32") base = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
  else if (platform === "darwin") base = p.join(home, "Library", "Application Support");
  else base = env.XDG_DATA_HOME || p.join(home, ".local", "share");
  return p.join(base, APP_ID, "ipc.json");
}

/** Builds the one-line wire message. Throws on invalid values (callers validate first). */
export function buildLine(token, event, { durationMs, source } = {}) {
  let line = `KIBO/1 ${token} ${event}`;
  if (durationMs !== undefined) {
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) throw new Error("invalid duration");
    line += ` duration=${durationMs}`;
  }
  if (source !== undefined) {
    if (!SOURCE_RE.test(source)) throw new Error("invalid source (letters, digits, . _ - ; max 32)");
    line += ` source=${source}`;
  }
  return line + "\n";
}

/**
 * Sends one event. Resolves { ok, reason }. Never rejects and never throws:
 * Kibo being closed / missing / slow is a normal situation, not an error.
 */
export function report(event, opts = {}, { file = discoveryPath(), timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let info, line;
    try {
      info = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(info.port) || typeof info.token !== "string") throw new Error("bad discovery file");
      line = buildLine(info.token, event, opts);
    } catch (e) {
      return resolve({ ok: false, reason: e instanceof Error && /invalid/.test(e.message) ? e.message : "kibo-not-running" });
    }
    let done = false, reply = "";
    const finish = (r) => { if (!done) { done = true; sock.destroy(); clearTimeout(timer); resolve(r); } };
    const sock = net.createConnection({ host: "127.0.0.1", port: info.port });
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(line));
    sock.on("data", (d) => { reply += d; if (reply.includes("\n")) finish(reply.startsWith("ok") ? { ok: true } : { ok: false, reason: reply.trim() }); });
    sock.on("error", () => finish({ ok: false, reason: "kibo-not-running" }));
    sock.on("close", () => finish({ ok: reply.startsWith("ok"), reason: reply.startsWith("ok") ? undefined : "closed" }));
  });
}

function parseFlags(argv) {
  const out = { opts: {}, noStart: false, rest: [], errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    if (a === "--duration-ms") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > MAX_DURATION_MS) out.errors.push("--duration-ms needs a whole number of milliseconds (0 to 86400000)");
      else out.opts.durationMs = n;
    } else if (a === "--source") {
      const s = argv[++i];
      if (!s || !SOURCE_RE.test(s)) out.errors.push("--source must be 1-32 characters: letters, digits, . _ -");
      else out.opts.source = s;
    } else if (a === "--no-start") out.noStart = true;
    else out.errors.push(`unknown option: ${a}`);
  }
  return out;
}

const USAGE = `Usage:
  kibo-report <build-started|build-succeeded|build-failed|task-done|user-returned> [--duration-ms N] [--source NAME]
  kibo-report run [--source NAME] [--no-start] -- <command> [args...]
Set KIBO_REPORT_VERBOSE=1 to see why an event was not delivered.`;

/**
 * Runs a command, reports its outcome, returns its exit code. Output is never read.
 * Reports nothing when nested in another reporter, when KIBO_REPORT_DISABLE=1, or when the run was cancelled.
 */
export async function runWrapped(cmdArgs, opts, { noStart = false, verbose = false, doReport = report, env = process.env, spawnImpl, platform = process.platform, now = Date.now } = {}) {
  const run = new BuildRun({ send: doReport, now, source: opts.source, mode: reportingMode(env), alreadyStarted: noStart });
  if (!noStart) await run.start();
  const { code, signal } = await spawnAndWait(cmdArgs, { env: childEnv(env), spawnImpl, platform });
  const r = await run.finish(classifyExit(code, signal));
  if (verbose && r.sent && !r.ok) console.error(`kibo-report: not delivered (${r.reason})`);
  return exitCodeFor(code, signal);
}

export async function main(argv) {
  const verbose = process.env.KIBO_REPORT_VERBOSE === "1";
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(USAGE); return cmd ? 0 : 2; }
  const flags = parseFlags(rest);
  if (cmd === "run") {
    if (flags.errors.length || flags.rest.length === 0) { console.error([...flags.errors, "run needs a command after --"].join("\n") + "\n" + USAGE); return 2; }
    return runWrapped(flags.rest, flags.opts, { noStart: flags.noStart, verbose });
  }
  const event = COMMANDS[cmd];
  if (!event || flags.errors.length) { console.error([event ? "" : `unknown command: ${cmd}`, ...flags.errors].filter(Boolean).join("\n") + "\n" + USAGE); return 2; }
  const r = await report(event, flags.opts);
  if (verbose && !r.ok) console.error(`kibo-report: not delivered (${r.reason})`);
  return 0;                                                // never fail a pipeline because Kibo is closed
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
