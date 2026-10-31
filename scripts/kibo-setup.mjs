#!/usr/bin/env node
/**
 * kibo-setup (also installable as the `kibo` command, see README): explicit, reversible opt-in for Kibo's automatic
 * build reporting. Reporting is configured PER PROJECT; nothing is detected or hooked globally.
 *
 *   kibo status  [--project DIR]     is this project configured? is Kibo running? is the kill switch on?
 *   kibo enable  [--script build] [--mode wrapper|hooks] [--project DIR] [--apply]
 *   kibo disable [--script build] [--project DIR] [--apply]
 *   kibo scan    [DIR ...] [--depth N]   read-only overview: which projects below DIR have reporting enabled
 *   kibo vite | cargo                print setup instructions (nothing is changed)
 *   (`kibo npm status|enable|disable ...` is the long form of the first three and keeps working)
 *
 * enable/disable always show the exact change first. In an interactive terminal they then ask "Apply? [y/N]";
 * anywhere else (scripts, CI, pipes) nothing is written unless --apply is given. With consent the ONLY file touched is the
 * target project's package.json ("scripts" section). It never edits shell profiles, global npm config or anything
 * outside that file, and it does not read your source code. `disable` restores the original script byte for byte.
 * `scan` only reads package.json files below the folder(s) you name; it writes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { discoveryPath } from "./kibo-report.mjs";
import { SCRIPT_RE } from "./kibo-npm.mjs";
import { isMainModule } from "./integrations/core.mjs";

export const WRAP_SUFFIX = ":kibo";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIBO_NPM = path.join(HERE, "kibo-npm.mjs");

/* ------------------------------------------------------------ pure logic */

/** Path to write into package.json: relative when kibo-npm.mjs lives inside the project (commit-safe), else absolute. */
export function reporterRef(projectDir, kiboNpmPath = KIBO_NPM, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const rel = p.relative(projectDir, kiboNpmPath);
  const outside = rel === "" || rel === ".." || rel.startsWith(".." + p.sep) || p.isAbsolute(rel);
  return (outside ? kiboNpmPath : rel).replace(/\\/g, "/");     // forward slashes work in node on every OS
}

export const commandFor = (ref, rest) => `node ${/\s/.test(ref) ? `"${ref}"` : ref} ${rest}`;
const CMD_RE = /^node\s+(?:"([^"]+)"|(\S+))\s+(run\s+\S+|pre|post)$/;

/** Recognises a command this tool wrote: { ref, kind: "run"|"pre"|"post", target? } or null. */
export function parseKiboCommand(cmd) {
  const m = typeof cmd === "string" ? CMD_RE.exec(cmd.trim()) : null;
  if (!m) return null;
  const ref = m[1] ?? m[2];
  if (path.posix.basename(ref.replace(/\\/g, "/")) !== "kibo-npm.mjs") return null;
  const [kind, target] = m[3].split(/\s+/);
  return { ref, kind, target };
}

/** Rebuilds `scripts` in the original key order, applying edits (key -> new value, or null to delete) and inserts. */
function rebuild(scripts, { set = {}, before = {}, after = {} }) {
  const out = {};
  for (const key of Object.keys(scripts)) {
    for (const [k, v] of Object.entries(before)) if (before[k] && key === v.anchor) out[k] = v.value;
    if (!(key in set)) out[key] = scripts[key]; else if (set[key] !== null) out[key] = set[key];
    for (const [k, v] of Object.entries(after)) if (key === v.anchor) out[k] = v.value;
  }
  return out;
}

