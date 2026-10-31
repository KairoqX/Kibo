// Onboarding: short commands, consent prompt, read-only scan, hints, bin entries. Complements kibo-setup.test.mjs, which is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { askYesNo, cli, commandFor, execute, findProjectDirs, isInteractive, main, selfCommand, summarizeProject } from "./kibo-setup.mjs";
import { cleanEnv, fwd, makeProject, mockKibo, runNpm } from "./testing/helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const REAL_NPM_SCRIPT = path.join(HERE, "kibo-npm.mjs");
const ON = commandFor(fwd(REAL_NPM_SCRIPT), "run build:kibo");          // a wrapper command pointing at a file that exists
const BUILD = `node -e "process.exit(Number(process.env.EXIT||0))"`;
const WIN = process.platform === "win32";

/** Runs a command in-process and captures its output. */
function run(argv, extra = {}) {
  const out = [], err = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, me: "kibo", ...extra });
  return { code, out, err, text: out.join("\n"), errText: err.join("\n") };
}

const put = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
};
const pkg = (scripts) => ({ name: "x", private: true, scripts });

/** content hash + mtime of every file below root: proves "nothing was written". */
function snapshot(root) {
  const snap = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) snap[path.relative(root, p)] = `${crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")}@${fs.statSync(p).mtimeMs}`;
    }
  };
  walk(root);
  return snap;
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

/* --------------------------------------------------------------- short commands */

test("`kibo status|enable|disable` are exact aliases of `kibo npm status|enable|disable`", () => {
  const a = makeProject({ build: "tsc && vite build", test: "t" }), b = makeProject({ build: "tsc && vite build", test: "t" });
  try {
    for (const verb of ["status", "enable"]) {
      const short = run([verb, "--project", a.dir]), long = run(["npm", verb, "--project", b.dir]);
      assert.equal(short.code, long.code, verb);
      assert.equal(short.text.replaceAll(a.dir, "<P>"), long.text.replaceAll(b.dir, "<P>"), verb);
    }
    assert.equal(run(["enable", "--project", a.dir, "--apply"]).code, 0);
    assert.equal(run(["npm", "enable", "--project", b.dir, "--apply"]).code, 0);
    assert.equal(fs.readFileSync(path.join(a.dir, "package.json"), "utf8"), fs.readFileSync(path.join(b.dir, "package.json"), "utf8"));
    assert.equal(run(["disable", "--project", a.dir, "--apply"]).code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.dir, "package.json"), "utf8")).scripts, { build: "tsc && vite build", test: "t" });
  } finally { a.cleanup(); b.cleanup(); }
});

test("help and bad usage: `help` / --help exit 0, nothing or an unknown command exits 2, and the usage names every command", () => {
  for (const arg of ["help", "--help", "-h"]) { const r = run([arg]); assert.equal(r.code, 0); for (const w of ["status", "enable", "disable", "scan", "KIBO_REPORT_DISABLE", "--apply"]) assert.match(r.text, new RegExp(w)); }
  assert.equal(run([]).code, 2);
  assert.equal(run(["explode"]).code, 2);
  assert.equal(run(["scan", "--bogus"]).code, 2);
});

test("selfCommand: hints are copy-pasteable for however the tool was started", () => {
  assert.equal(selfCommand("/usr/local/bin/kibo"), "kibo");
  assert.equal(selfCommand("/usr/local/bin/kibo-setup"), "kibo-setup");
  assert.equal(selfCommand("C:\\Users\\me\\AppData\\Roaming\\npm\\kibo.cmd"), "kibo");
  assert.equal(selfCommand("/opt/Kibo/scripts/kibo-setup.mjs"), "node /opt/Kibo/scripts/kibo-setup.mjs");
  assert.equal(selfCommand("/opt/My Tools/scripts/kibo-setup.mjs"), 'node "/opt/My Tools/scripts/kibo-setup.mjs"');
  assert.equal(selfCommand("/somewhere/test-runner.mjs"), "kibo-setup");
  assert.equal(selfCommand(undefined), "kibo-setup");
});

