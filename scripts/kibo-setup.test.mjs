// kibo-setup: pure planning logic, file-format preservation, and an end-to-end enable -> real npm run -> disable round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WRAP_SUFFIX, commandFor, main, parseKiboCommand, planDisable, planEnable, readPackage, reporterRef, scanScripts, serializePackage } from "./kibo-setup.mjs";
import { cleanEnv, fwd, mockKibo, runNpm } from "./testing/helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF = "scripts/kibo-npm.mjs";
const ORIGINAL = { dev: "vite", prebuild: "echo pre", build: "tsc && vite build", test: "node --test" };

test("reporterRef: relative inside the project (commit-safe), absolute outside; forward slashes; Windows rules", () => {
  assert.equal(reporterRef("C:\\Projects\\Kibo", "C:\\Projects\\Kibo\\scripts\\kibo-npm.mjs", "win32"), "scripts/kibo-npm.mjs");
  assert.equal(reporterRef("D:\\Work\\app", "C:\\Projects\\Kibo\\scripts\\kibo-npm.mjs", "win32"), "C:/Projects/Kibo/scripts/kibo-npm.mjs");
  assert.equal(reporterRef("C:\\Work\\app", "C:\\Projects\\Kibo\\scripts\\kibo-npm.mjs", "win32"), "C:/Projects/Kibo/scripts/kibo-npm.mjs");
  assert.equal(reporterRef("/home/u/app", "/home/u/Kibo/scripts/kibo-npm.mjs", "linux"), "/home/u/Kibo/scripts/kibo-npm.mjs");
  assert.equal(reporterRef("/home/u/Kibo", "/home/u/Kibo/scripts/kibo-npm.mjs", "linux"), "scripts/kibo-npm.mjs");
});

test("commandFor / parseKiboCommand: round trip, quoting for paths with spaces, and no false positives", () => {
  for (const ref of ["scripts/kibo-npm.mjs", "C:/Users/John Doe/Kibo Tools/scripts/kibo-npm.mjs"]) {
    for (const rest of ["run build:kibo", "pre", "post"]) {
      const p = parseKiboCommand(commandFor(ref, rest));
      assert.equal(p.ref, ref); assert.equal(p.kind, rest.split(" ")[0]);
    }
  }
  assert.equal(parseKiboCommand("node scripts/kibo-npm.mjs run build:kibo").target, "build:kibo");
  for (const other of ["tsc && vite build", "node build.mjs run x", "node scripts/other.mjs run x", "node scripts/kibo-npm.mjs run x && rm -rf /", "node scripts/kibo-npm.mjs", undefined, 5]) {
    assert.equal(parseKiboCommand(other), null, String(other));
  }
});

test("planEnable (wrapper): renames the real script, wraps it, keeps key order and every other script", () => {
  const p = planEnable(ORIGINAL, { script: "build", mode: "wrapper", ref: REF });
  assert.equal(p.changed, true); assert.deepEqual(p.problems, []);
  assert.deepEqual(Object.keys(p.scripts), ["dev", "prebuild", "build", "build:kibo", "test"]);
  assert.equal(p.scripts["build:kibo"], "tsc && vite build");              // original command preserved verbatim
  assert.equal(p.scripts.build, "node scripts/kibo-npm.mjs run build:kibo");
  assert.equal(p.scripts.dev, "vite"); assert.equal(p.scripts.test, "node --test");
  assert.match(p.warnings.join("\n"), /"prebuild" exists .*outside the part Kibo measures/);
  assert.deepEqual(ORIGINAL.build, "tsc && vite build");                   // input not mutated
});

test("planEnable (hooks): adds pre/post around the script and warns that failures cannot be reported", () => {
  const p = planEnable({ build: "vite build", test: "x" }, { script: "build", mode: "hooks", ref: REF });
  assert.deepEqual(Object.keys(p.scripts), ["prebuild", "build", "postbuild", "test"]);
  assert.equal(p.scripts.prebuild, "node scripts/kibo-npm.mjs pre");
  assert.equal(p.scripts.postbuild, "node scripts/kibo-npm.mjs post");
  assert.match(p.warnings.join("\n"), /failed build is NOT reported/);
  assert.match(p.warnings.join("\n"), /--ignore-scripts/);
});

