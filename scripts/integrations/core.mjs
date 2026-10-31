/**
 * Shared building blocks for Kibo's optional build integrations (npm, Vite, ...).
 * Dependency-free and side-effect-free on import. Nothing here talks to Kibo directly: callers inject `send`
 * (normally `report()` from ../kibo-report.mjs), which keeps everything unit-testable.
 *
 * Rules every integration follows:
 *   1. The *outermost* reporter owns a build. Anything started by a reporter inherits KIBO_REPORT_ACTIVE=1 and
 *      stays silent, so one build never produces two "started" or two "finished" events.
 *   2. At most one terminal event (succeeded | failed) per run, never one without a start, never both.
 *   3. A cancelled run (Ctrl+C / signal) reports nothing rather than a guess.
 *   4. Reporting can never change the wrapped command's exit code or break it.
 *   5. Only event type, duration and a short source label ever leave the process. No output, no command line.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_DURATION_MS = 86_400_000;
/** Set (to "1") in the environment of everything a reporter starts: nested reporters then stay silent. */
export const ACTIVE_ENV = "KIBO_REPORT_ACTIVE";
/** Set to "1" to turn off every wrapper / hook / plugin without touching any project file. */
export const DISABLE_ENV = "KIBO_REPORT_DISABLE";
/** Windows exit status for a console process ended with Ctrl+C (STATUS_CONTROL_C_EXIT). */
export const WIN_CTRL_C = 0xc000013a;

/** "off" = kill switch, "nested" = an outer reporter already owns this build, "on" = report. */
export function reportingMode(env = process.env) {
  if (env[DISABLE_ENV] === "1") return "off";
  if (env[ACTIVE_ENV] === "1") return "nested";
  return "on";
}

export const childEnv = (env = process.env) => ({ ...env, [ACTIVE_ENV]: "1" });

/** Maps how a process ended to what Kibo may be told. Never guesses: cancellations are their own class. */
export function classifyExit(code, signal) {
  if (signal) return "cancelled";
  if (code === WIN_CTRL_C) return "cancelled";
  return code === 0 ? "success" : "failure";
}

/** Exit code to hand back to the caller (the wrapped command's own code, 130 for a signal). */
export const exitCodeFor = (code, signal) => (signal ? 130 : (code ?? 1));

/**
 * One build, seen from one process. Enforces the event rules above no matter how callers misbehave.
 *   idle --start()--> started --finish("success"|"failure")--> done
 */
export class BuildRun {
  constructor({ send, now = Date.now, source, mode = "on", alreadyStarted = false }) {
    this.send = send; this.now = now; this.source = source; this.mode = mode;
    this.state = alreadyStarted ? "started" : "idle";
    this.t0 = alreadyStarted ? this.now() : null;   // the clock is read when the run actually starts
  }

  async start() {
    if (this.mode !== "on") return { sent: false, reason: this.mode === "off" ? "disabled" : "nested" };
    if (this.state !== "idle") return { sent: false, reason: "already-started" };
    this.state = "started";                       // set before awaiting: a re-entrant call cannot double-send
    this.t0 = this.now();
    return { sent: true, ...(await this.send("build_started", { source: this.source })) };
  }

  /** @param {"success"|"failure"|"cancelled"} outcome */
  async finish(outcome) {
    if (this.mode !== "on") return { sent: false, reason: this.mode === "off" ? "disabled" : "nested" };
    if (this.state === "idle") return { sent: false, reason: "not-started" };
    if (this.state === "done") return { sent: false, reason: "already-finished" };
    this.state = "done";                          // a cancelled run is also over: nothing may follow it
    if (outcome === "cancelled") return { sent: false, reason: "cancelled" };
    const durationMs = Math.max(0, Math.min(this.now() - this.t0, MAX_DURATION_MS));
    const event = outcome === "success" ? "build_succeeded" : "build_failed";
    return { sent: true, ...(await this.send(event, { durationMs, source: this.source })) };
  }
}

/**
 * For tools that may run several builds in one process (Vite client + SSR, multiple environments).
 * begin()/end() bracket every sub-build; one start is sent for the first, and ONE success only after all of them
 * finished (plus a short grace period in case another sub-build starts right away). A failure is terminal at once.
 */
export function createMultiBuildReporter({ send, now = Date.now, source, mode = "on", graceMs = 250, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = 0, run = null, timer = null;
  const cancelTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const fresh = () => new BuildRun({ send, now, source, mode });
  return {
    async begin() {
      if (mode !== "on") return;
      cancelTimer();
      active++;
      if (!run || run.state === "done") { run = fresh(); await run.start(); }
    },
    async fail() {
      if (mode !== "on" || !run) return;
      cancelTimer();
      await run.finish("failure");
    },
    end() {
      if (mode !== "on" || !run) return;
      active = Math.max(0, active - 1);
      if (active > 0 || run.state !== "started") return;
      cancelTimer();
      const r = run;
      timer = setTimer(() => { timer = null; void r.finish("success"); }, graceMs);  // left ref'd on purpose: keeps the process alive until sent
    },
  };
}

/** cmd.exe-safe quoting for the Windows shell path (spaces and metacharacters). */
export const quoteWin = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * Runs a command with inherited stdio (its output is never read) and resolves how it ended.
 * Windows defaults to a shell (needed for .cmd shims such as npm.cmd); pass shell:false for a real executable.
 */
export function spawnAndWait(cmdArgs, { platform = process.platform, env = process.env, shell, spawnImpl = spawn } = {}) {
  const useShell = shell ?? platform === "win32";
  const child = useShell
    ? spawnImpl(cmdArgs.map(quoteWin).join(" "), [], { stdio: "inherit", shell: true, env })
    : spawnImpl(cmdArgs[0], cmdArgs.slice(1), { stdio: "inherit", env });
  return new Promise((resolve) => {
    child.on("error", () => resolve({ code: 127, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Stable per-project key: the same folder spelled `C:\Projects\App`, `c:/projects/app/` or with a trailing slash
 * gives the same key on Windows (case-insensitive file system). Uses the *target* platform's path rules.
 */
export function projectKey(cwd, platform = process.platform) {
  return platform === "win32" ? path.win32.resolve(cwd).toLowerCase() : path.posix.resolve(cwd);
}

/**
 * True when `metaUrl` is the script node was started with. Resolves symlinks/junctions and ignores case on
 * Windows, so a wrapper can never silently turn into a no-op (and skip the build) because of a path spelling.
 */
export function isMainModule(metaUrl, argv1, platform = process.platform) {
  if (!argv1) return false;
  try {
    const a = fs.realpathSync(fileURLToPath(metaUrl));
    const b = fs.realpathSync(path.resolve(argv1));
    return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}
