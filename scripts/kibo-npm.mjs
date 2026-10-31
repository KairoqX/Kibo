#!/usr/bin/env node
/**
 * kibo-npm: opt-in npm integration for Kibo. Two modes, with DIFFERENT guarantees:
 *
 *   kibo-npm run <script> [args...]   WRAPPER (recommended). Put it in an npm script:
 *                                       "build":      "node scripts/kibo-npm.mjs run build:kibo"
 *                                       "build:kibo": "tsc && vite build"
 *                                     It runs `npm run build:kibo` as a child, waits for it, and reports from the real
 *                                     exit code: build_started, then build_succeeded (exit 0) or build_failed (non-zero).
 *                                     Exits with the child's own exit code. Ctrl+C reports nothing.
 *
 *   kibo-npm pre | post               LIFECYCLE HOOKS (limited). Used as `prebuild` / `postbuild`:
 *                                       "prebuild":  "node scripts/kibo-npm.mjs pre"
 *                                       "postbuild": "node scripts/kibo-npm.mjs post"
 *                                     npm runs `postbuild` ONLY if `build` succeeded and exposes no result to any hook, so
 *                                     this mode can report "started" and "succeeded" but can NEVER report "failed".
 *                                     (`npm run build --ignore-scripts` skips both hooks.)
 *
 * Privacy: sends only the event type, a duration and the label "npm". Never output, command lines, paths or file contents.
 * The only thing written to disk is hook mode's tiny start-time marker in the OS temp folder (see EVENTS.md).
 * Nothing here can fail a build because Kibo is closed. Set KIBO_REPORT_DISABLE=1 to silence it, KIBO_REPORT_VERBOSE=1 to debug.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { report } from "./kibo-report.mjs";
import { BuildRun, MAX_DURATION_MS, childEnv, classifyExit, exitCodeFor, isMainModule, projectKey, reportingMode, spawnAndWait } from "./integrations/core.mjs";

export const SOURCE = "npm";
export const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
/** A start marker older than this is ignored (a build that never finished must not make a later stray `post` look like a success). */
export const MARKER_MAX_AGE_MS = 6 * 3_600_000;

/** Delivery must never throw into a build. */
const safeReport = async (event, opts) => { try { return await report(event, opts); } catch { return { ok: false, reason: "error" }; } };

/* ------------------------------------------------------------ wrapper mode */

/** How to start `npm run <script> [-- args]`. Prefers node + npm-cli.js (no shell, no quoting issues, no npm.cmd). */
export function npmInvocation(env, script, args, platform = process.platform) {
  const tail = ["run", script, ...(args.length ? ["--", ...args] : [])];
  const cli = env.npm_execpath;
  if (cli && /(^|[\\/])npm-cli\.js$/i.test(cli)) return { cmd: [env.npm_node_execpath || process.execPath, cli, ...tail], shell: false };
  return { cmd: ["npm", ...tail], shell: platform === "win32" };   // npm is npm.cmd on Windows: needs a shell
}

/** @returns {Promise<number>} the exit code to exit with: the wrapped script's own. */
export async function runScript(script, args, { env = process.env, send = safeReport, now = Date.now, platform = process.platform, spawnImpl, verbose = false } = {}) {
  if (!SCRIPT_RE.test(script ?? "")) { console.error("kibo-npm run: needs an npm script name (letters, digits, : _ . -)"); return 2; }
  if (env.npm_lifecycle_event === script) { console.error(`kibo-npm run: "${script}" would run itself forever; wrap a *different* script (e.g. ${script}:kibo)`); return 2; }
  const run = new BuildRun({ send, now, source: SOURCE, mode: reportingMode(env) });
  await run.start();
  const { cmd, shell } = npmInvocation(env, script, args, platform);
  const { code, signal } = await spawnAndWait(cmd, { platform, env: childEnv(env), shell, spawnImpl });
  const r = await run.finish(classifyExit(code, signal));
  if (verbose && r.sent && !r.ok) console.error(`kibo-npm: not delivered (${r.reason})`);
  return exitCodeFor(code, signal);
}

/* -------------------------------------------------------------- hook mode */