/** @returns {{ problems: string[], warnings: string[], scripts: object, changed: boolean, noop: boolean }} noop = already in the requested state */
export function planEnable(scripts, { script, mode, ref }) {
  const r = { problems: [], warnings: [], scripts, changed: false, noop: false };
  if (!SCRIPT_RE.test(script)) { r.problems.push(`"${script}" is not a usable npm script name`); return r; }
  if (typeof scripts[script] !== "string") { r.problems.push(`package.json has no "${script}" script`); return r; }
  const cur = parseKiboCommand(scripts[script]);
  const pre = `pre${script}`, post = `post${script}`;
  const hooked = parseKiboCommand(scripts[pre])?.kind === "pre";
  if (cur?.kind === "run" || hooked) {
    const have = cur?.kind === "run" ? "wrapper" : "hooks";
    if (have === mode) { r.problems.push(`"${script}" already uses Kibo ${have === "wrapper" ? "the wrapper" : "lifecycle hooks"} (nothing to do)`); r.noop = true; }
    else r.problems.push(`"${script}" already uses Kibo ${have} mode; run "kibo-setup npm disable --script ${script}" first to switch to ${mode} mode`);
    return r;
  }
  if (/^(dev|start|serve|watch)\b/.test(script) || /:(dev|watch|serve)$/.test(script)) {
    r.warnings.push(`"${script}" looks like a long-running script. It never "finishes", so Kibo would only ever see a start. Wrap build-like scripts only.`);
  }
  if (mode === "wrapper") {
    const raw = `${script}${WRAP_SUFFIX}`;
    if (raw in scripts) { r.problems.push(`"${raw}" already exists; refusing to overwrite it`); return r; }
    for (const h of [pre, post]) if (h in scripts) r.warnings.push(`"${h}" exists and keeps running around "${script}", outside the part Kibo measures. A failing "${pre}" is not reported.`);
    r.scripts = rebuild(scripts, { set: { [script]: commandFor(ref, `run ${raw}`) }, after: { [raw]: { anchor: script, value: scripts[script] } } });
  } else if (mode === "hooks") {
    for (const h of [pre, post]) if (h in scripts) r.problems.push(`"${h}" already exists; refusing to overwrite it. Add \`${commandFor(ref, h === pre ? "pre" : "post")}\` to it yourself (first / last in the command).`);
    if (r.problems.length) return r;
    r.warnings.push(`hooks mode reports "started" and "succeeded" only. npm skips "${post}" when "${script}" fails, so a failed build is NOT reported (use --mode wrapper for that).`);
    r.warnings.push(`"npm run ${script} --ignore-scripts" skips the hooks, and so skips reporting.`);
    r.scripts = rebuild(scripts, { before: { [pre]: { anchor: script, value: commandFor(ref, "pre") } }, after: { [post]: { anchor: script, value: commandFor(ref, "post") } } });
  } else { r.problems.push(`unknown mode "${mode}" (use wrapper or hooks)`); return r; }
  r.changed = true;
  return r;
}

export function planDisable(scripts, { script }) {
  const r = { problems: [], warnings: [], scripts, changed: false, noop: false };
  const set = {};
  const cur = parseKiboCommand(scripts[script]);
  if (cur?.kind === "run") {
    const raw = cur.target;
    if (raw !== `${script}${WRAP_SUFFIX}` || typeof scripts[raw] !== "string") {
      r.problems.push(`"${script}" calls "${raw}", which this tool did not create or which is missing; edit package.json by hand`);
      return r;
    }
    set[script] = scripts[raw]; set[raw] = null;
  }
  for (const [h, kind] of [[`pre${script}`, "pre"], [`post${script}`, "post"]]) {
    if (!(h in scripts)) continue;
    if (parseKiboCommand(scripts[h])?.kind === kind) set[h] = null;
    else if (/kibo-npm/.test(String(scripts[h]))) r.warnings.push(`"${h}" mentions kibo-npm but is customised; remove that part by hand`);
  }
  if (!Object.keys(set).length) { r.problems.push(`no Kibo integration found on "${script}" (nothing to do)`); r.noop = true; return r; }
  r.scripts = rebuild(scripts, { set });
  r.changed = true;
  return r;
}

/** Lists every Kibo integration in `scripts` plus problems (e.g. the referenced file no longer exists). */
export function scanScripts(scripts, { projectDir, exists = fs.existsSync, platform = process.platform }) {
  const found = [], issues = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    const k = parseKiboCommand(cmd);
    if (!k) continue;
    found.push({ name, ...k });
    const p = platform === "win32" ? path.win32 : path.posix;
    const abs = p.isAbsolute(k.ref) ? k.ref : p.resolve(projectDir, k.ref);
    if (!exists(abs)) issues.push(`"${name}" points to ${k.ref}, which does not exist: the build would FAIL until you run "kibo-setup npm disable"`);
    if (k.kind === "run" && typeof scripts[k.target] !== "string") issues.push(`"${name}" runs "${k.target}", which is not defined`);
  }
  return { found, issues };
}

/* ------------------------------------------------------------ file access */