test("planEnable refuses to clobber, to wrap missing scripts, odd names, or to double-enable", () => {
  assert.match(planEnable(ORIGINAL, { script: "nope", mode: "wrapper", ref: REF }).problems[0], /no "nope" script/);
  assert.match(planEnable(ORIGINAL, { script: "build; x", mode: "wrapper", ref: REF }).problems[0], /not a usable/);
  assert.match(planEnable({ ...ORIGINAL, "build:kibo": "x" }, { script: "build", mode: "wrapper", ref: REF }).problems[0], /refusing to overwrite/);
  assert.match(planEnable(ORIGINAL, { script: "build", mode: "hooks", ref: REF }).problems[0], /"prebuild" already exists/);
  assert.match(planEnable(ORIGINAL, { script: "build", mode: "magic", ref: REF }).problems[0], /unknown mode/);
  const once = planEnable({ build: "x" }, { script: "build", mode: "wrapper", ref: REF }).scripts;
  const twice = planEnable(once, { script: "build", mode: "wrapper", ref: REF });
  assert.equal(twice.changed, false); assert.equal(twice.noop, true);
  const clash = planEnable(once, { script: "build", mode: "hooks", ref: REF });   // switching modes needs an explicit disable first
  assert.equal(clash.changed, false); assert.equal(clash.noop, false); assert.match(clash.problems[0], /disable/);
});

test("planEnable warns for long-running scripts such as dev", () => {
  assert.match(planEnable({ dev: "vite" }, { script: "dev", mode: "wrapper", ref: REF }).warnings.join(), /long-running/);
  assert.match(planEnable({ "tauri:dev": "tauri dev" }, { script: "tauri:dev", mode: "wrapper", ref: REF }).warnings.join(), /long-running/);
});

test("enable then disable restores the original scripts exactly (values and key order), in both modes", () => {
  for (const mode of ["wrapper", "hooks"]) {
    const scripts = mode === "hooks" ? { dev: "vite", build: "tsc && vite build", test: "t" } : ORIGINAL;
    const on = planEnable(scripts, { script: "build", mode, ref: REF });
    const off = planDisable(on.scripts, { script: "build" });
    assert.equal(off.changed, true, mode);
    assert.deepEqual(off.scripts, scripts); assert.deepEqual(Object.keys(off.scripts), Object.keys(scripts));
  }
});

test("planDisable: nothing to do is a no-op; customised or foreign hooks are never deleted", () => {
  assert.equal(planDisable(ORIGINAL, { script: "build" }).noop, true);
  const mine = { build: "node scripts/kibo-npm.mjs run something-else", "something-else": "x" };
  const p = planDisable(mine, { script: "build" });
  assert.equal(p.changed, false); assert.match(p.problems[0], /did not create/);
  const custom = planDisable({ build: "x", prebuild: "node scripts/kibo-npm.mjs pre && echo mine" }, { script: "build" });
  assert.equal(custom.changed, false); assert.match(custom.warnings[0], /customised/);
  const foreign = planDisable({ build: "x", prebuild: "echo keep" }, { script: "build" });
  assert.equal(foreign.changed, false); assert.equal(foreign.scripts.prebuild, "echo keep");
});

test("scanScripts: lists integrations and flags a broken reporter path (which would fail the build)", () => {
  const scripts = { build: commandFor("C:/gone/kibo-npm.mjs", `run build${WRAP_SUFFIX}`), [`build${WRAP_SUFFIX}`]: "x", prebuild: commandFor("scripts/kibo-npm.mjs", "pre") };
  const exists = (p) => p === "C:/gone/kibo-npm.mjs" ? false : true;
  const { found, issues } = scanScripts(scripts, { projectDir: "C:/p", exists, platform: "win32" });
  assert.deepEqual(found.map((f) => [f.name, f.kind]), [["build", "run"], ["prebuild", "pre"]]);
  assert.equal(issues.length, 1); assert.match(issues[0], /does not exist.*FAIL/);
  assert.match(scanScripts({ build: commandFor(REF, "run missing") }, { projectDir: "/p", exists: () => true, platform: "linux" }).issues[0], /not defined/);
});

test("serializePackage keeps CRLF vs LF, indentation and the trailing newline", () => {
  for (const [eol, indent, fin] of [["\r\n", "  ", true], ["\n", "\t", false], ["\n", "    ", true]]) {
    const text = JSON.stringify({ name: "x", scripts: { build: "a" }, other: { k: 1 } }, null, indent).replace(/\n/g, eol) + (fin ? eol : "");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-fmt-"));
    fs.writeFileSync(path.join(dir, "package.json"), text);
    const info = readPackage(dir);
    assert.equal(serializePackage(info, info.pkg.scripts), text);                  // unchanged scripts -> identical bytes
    fs.rmSync(dir, { recursive: true });
  }
});