/** `prebuild` -> `build`. Null if the event is not a `<prefix><script>` lifecycle event. */
export function lifecycleScript(event, prefix) {
  return typeof event === "string" && event.length > prefix.length && event.startsWith(prefix) ? event.slice(prefix.length) : null;
}

/** Marker location: hash of (normalised project folder, script). Contains no path, only a timestamp. */
export function markerPath(cwd, script, { tmp = os.tmpdir(), platform = process.platform } = {}) {
  const id = crypto.createHash("sha256").update(`${projectKey(cwd, platform)}\n${script}`).digest("hex").slice(0, 20);
  return path.join(tmp, `kibo-npm-${id}.json`);
}

function writeMarker(file, startedAt) {
  try { fs.writeFileSync(file, JSON.stringify({ v: 1, startedAt }), { mode: 0o600 }); return true; } catch { return false; }
}

/** Reads and deletes the marker in one step, so a second `post` finds nothing (no duplicate success). */
export function takeMarker(file, nowMs, maxAgeMs = MARKER_MAX_AGE_MS) {
  const mine = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try { fs.renameSync(file, mine); } catch { return null; }          // missing, or another `post` won the race
  try {
    const { startedAt } = JSON.parse(fs.readFileSync(mine, "utf8"));
    const age = nowMs - startedAt;
    return Number.isFinite(startedAt) && age >= 0 && age <= maxAgeMs ? startedAt : null;
  } catch { return null; } finally { try { fs.rmSync(mine, { force: true }); } catch { /* ignore */ } }
}

export async function hookPre({ env = process.env, cwd = process.cwd(), now = Date.now, send = safeReport, tmp, platform } = {}) {
  const script = lifecycleScript(env.npm_lifecycle_event, "pre");
  if (!script) return { sent: false, reason: "not-a-pre-hook" };
  const mode = reportingMode(env);
  if (mode !== "on") return { sent: false, reason: mode === "off" ? "disabled" : "nested" };
  writeMarker(markerPath(cwd, script, { tmp, platform }), now());
  return { sent: true, ...(await send("build_started", { source: SOURCE })) };
}

export async function hookPost({ env = process.env, cwd = process.cwd(), now = Date.now, send = safeReport, tmp, platform } = {}) {
  const script = lifecycleScript(env.npm_lifecycle_event, "post");
  if (!script) return { sent: false, reason: "not-a-post-hook" };
  const mode = reportingMode(env);
  if (mode !== "on") return { sent: false, reason: mode === "off" ? "disabled" : "nested" };
  const startedAt = takeMarker(markerPath(cwd, script, { tmp, platform }), now());
  if (startedAt === null) return { sent: false, reason: "no-start-recorded" };   // never report a success that had no start
  const durationMs = Math.max(0, Math.min(now() - startedAt, MAX_DURATION_MS));
  return { sent: true, ...(await send("build_succeeded", { durationMs, source: SOURCE })) };
}

/* -------------------------------------------------------------------- CLI */

const USAGE = `Usage:
  kibo-npm run <script> [args...]    run "npm run <script>" and report started / succeeded / failed from its real exit code
  kibo-npm pre                       use as "pre<script>":  reports build_started   (limited mode)
  kibo-npm post                      use as "post<script>": reports build_succeeded (limited mode; npm never runs it after a failure)
Set KIBO_REPORT_DISABLE=1 to silence, KIBO_REPORT_VERBOSE=1 to see why an event was not delivered.`;

export async function main(argv, env = process.env) {
  const verbose = env.KIBO_REPORT_VERBOSE === "1";
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === "run") return runScript(rest[0], rest.slice(1), { env, verbose });
  if (cmd === "pre" || cmd === "post") {
    const r = await (cmd === "pre" ? hookPre : hookPost)({ env });
    if (r.reason === "not-a-pre-hook" || r.reason === "not-a-post-hook") {
      console.error(`kibo-npm ${cmd}: must run as the npm "${cmd}<script>" lifecycle script (e.g. "${cmd}build")`);
      return 2;
    }
    if (verbose) console.error(`kibo-npm ${cmd}: ${r.sent ? (r.ok ? "delivered" : `not delivered (${r.reason})`) : `nothing sent (${r.reason})`}`);
    return 0;                                   // a hook can never fail the build
  }
  console.error(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