/* --------------------------------------------------------------- consent */

test("consent: dry run is the default outside a terminal; main() never prompts or writes without --apply", () => {
  const p = makeProject({ build: "vite build" });
  try {
    const before = snapshot(p.dir);
    const r = run(["enable", "--project", p.dir], { interactive: true });         // main() ignores `interactive` by design
    assert.equal(r.code, 0); assert.match(r.text, /No files were changed\. Re-run with --apply/);
    assert.deepEqual(snapshot(p.dir), before);
  } finally { p.cleanup(); }
});

test("consent: in an interactive terminal the plan is shown, nothing is written until the user says yes", async () => {
  const p = makeProject({ build: "vite build", test: "t" });
  const file = path.join(p.dir, "package.json");
  const original = fs.readFileSync(file, "utf8");
  try {
    const out = [];
    const r = execute(["enable", "--project", p.dir], { out: (l) => out.push(l), err: () => {}, env: {}, interactive: true, me: "kibo" });
    assert.equal(r.code, 0); assert.ok(r.pending);
    assert.match(out.join("\n"), /Planned changes/);
    assert.doesNotMatch(out.join("\n"), /No files were changed/);                  // the prompt follows instead
    assert.match(r.pending.prompt, /package\.json/);
    assert.equal(fs.readFileSync(file, "utf8"), original);                         // still untouched while waiting

    // declined
    const asked = [], lines = [];
    assert.equal(await cli(["enable", "--project", p.dir], { interactive: true, ask: async (q) => (asked.push(q), false), out: (l) => lines.push(l), err: () => {}, env: {}, me: "kibo" }), 0);
    assert.equal(asked.length, 1); assert.match(lines.join("\n"), /No files were changed\.$/);
    assert.equal(fs.readFileSync(file, "utf8"), original);

    // accepted
    assert.equal(await cli(["enable", "--project", p.dir], { interactive: true, ask: async () => true, out: () => {}, err: () => {}, env: {}, me: "kibo" }), 0);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).scripts["build:kibo"], "vite build");
    // and the outcome is identical to --apply
    const q = makeProject({ build: "vite build", test: "t" });
    run(["enable", "--project", q.dir, "--apply"]);
    assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(path.join(q.dir, "package.json"), "utf8")); q.cleanup();
  } finally { p.cleanup(); }
});

test("consent: no prompt when not interactive, with --apply, or when there is nothing to change; unusable setups stay untouched", async () => {
  const never = async () => { throw new Error("must not ask"); };
  const quiet = { out: () => {}, err: () => {}, env: {}, me: "kibo", ask: never };
  const p = makeProject({ build: "x" });
  const q = makeProject({ build: "x", "build:kibo": "keep me" });           // would clobber: must refuse, not ask
  const r = makeProject({ build: "x" });
  try {
    assert.equal(await cli(["enable", "--project", p.dir], { ...quiet, interactive: false }), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, "package.json"), "utf8")).scripts.build, "x");   // dry run only
    assert.equal(await cli(["enable", "--project", p.dir, "--apply"], { ...quiet, interactive: true }), 0);   // --apply = consent already given
    assert.match(JSON.parse(fs.readFileSync(path.join(p.dir, "package.json"), "utf8")).scripts.build, /kibo-npm\.mjs run build:kibo/);
    assert.equal(await cli(["enable", "--project", p.dir], { ...quiet, interactive: true }), 0);              // already enabled: nothing to ask
    const before = fs.readFileSync(path.join(q.dir, "package.json"), "utf8");
    assert.equal(await cli(["enable", "--project", q.dir], { ...quiet, interactive: true }), 1);               // refusal, never a prompt
    assert.equal(fs.readFileSync(path.join(q.dir, "package.json"), "utf8"), before);
    assert.equal(await cli(["status", "--project", r.dir], { ...quiet, interactive: true }), 0);
    assert.equal(await cli(["scan", r.dir], { ...quiet, interactive: true }), 0);
  } finally { p.cleanup(); q.cleanup(); r.cleanup(); }
});