export function readPackage(dir) {
  const file = path.join(dir, "package.json");
  const text = fs.readFileSync(file, "utf8");
  return { file, text, pkg: JSON.parse(text), eol: text.includes("\r\n") ? "\r\n" : "\n", indent: /^([ \t]+)"/m.exec(text)?.[1] ?? "  ", finalNewline: /\n$/.test(text) };
}

export function serializePackage({ pkg, eol, indent, finalNewline }, scripts) {
  const body = JSON.stringify({ ...pkg, scripts }, null, indent).replace(/\n/g, eol);
  return body + (finalNewline ? eol : "");
}

/* ------------------------------------------------------------ scan (read-only) */

/** Folders never entered while scanning: dependencies and build output. Dot-folders and symlinks are skipped too. */
const SCAN_SKIP = new Set(["node_modules", "dist", "out", "target", "coverage"]);
export const SCAN_LIMITS = { depth: 2, maxDepth: 5, maxDirs: 2000 };

/**
 * Finds the folders below `root` that contain a package.json. Read-only: it lists directories, nothing more.
 * Bounded by depth and by the number of folders visited, so pointing it at a huge tree stays quick; `truncated` says so.
 * @returns {{ dirs: string[], truncated: boolean }}
 */
export function findProjectDirs(root, { depth = SCAN_LIMITS.depth, maxDirs = SCAN_LIMITS.maxDirs, readdir = (d) => fs.readdirSync(d, { withFileTypes: true }) } = {}) {
  const dirs = [];
  let visited = 0, truncated = false;
  const walk = (dir, level) => {
    if (truncated) return;
    if (++visited > maxDirs) { truncated = true; return; }
    let entries;
    try { entries = readdir(dir); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === "package.json")) dirs.push(dir);
    if (level >= depth) return;
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".") || SCAN_SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return { dirs, truncated };
}

const hookScriptName = (name, kind) => (name.startsWith(kind) && name.length > kind.length ? name.slice(kind.length) : name);

/** What one project's package.json says about Kibo. state: "on" | "off" | "unreadable". Reads only package.json. */
export function summarizeProject(dir, { exists = fs.existsSync, platform = process.platform } = {}) {
  let pkg;
  try { pkg = readPackage(dir).pkg; } catch { return { dir, state: "unreadable", integrations: [], hasBuild: false, issues: [] }; }
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  const { found, issues } = scanScripts(scripts, { projectDir: dir, exists, platform });
  const seen = new Map();
  for (const f of found) {
    const mode = f.kind === "run" ? "wrapper" : "hooks";
    const script = f.kind === "run" ? f.name : hookScriptName(f.name, f.kind);
    seen.set(`${script}/${mode}`, { script, mode });
  }
  return { dir, state: found.length ? "on" : "off", integrations: [...seen.values()], hasBuild: typeof scripts.build === "string", issues };
}

function runScan(args, { out, err }) {
  const roots = [], errors = [];
  let depth = SCAN_LIMITS.depth;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--depth") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 0 || n > SCAN_LIMITS.maxDepth) errors.push(`--depth needs a whole number from 0 to ${SCAN_LIMITS.maxDepth}`);
      else depth = n;
    } else if (a.startsWith("-")) errors.push(`unknown option: ${a}`);
    else roots.push(path.resolve(a));
  }
  if (errors.length) { err(errors.join("\n") + "\n" + USAGE); return 2; }
  if (!roots.length) roots.push(process.cwd());

  let code = 0, scanned = false;
  const reported = new Set();
  for (const root of [...new Set(roots)]) {
    let isDir = false;
    try { isDir = fs.statSync(root).isDirectory(); } catch { /* reported below */ }
    if (!isDir) { err(`not a folder: ${root}`); code = 1; continue; }
    if (path.parse(root).root === root) { err(`refusing to scan a drive/filesystem root (${root}); name the folder that holds your projects`); code = 1; continue; }
    scanned = true;
    const { dirs, truncated } = findProjectDirs(root, { depth });
    const list = dirs.filter((d) => !reported.has(d)).map((d) => (reported.add(d), summarizeProject(d)));
    out(`Scanned ${root} (depth ${depth}): ${list.length} folder${list.length === 1 ? "" : "s"} with a package.json`);
    for (const p of list) {
      const what = p.state === "on" ? p.integrations.map((i) => `${i.script} (${i.mode})`).join(", ")
        : p.state === "unreadable" ? "package.json unreadable"
        : p.hasBuild ? 'has a "build" script' : 'no "build" script';
      out(`  ${p.state === "on" ? "ON " : p.state === "off" ? "off" : "?  "}  ${what.padEnd(26)} ${p.dir}`);
      for (const i of p.issues) { out(`        PROBLEM: ${i}`); code = 1; }
    }
    const count = (state) => list.filter((p) => p.state === state).length;
    out(`  ${count("on")} with automatic reporting, ${count("off")} without${count("unreadable") ? `, ${count("unreadable")} unreadable (state unknown)` : ""}.${truncated ? ` Stopped after ${SCAN_LIMITS.maxDirs} folders: name a narrower folder.` : ""}`);
  }
  if (scanned) out('Only folders with a package.json are listed. "ON" means that project\'s package.json calls Kibo; run "kibo status --project DIR" for details.');
  return code;
}