/* ------------------------------------------------------------- end to end */

function installedCopy() {
  // a copy of the tool in a folder WITH A SPACE, outside the project: the generated command must quote the absolute path
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kibo tools "));
  const dst = path.join(root, "scripts");
  fs.mkdirSync(path.join(dst, "integrations"), { recursive: true });
  for (const f of ["kibo-setup.mjs", "kibo-npm.mjs", "kibo-report.mjs"]) fs.copyFileSync(path.join(HERE, f), path.join(dst, f));
  fs.copyFileSync(path.join(HERE, "integrations", "core.mjs"), path.join(dst, "integrations", "core.mjs"));
  return { setup: path.join(dst, "kibo-setup.mjs"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const setupCli = (setup, args) => spawnSync(process.execPath, [setup, ...args], { env: cleanEnv(), encoding: "utf8" });

for (const eol of ["\r\n", "\n"]) {
  test(`end to end (${eol === "\n" ? "LF" : "CRLF"} package.json): dry run changes nothing; --apply wraps; real npm reports; disable restores the bytes`, async () => {
    const tool = installedCopy();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo my app "));
    const pkgPath = path.join(dir, "package.json");
    const original = JSON.stringify({ name: "app", private: true, scripts: { build: `node -e "process.exit(Number(process.env.EXIT||0))"`, test: "x" } }, null, 2).replace(/\n/g, eol) + eol;
    fs.writeFileSync(pkgPath, original);
    const k = await mockKibo();
    try {
      const dry = setupCli(tool.setup, ["npm", "enable", "--project", dir]);
      assert.equal(dry.status, 0); assert.match(dry.stdout, /No files were changed/);
      assert.equal(fs.readFileSync(pkgPath, "utf8"), original);                       // consent not given: untouched

      const on = setupCli(tool.setup, ["npm", "enable", "--project", dir, "--apply"]);
      assert.equal(on.status, 0, on.stderr);
      const edited = fs.readFileSync(pkgPath, "utf8");
      assert.ok(edited.includes(eol) && (eol === "\r\n" || !edited.includes("\r")));   // line endings preserved
      assert.equal(JSON.parse(edited).scripts.build.startsWith('node "'), true);       // absolute path with a space is quoted

      const env = cleanEnv({ KIBO_IPC_FILE: k.file });
      const good = await runNpm(dir, ["run", "build"], env);
      const bad = await runNpm(dir, ["run", "build"], { ...env, EXIT: "5" });
      assert.equal(good.status, 0); assert.equal(bad.status, 5);
      assert.deepEqual(k.events().map((e) => e.split(" ")[0]), ["build_started", "build_succeeded", "build_started", "build_failed"]);

      assert.equal(setupCli(tool.setup, ["npm", "status", "--project", dir]).status, 0);
      const off = setupCli(tool.setup, ["npm", "disable", "--project", dir, "--apply"]);
      assert.equal(off.status, 0, off.stderr);
      assert.equal(fs.readFileSync(pkgPath, "utf8"), original);                        // byte-for-byte restore
    } finally { k.close(); tool.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("status flags a deleted Kibo folder (exit 1) and disable still works to recover", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kibo-broken-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: `node "${fwd(path.join(dir, "gone", "kibo-npm.mjs"))}" run build:kibo`, "build:kibo": "echo hi" } }, null, 2));
  const out = []; const code = main(["npm", "status", "--project", dir], { out: (l) => out.push(l), err: () => {}, env: {} });
  assert.equal(code, 1); assert.match(out.join("\n"), /PROBLEM.*does not exist/);
  const lines = []; assert.equal(main(["npm", "disable", "--project", dir, "--apply"], { out: (l) => lines.push(l), err: () => {}, env: {} }), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts.build, "echo hi");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI usage errors exit 2; vite/cargo print guidance and change nothing", () => {
  const quiet = { out: () => {}, err: () => {}, env: {} };
  assert.equal(main([], quiet), 2); assert.equal(main(["npm", "explode"], quiet), 2); assert.equal(main(["npm", "enable", "--bogus"], quiet), 2);
  const lines = []; assert.equal(main(["cargo"], { ...quiet, out: (l) => lines.push(l) }), 0);
  assert.match(lines.join(), /NOT detected/);
  assert.equal(main(["vite"], quiet), 0);
});