test("askYesNo: only y / yes (any case) is consent; empty, anything else, or a closed input is a no", async () => {
  const ask = (answer) => {
    const input = new PassThrough(), output = new PassThrough();
    const result = askYesNo("Apply?", { input, output });
    if (answer === null) input.end(); else input.write(answer + "\n");
    return result;
  };
  for (const yes of ["y", "Y", "yes", "YES", " y "]) assert.equal(await ask(yes), true, yes);
  for (const no of ["", "n", "no", "yep", "ok", "sure", "1"]) assert.equal(await ask(no), false, JSON.stringify(no));
  assert.equal(await ask(null), false);                                           // Ctrl+D / closed stdin
});

test("isInteractive: only a real terminal on both ends, and never when CI is set", () => {
  const had = { i: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), o: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
  const setTTY = (i, o) => { Object.defineProperty(process.stdin, "isTTY", { value: i, configurable: true }); Object.defineProperty(process.stdout, "isTTY", { value: o, configurable: true }); };
  try {
    setTTY(true, true);   assert.equal(isInteractive({}), true);
    assert.equal(isInteractive({ CI: "true" }), false); assert.equal(isInteractive({ CI: "1" }), false);
    setTTY(false, true);  assert.equal(isInteractive({}), false);                  // stdin piped
    setTTY(true, false);  assert.equal(isInteractive({}), false);                  // stdout piped / redirected
    setTTY(undefined, undefined); assert.equal(isInteractive({}), false);
  } finally {
    for (const [stream, d] of [[process.stdin, had.i], [process.stdout, had.o]]) { if (d) Object.defineProperty(stream, "isTTY", d); else delete stream.isTTY; }
  }
});

/* --------------------------------------------------------------- safety */

test("enable touches only the chosen project's package.json: siblings, parent and every other file stay byte-identical", () => {
  const root = tmp("kibo-ws-");
  try {
    put(root, "package.json", pkg({ build: "root build" }));
    put(root, "a/package.json", pkg({ build: "a build", test: "t" }));
    put(root, "b/package.json", pkg({ build: "b build" }));
    put(root, "a/src/index.js", "console.log(1)");
    put(root, "b/notes.txt", "hi");
    const before = snapshot(root);
    assert.equal(run(["enable", "--project", path.join(root, "a"), "--apply"]).code, 0);
    const after = snapshot(root);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    assert.deepEqual(changed, [path.join("a", "package.json")]);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());       // no file created or removed anywhere
  } finally { rm(root); }
});

test("existing scripts are never overwritten, in either mode, with or without --apply", () => {
  const p = makeProject({ build: "x", "build:kibo": "mine", prebuild: "pre", postbuild: "post" });
  try {
    const before = fs.readFileSync(path.join(p.dir, "package.json"), "utf8");
    for (const mode of ["wrapper", "hooks"]) {
      const r = run(["enable", "--mode", mode, "--project", p.dir, "--apply"]);
      assert.equal(r.code, 1, mode); assert.match(r.errText, /refusing to overwrite/);
      assert.equal(fs.readFileSync(path.join(p.dir, "package.json"), "utf8"), before, mode);
    }
  } finally { p.cleanup(); }
});

test("a failed write (read-only file, full disk...) is reported, not thrown: exit 1, no success message, file untouched", () => {
  const p = makeProject({ build: "x" });
  try {
    const before = fs.readFileSync(path.join(p.dir, "package.json"), "utf8");
    const r = run(["enable", "--project", p.dir, "--apply"], { writeFile: () => { throw new Error("EACCES: permission denied"); } });
    assert.equal(r.code, 1); assert.match(r.errText, /Could not write .*package\.json: EACCES/);
    assert.doesNotMatch(r.text, /Done\./);
    assert.equal(fs.readFileSync(path.join(p.dir, "package.json"), "utf8"), before);
  } finally { p.cleanup(); }
});