/* -------------------------------------------------------------------- CLI */

const GUIDE = {
  vite: `Vite (opt-in, only the Vite bundling step):
  1. In vite.config.ts add:   import kibo from "<path to Kibo>/scripts/integrations/vite.mjs";
                              plugins: [..., kibo()]
  2. Reports "vite build" start, success, and failure of the bundler. Nothing else (not tsc, not "vite" dev, not watch mode).
  3. If the kibo-npm wrapper or "kibo-report run" already wraps the build, the plugin stays silent.
  4. Disable: remove the plugin line, or set KIBO_REPORT_DISABLE=1.`,
  cargo: `Cargo / Rust: Cargo has no official "build finished" hook, and Kibo will not wrap rustc or watch processes.
  * One-off:       node scripts/kibo-report.mjs run --source cargo -- cargo build --release
  * Every time:    add "rust:build": "cargo build" to package.json, then:  kibo-setup enable --script rust:build
  * Tauri:         add "tauri:build": "tauri build", then  kibo-setup enable --script tauri:build
  Plain "cargo build" typed in a terminal is NOT detected.`,
};

const USAGE = `Kibo build reporting is opt-in, per project. Nothing is detected automatically.

Usage:
  kibo status  [--project DIR]     is this project set up? is Kibo running? is the kill switch on?
  kibo enable  [--script build] [--mode wrapper|hooks] [--project DIR] [--apply]
                                   shows the exact package.json change, then asks before applying it
  kibo disable [--script build] [--project DIR] [--apply]
  kibo scan    [DIR ...] [--depth N]   read-only: which projects below DIR have reporting enabled
  kibo vite | cargo                setup notes for those tools (changes nothing)
("kibo-setup" is the same command; "kibo npm status|enable|disable" is the long form.)
In a terminal, enable/disable ask before writing. In scripts and CI nothing is written without --apply.
Turn all reporting off without touching any file: KIBO_REPORT_DISABLE=1.`;

/** How to type this tool again: `kibo` / `kibo-setup` when run from PATH (npm link), else `node "<path>"`. Used only in hints. */
export function selfCommand(argv1 = process.argv[1]) {
  const base = argv1 ? argv1.split(/[\\/]/).pop().replace(/\.(cmd|exe)$/i, "") : "";   // both separators: correct for Windows paths on any host
  if (base === "kibo" || base === "kibo-setup") return base;
  if (base === "kibo-setup.mjs") return `node ${/\s/.test(argv1) ? `"${argv1}"` : argv1}`;
  return "kibo-setup";
}
const portableNote = (me) => `The command points to Kibo by an absolute path, so it only works on this machine. Do not commit this package.json to a shared repo: run "${me} disable --apply" first, or keep Kibo's scripts/ folder inside the repo (then the path is relative).`;
const isAbsoluteRef = (ref) => /^(?:[A-Za-z]:[\\/]|\/)/.test(ref);

function parseArgs(argv) {
  const o = { script: "build", mode: "wrapper", project: process.cwd(), apply: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--script") o.script = argv[++i] ?? "";
    else if (a === "--mode") o.mode = argv[++i] ?? "";
    else if (a === "--project") o.project = path.resolve(argv[++i] ?? "");
    else o.errors.push(`unknown option: ${a}`);
  }
  return o;
}

/**
 * Runs one command. Returns { code, pending? }. `pending` is only returned when `interactive` is true and a change is
 * waiting for the user's consent: { prompt, apply() }. Nothing is written until apply() is called.
 */