/* --------------------------------------------------------------- hints + status */

test("status: tells you the next step when not set up, flags machine-specific paths, shows the kill switch", () => {
  const p = makeProject({ build: "x" });
  try {
    const none = run(["status", "--project", p.dir]);
    assert.match(none.text, /No Kibo integration configured.*nothing is reported automatically/s);
    assert.match(none.text, /kibo enable/); assert.match(none.text, /kibo scan <folder>/);
    assert.doesNotMatch(none.text, /KIBO_REPORT_DISABLE/);

    run(["enable", "--project", p.dir, "--apply"]);                                // wrapper -> absolute path (Kibo is outside the project)
    const on = run(["status", "--project", p.dir], { env: { KIBO_REPORT_DISABLE: "1" } });
    assert.match(on.text, /build: wrapper -> "build:kibo"/);
    assert.match(on.text, /absolute path.*only works on this machine/);
    assert.match(on.text, /KIBO_REPORT_DISABLE=1 is set in this shell: all automatic reporting is OFF here/);

    const rel = makeProject({ build: commandFor("scripts/kibo-npm.mjs", "run build:kibo"), "build:kibo": "x" }, { });
    fs.mkdirSync(path.join(rel.dir, "scripts")); fs.writeFileSync(path.join(rel.dir, "scripts", "kibo-npm.mjs"), "");
    assert.doesNotMatch(run(["status", "--project", rel.dir]).text, /absolute path/);   // relative = commit-safe: no warning
    rel.cleanup();
  } finally { p.cleanup(); }
});

test("enable warns before applying when the command would contain a machine-specific absolute path", () => {
  const p = makeProject({ build: "x" });
  try {
    const r = run(["enable", "--project", p.dir]);
    assert.match(r.text, /Note: .*absolute path.*Do not commit/s);
    assert.match(r.text, /kibo disable --apply/);
  } finally { p.cleanup(); }
});

test("running outside a project explains what to do instead of just failing", () => {
  const d = tmp("kibo-empty-");
  try {
    const r = run(["status", "--project", d]);
    assert.equal(r.code, 1); assert.match(r.errText, /cannot read .*package\.json/); assert.match(r.errText, /--project DIR/); assert.match(r.errText, /scan <folder>/);
  } finally { rm(d); }
});

/* --------------------------------------------------------------- scan */

function workspace() {
  const root = tmp("kibo-scan-");
  put(root, "a/package.json", pkg({ build: ON, "build:kibo": "vite build" }));                           // ON, wrapper
  put(root, "b/package.json", pkg({ build: "vite build" }));                                                // off, has build
  put(root, "c/package.json", pkg({ test: "t" }));                                                          // off, no build
  put(root, "bad/package.json", "{ this is not json");                                                      // unreadable
  put(root, "broken/package.json", pkg({ build: commandFor("gone/kibo-npm.mjs", "run build:kibo"), "build:kibo": "x" }));   // PROBLEM
  put(root, "hooked/package.json", pkg({ build: "x", prebuild: commandFor(fwd(REAL_NPM_SCRIPT), "pre"), postbuild: commandFor(fwd(REAL_NPM_SCRIPT), "post") }));
  put(root, "deep/d/package.json", pkg({ build: "x" }));                                                    // depth 2
  put(root, "deep/deeper/e/package.json", pkg({ build: "x" }));                                             // depth 4
  put(root, "node_modules/dep/package.json", pkg({ build: "x" }));                                          // skipped
  put(root, ".hidden/h/package.json", pkg({ build: "x" }));                                                 // skipped
  put(root, "dist/d/package.json", pkg({ build: "x" }));                                                    // skipped
  if (!WIN) fs.symlinkSync(path.join(root, "a"), path.join(root, "link"), "dir");                           // never followed
  return root;
}