export function execute(argv, { out = console.log, err = console.error, env = process.env, interactive = false, me = selfCommand(), writeFile = fs.writeFileSync } = {}) {
  const args = ["status", "enable", "disable"].includes(argv[0]) ? ["npm", ...argv] : argv;   // `kibo enable` = `kibo npm enable`
  const [area, action, ...rest] = args;
  if (!area || area === "-h" || area === "--help" || area === "help") { out(USAGE); return { code: area ? 0 : 2 }; }
  if (area === "vite" || area === "cargo") { out(GUIDE[area]); return { code: 0 }; }
  if (area === "scan") return { code: runScan(args.slice(1), { out, err }) };
  if (area !== "npm" || !["status", "enable", "disable"].includes(action)) { err(`${USAGE}`); return { code: 2 }; }
  const o = parseArgs(rest);
  if (o.errors.length) { err(o.errors.join("\n") + "\n" + USAGE); return { code: 2 }; }

  let pkgInfo;
  try { pkgInfo = readPackage(o.project); } catch { err(`cannot read ${path.join(o.project, "package.json")}\nRun this inside a project folder or pass --project DIR (to find projects: ${me} scan <folder>).`); return { code: 1 }; }
  const scripts = pkgInfo.pkg.scripts ?? {};

  if (action === "status") {
    const { found, issues } = scanScripts(scripts, { projectDir: o.project });
    out(`Project: ${o.project}`);
    if (!found.length) out(`No Kibo integration configured in package.json (nothing is reported automatically).\n  To set it up: ${me} enable   (shows the change first, asks before applying).`);
    for (const f of found) out(`  ${f.name}: ${f.kind === "run" ? `wrapper -> "${f.target}"` : `${f.kind} hook`}   (${f.ref})`);
    for (const i of issues) out(`  PROBLEM: ${i}`);
    if (found.some((f) => isAbsoluteRef(f.ref))) out(`Note: ${portableNote(me)}`);
    out(`Kibo running: ${fs.existsSync(discoveryPath(env)) ? "yes (discovery file found)" : "no discovery file (start Kibo)"}`);
    if (env.KIBO_REPORT_DISABLE === "1") out("KIBO_REPORT_DISABLE=1 is set in this shell: all automatic reporting is OFF here.");
    out(`Other projects: ${me} scan <folder>`);
    return { code: issues.length ? 1 : 0 };
  }

  const ref = reporterRef(o.project);
  const plan = action === "enable" ? planEnable(scripts, { script: o.script, mode: o.mode, ref }) : planDisable(scripts, { script: o.script });
  for (const p of plan.problems) (plan.noop ? out : err)(`Not changed: ${p}`);
  for (const w of plan.warnings) out(`Note: ${w}`);
  if (!plan.changed) return { code: plan.noop ? 0 : 1 };

  out(`Planned changes to ${pkgInfo.file}:`);
  for (const k of new Set([...Object.keys(scripts), ...Object.keys(plan.scripts)])) {
    if (scripts[k] === plan.scripts[k]) continue;
    if (k in scripts) out(`  - "${k}": ${JSON.stringify(scripts[k])}`);
    if (k in plan.scripts) out(`  + "${k}": ${JSON.stringify(plan.scripts[k])}`);
  }
  if (action === "enable" && isAbsoluteRef(ref)) out(`Note: ${portableNote(me)}`);

  const commit = () => {
    try { writeFile(pkgInfo.file, serializePackage(pkgInfo, plan.scripts)); } catch (e) { err(`Could not write ${pkgInfo.file}: ${e instanceof Error ? e.message : e}`); return 1; }
    out(action === "enable" ? `Done. Undo with: ${me} disable --script ${o.script}` : `Done. Kibo reporting removed from "${o.script}".`);
    return 0;
  };
  if (o.apply) return { code: commit() };
  if (interactive) return { code: 0, pending: { prompt: `Edit only ${pkgInfo.file} as shown?`, apply: commit } };
  out("No files were changed. Re-run with --apply to make this change.");
  return { code: 0 };
}

/** Synchronous, never prompts: nothing is written without --apply. Kept for scripts and tests. */
export const main = (argv, io) => execute(argv, { ...io, interactive: false }).code;

/** A person at a terminal (not a pipe, not CI) can be asked. */
export const isInteractive = (env = process.env) => Boolean(process.stdin.isTTY && process.stdout.isTTY) && !env.CI;

/** Asks a yes/no question; anything but y/yes (including Ctrl+C / end of input) means no. */
export function askYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let answered = false;
    const done = (v) => { if (!answered) { answered = true; rl.close(); resolve(v); } };
    rl.on("close", () => done(false));
    rl.on("SIGINT", () => done(false));
    rl.question(`${question} [y/N] `, (a) => done(/^\s*y(es)?\s*$/i.test(a)));
  });
}

/** CLI entry: like main(), but in an interactive terminal it asks for consent instead of requiring --apply. */
export async function cli(argv, { ask = askYesNo, interactive = isInteractive(), ...io } = {}) {
  const r = execute(argv, { ...io, interactive });
  if (!r.pending) return r.code;
  if (await ask(r.pending.prompt)) return r.pending.apply();
  (io.out ?? console.log)("No files were changed.");
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) cli(process.argv.slice(2)).then((c) => process.exit(c));