test("scan: lists each project as ON / off, shows mode and problems, skips node_modules, dot-folders, build output and symlinks, writes nothing", () => {
  const root = workspace();
  try {
    const before = snapshot(root);
    const r = run(["scan", root]);
    const line = (name) => r.out.find((l) => l.endsWith(path.join(root, name)));
    assert.match(line("a"), /^  ON +build \(wrapper\)/);
    assert.match(line("hooked"), /^  ON +build \(hooks\)/);
    assert.match(line("b"), /^  off +has a "build" script/);
    assert.match(line("c"), /^  off +no "build" script/);
    assert.match(line("bad"), /unreadable/);
    assert.match(line("broken"), /^  ON /);
    assert.match(r.text, /PROBLEM: .*gone\/kibo-npm\.mjs.*does not exist/);
    assert.equal(r.code, 1);                                                       // a broken integration is an error exit
    assert.ok(line("deep/d".split("/").join(path.sep)));
    assert.equal(line(path.join("deep", "deeper", "e")), undefined);               // beyond default depth
    for (const skipped of ["node_modules", ".hidden", "dist", "link"]) assert.ok(!r.out.some((l) => l.includes(path.join(root, skipped))), skipped);
    assert.match(r.text, /7 folders with a package\.json/);
    assert.match(r.text, /3 with automatic reporting, 3 without, 1 unreadable \(state unknown\)\./);   // unknown is not counted as "without"
    assert.match(r.text, /Only folders with a package\.json are listed/);
    assert.deepEqual(snapshot(root), before);                                      // read-only: not a byte, not an mtime
  } finally { rm(root); }
});

test("scan: --depth reaches deeper projects, a healthy workspace exits 0, and the folder defaults to the current directory only when none is named", () => {
  const root = workspace();
  try {
    fs.rmSync(path.join(root, "broken"), { recursive: true });
    assert.ok(run(["scan", root, "--depth", "4"]).out.some((l) => l.endsWith(path.join(root, "deep", "deeper", "e"))));
    assert.equal(run(["scan", root]).code, 0);
    const none = run(["scan", root, "--depth", "0"]);                              // root itself has no package.json
    assert.match(none.text, /0 folders with a package\.json/);
    const bad = run(["scan", root, "--depth", "9"]); assert.equal(bad.code, 2); assert.match(bad.errText, /--depth needs a whole number/);
    const noDir = run(["scan", path.join(root, "nope")]); assert.equal(noDir.code, 1); assert.match(noDir.errText, /not a folder/);
    const file = run(["scan", path.join(root, "a", "package.json")]); assert.equal(file.code, 1);
  } finally { rm(root); }
});

test("scan refuses a filesystem root and is bounded: a huge tree stops early and says so", () => {
  const r = run(["scan", path.parse(process.cwd()).root]);
  assert.equal(r.code, 1); assert.match(r.errText, /refusing to scan a drive\/filesystem root/);

  const root = tmp("kibo-many-");
  try {
    for (let i = 0; i < 30; i++) put(root, `p${String(i).padStart(2, "0")}/package.json`, pkg({ build: "x" }));
    const found = findProjectDirs(root, { depth: 2, maxDirs: 10 });
    assert.equal(found.truncated, true); assert.ok(found.dirs.length <= 10);
    assert.equal(findProjectDirs(root, { depth: 2 }).truncated, false);
    assert.equal(findProjectDirs(root, { depth: 2 }).dirs.length, 30);
  } finally { rm(root); }
});

test("findProjectDirs survives unreadable folders; summarizeProject never throws on odd package.json shapes", () => {
  const dirs = findProjectDirs("/x", { readdir: () => { throw new Error("EACCES"); } });
  assert.deepEqual(dirs, { dirs: [], truncated: false });
  const root = tmp("kibo-odd-");
  try {
    for (const [name, body] of [["null", "null"], ["arr", "[]"], ["nos", '{"name":"x"}'], ["strs", '{"scripts":"nope"}'], ["num", '{"scripts":{"build":5}}']]) {
      put(root, `${name}/package.json`, body);
      const s = summarizeProject(path.join(root, name));
      assert.ok(["off", "unreadable"].includes(s.state), name); assert.equal(s.hasBuild, false, name);
    }
  } finally { rm(root); }
});

/* --------------------------------------------------------------- bin + symlink */

test("package.json: kibo / kibo-setup / kibo-report are bin entries pointing at real, shebang-carrying scripts; the old `npm run kibo` still works", () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(p.bin).sort(), ["kibo", "kibo-report", "kibo-setup"]);
  for (const target of Object.values(p.bin)) {
    const file = path.join(ROOT, target);
    assert.ok(fs.existsSync(file), target);
    assert.match(fs.readFileSync(file, "utf8").split(/\r?\n/)[0], /^#!\/usr\/bin\/env node$/);
  }
  assert.equal(p.scripts.kibo, "node scripts/kibo-setup.mjs");                    // unchanged
  assert.equal(p.scripts.report, "node scripts/kibo-report.mjs");
});

test("started through a symlink (what `npm link` creates): runs, and writes the REAL path of kibo-npm.mjs, not the link's", { skip: WIN }, () => {
  const bin = tmp("kibo-bin-");
  const p = makeProject({ build: "x" });
  try {
    const link = path.join(bin, "kibo");
    fs.symlinkSync(path.join(HERE, "kibo-setup.mjs"), link);
    const help = spawnSync(process.execPath, [link, "--help"], { env: cleanEnv(), encoding: "utf8" });
    assert.equal(help.status, 0); assert.match(help.stdout, /kibo scan/);           // isMainModule works through the link
    const on = spawnSync(process.execPath, [link, "enable", "--project", p.dir, "--apply"], { env: cleanEnv(), encoding: "utf8" });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Undo with: kibo disable/);                             // hint matches how it was started
    const written = JSON.parse(fs.readFileSync(path.join(p.dir, "package.json"), "utf8")).scripts.build;
    assert.ok(written.includes(fwd(fs.realpathSync(REAL_NPM_SCRIPT))), written);
    assert.ok(!written.includes(bin), "must not reference the symlink folder");
  } finally { rm(bin); p.cleanup(); }
});

/* --------------------------------------------------------------- end to end: consent -> real npm -> kill switch */

test("end to end: enable with consent, real `npm run build` reports only type/duration/source, the kill switch silences it, disable restores the file", async () => {
  const p = makeProject({ build: BUILD, test: "t" });
  const file = path.join(p.dir, "package.json");
  const original = fs.readFileSync(file, "utf8");
  const k = await mockKibo();
  try {
    assert.equal(await cli(["enable", "--project", p.dir], { interactive: true, ask: async () => true, out: () => {}, err: () => {}, env: {}, me: "kibo" }), 0);
    const env = cleanEnv({ KIBO_IPC_FILE: k.file });

    assert.equal((await runNpm(p.dir, ["run", "build"], env)).status, 0);
    assert.equal((await runNpm(p.dir, ["run", "build"], { ...env, EXIT: "7" })).status, 7);
    assert.deepEqual(k.events().map((e) => e.split(" ")[0]), ["build_started", "build_succeeded", "build_started", "build_failed"]);
    for (const e of k.events()) assert.match(e, /^build_(started|succeeded|failed)( duration=\d+)? source=npm$/);   // nothing else ever leaves the process

    const quiet = k.events().length;                                               // kill switch: builds still run, exit codes untouched, zero events
    assert.equal((await runNpm(p.dir, ["run", "build"], { ...env, KIBO_REPORT_DISABLE: "1" })).status, 0);
    assert.equal((await runNpm(p.dir, ["run", "build"], { ...env, KIBO_REPORT_DISABLE: "1", EXIT: "3" })).status, 3);
    assert.equal(k.events().length, quiet);

    assert.equal(run(["disable", "--project", p.dir, "--apply"]).code, 0);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal((await runNpm(p.dir, ["run", "build"], env)).status, 0);          // after disable: plain build, no new events
    assert.equal(k.events().length, quiet);
  } finally { k.close(); p.cleanup(); }
});
