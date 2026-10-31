# Kibo Alpha 0.2 — Reactive Companion

Kibo can react to a few things you *explicitly* tell it about: a build starting, succeeding or failing,
a long task finishing, or you coming back. Nothing is watched unless you opt in: either you report an event yourself, or you enable an
integration for a specific project (see [Automatic build reporting](#automatic-build-reporting-opt-in)).

## Supported event sources in this release

| Source | Status |
| --- | --- |
| `kibo-report` command line reporter (`scripts/kibo-report.mjs`) | Implemented. Works with any tool that can run a command. |
| npm integration (`scripts/kibo-npm.mjs`, set up with `kibo enable` / `scripts/kibo-setup.mjs`) | Implemented, **opt-in per project**. Wrapper mode reports started / succeeded / failed from the real exit code; hooks mode reports started / succeeded only. |
| Vite plugin (`scripts/integrations/vite.mjs`) | Implemented, **opt-in per project**. `vite build` only. |
| Dashboard "Try build succeeded / failed" buttons | Implemented (simulated events for testing). |
| Cargo/Rust | **No automatic hook.** Use `kibo-report run -- cargo build`, or wrap an npm script that calls cargo. |
| Editor plug-ins (VS Code, JetBrains...), CI | **Not implemented.** You can call the reporter from them yourself. |
| Automatic idle / "user returned" detection | **Not implemented.** The event types exist and the policy handles them, but nothing detects idleness by itself (that would need system-wide input monitoring, which Kibo deliberately avoids). `kibo-report user-returned` can be wired to e.g. a screen-unlock task. |
| Arbitrary terminal commands | **Never detected.** Kibo cannot and does not watch your terminal; only configured integrations report. |

## Reporting events

Requires Node.js (22 or newer for the tests; the reporter itself needs only a current Node). Kibo must be running.

```powershell
node scripts/kibo-report.mjs build-succeeded
node scripts/kibo-report.mjs build-failed --source cargo
node scripts/kibo-report.mjs task-done --duration-ms 180000
node scripts/kibo-report.mjs user-returned

# wrap any command: reports "started", then success/failure with the measured duration,
# and exits with the command's own exit code (output is untouched and never read)
node scripts/kibo-report.mjs run --source npm -- npm run build
npm run report -- run -- cargo build --release
```

`scripts\kibo-report.cmd` is a Windows wrapper (`kibo-report run -- ...` once the `scripts` folder is on your `PATH`).
Options: `--duration-ms N`, `--source NAME` (letters, digits, `. _ -`, max 32), `--no-start` (for `run`).
If Kibo is not running, the reporter stays silent and exits 0 so it can never break a build; set
`KIBO_REPORT_VERBOSE=1` to see why an event was not delivered. Usage mistakes exit with 2.

### What each event does

| Event | Reaction (existing animations) |
| --- | --- |
| `build_started` | Brief attentive "focused" pose (3 s), no speech bubble. Skipped in quiet mode. |
| `build_succeeded` | Happy animation + "Build complete!"-style line. If it ran 60 s or longer (and long-task cheers are on, quiet mode off) → full celebration + "Finally, done!"-style line. |
| `build_failed` | Concerned/supportive pose + a gentle line ("That didn't go as planned."), then back to whatever Kibo was doing. |
| `task_completed` | Only reacts if it ran 60 s or longer (celebration). Short tasks never celebrate. |
| `user_returned` | Wave + "Welcome back!". |
| `system_active` | Same as `user_returned`, only if the reported idle duration was 5 minutes or more. |
| `system_idle` | Accepted, no visible reaction (reserved). |

If a finish event has no duration, Kibo uses the time since the matching `build_started` from the same `--source`.

### Rules that keep it calm

* **Priority:** direct interaction (drag/press) > long-task celebration > build success/failure > "build started" > welcome-back. A lower-priority event never interrupts a higher-priority reaction in progress. If you are dragging Kibo, a build result waits (up to 4 s) and then plays; ambient events are simply dropped.
* **Duplicates:** the same event type within 2 s counts as one event.
* **Cooldowns:** started 10 s, success 8 s, failure 6 s, welcome 60 s (doubled in quiet mode). Speech bubbles also go through the existing bubble rate limiter.
* **Sleeping:** a sleeping Kibo ignores events unless "Let events wake Kibo" is on. In the "break" state Kibo may react but is not woken: afterwards he goes back to break/sleep on the normal timer.
* **Hidden:** if Kibo is hidden (tray / dashboard), events are dropped. They never show the window and are not queued.

## Automatic build reporting (opt-in)

Kibo does **not** detect builds by itself. It never installs global hooks, wraps `npm`, edits shell profiles or watches other
processes. A build is reported only if *that project* was explicitly configured with one of the integrations below. In a project
you have not configured, `npm run build` does nothing for Kibo, and neither does a plain `cargo build` typed in a terminal.

### Quick setup

```powershell
# Once per machine, optional. Puts `kibo` on your PATH; nothing else.
cd C:\Projects\Kibo
npm link                  # undo: npm unlink -g kibo

# Per project, from the project folder (or add --project DIR):
kibo status               # configured? Kibo running? KIBO_REPORT_DISABLE set?
kibo enable               # prints the exact package.json change, then asks [y/N]
kibo disable              # restores the original scripts byte for byte
kibo scan C:\Projects     # read-only overview of every project below a folder
```

* **Consent.** `enable` / `disable` always show the change first. In an interactive terminal they ask `[y/N]` (anything but `y`/`yes` means no).
  Outside a terminal (scripts, pipes, `CI` set) nothing is written unless you pass `--apply`. Without `npm link`, use
  `node C:\Projects\Kibo\scripts\kibo-setup.mjs <command>`; `kibo npm enable ...` is the long form and still works.
* **What `npm link` does.** It links this Kibo folder into npm's global folder and adds three commands to your PATH. It changes no project, no
  npm config, no shell profile, and installs nothing. It only works while this folder exists (move it and re-run `npm link`).
  Kibo never runs it for you.
* **`scan`** looks only for `package.json` files below the folder you name (default depth 2, `--depth N` up to 5; never `node_modules`,
  dot-folders, build output or symlinks; stops after 2000 folders; refuses a drive root). It prints `ON` / `off` per project, the mode, and any
  broken path. `ON` means *that project's `package.json` calls Kibo*, not that a build has been seen. Projects outside the folder you scan, and
  Cargo-only folders, are not listed.
* **Which projects are ON?** `kibo status` for the current project, `kibo scan <folder>` for many. There is no hidden list: the `package.json`
  files are the only record, so the answer is never stale.
* **Absolute path warning.** When Kibo lives outside the project, the written command contains an absolute path that only exists on this machine.
  `enable` and `status` say so; do not commit that `package.json` (see "npm wrapper: setup").

### Which integration reports what

| Integration | build started | build succeeded | build failed | Setup |
| --- | --- | --- | --- | --- |
| **npm wrapper** (recommended) | yes | yes (exit code 0) | **yes** (any non-zero exit code) | one npm script is rewritten (`kibo-setup`, dry run first) |
| npm lifecycle hooks (limited) | yes | yes | **never** | `prebuild` / `postbuild` scripts (`kibo-setup --mode hooks`) |
| Vite plugin | yes | yes | yes, bundler errors only | one line in `vite.config` |
| `kibo-report run -- <cmd>` | yes | yes | yes | prefix the command yourself, every time |
| Cargo / Rust | no automatic hook exists | | | use `run`, or an npm script with the wrapper (see below) |

### Why plain `npm run build` needs configuration (and why hooks cannot report failures)

Checked against npm 10 while building this feature:

* npm runs `pre<script>` before a script and `post<script>` after it, **only if the script exited with 0**. If `build` fails,
  `postbuild` simply never runs, and npm itself exits with the failure code.
* No hook receives the result. The only variables npm provides (`npm_lifecycle_event`, `npm_package_json`, `npm_execpath`...) say
  nothing about whether the script succeeded.
* `npm run build --ignore-scripts` skips `prebuild` and `postbuild`.

So a `prebuild` + `postbuild` pair can know "started" and "succeeded" but cannot tell "failed" from "still running" or
"cancelled", and Kibo does not guess. The only way to learn the real outcome is to be the parent of the build and read its
exit code. That is what the wrapper does.

### Why there is no global auto-detect

Could one setup make *every* `npm run build` report, in projects you never configured? Investigated, not shipped. The only npm-level lever is the
user-level `script-shell` setting (npm runs every script through that executable). In a sandbox on Linux (npm 10.9.7) such a shim did see
`npm run build` in unconfigured projects, so it is technically possible. The trade-offs decided it:

| | Per project (shipped) | Global `script-shell` shim (not built) |
| --- | --- | --- |
| Scope | the script you chose, in the project you chose | every script of every package: `npm test` and a dependency's `postinstall` went through it (observed) |
| Silent gaps | `status` / `scan` show exactly what is on | a project `.npmrc` with its own `script-shell` bypassed it with no sign (observed); other package managers not checked |
| If the Kibo folder moves | only the wrapped script fails, and `status` flags it | every npm script on the machine failed with `spawn ... ENOENT` (observed) |
| Security surface | one `package.json` edit, shown before it is written | permanent code in the path of every npm script, including untrusted repos' scripts; a quoting bug changes what runs |
| Windows (primary target) | covered by tests that simulate Windows, plus one real test | Node starts a custom shell directly as `<shell> -c <command>` (read in Node's source), so the shim must be something Node can launch directly; no Windows variant could be tested here |
| Visibility | the project's `package.json` says it | nothing in any project says it is on |

Also rejected: shell-profile functions or aliases that wrap `npm` (per shell, invisible to IDEs and scripts), a PATH shim replacing `npm`
(fights version managers, bypassed by `npx`/direct `node`), and watching processes (against Kibo's privacy rules). So "automatic" always means
"this project was configured"; what the global option would save is typing `kibo enable` once per project, and that is now one command with a prompt.

### npm wrapper: setup

```powershell
cd C:\path\to\your\project
node C:\Projects\Kibo\scripts\kibo-setup.mjs npm enable           # dry run: prints the exact change, writes nothing
node C:\Projects\Kibo\scripts\kibo-setup.mjs npm enable --apply   # makes the change (edits only package.json "scripts")
npm run build                                                     # now reports to Kibo
```

(`kibo enable` is the short form of this, see Quick setup; inside the Kibo repo itself: `npm run kibo -- enable`.) For a project whose `build` is `tsc && vite build`, `--apply` produces:

```jsonc
"scripts": {
  "build":      "node C:/Projects/Kibo/scripts/kibo-npm.mjs run build:kibo",   // wrapper (relative path if kibo-npm.mjs is inside the project)
  "build:kibo": "tsc && vite build"                                           // your original command, unchanged
}
```

What happens on `npm run build`:

1. npm runs the wrapper, which sends `build_started` (if Kibo is running).
2. The wrapper runs `npm run build:kibo` as a child process (your original command, not a copy of it). The child shares your
   terminal; the wrapper never reads its output. The child is started without a shell where possible, so spaces in paths are safe.
3. When the child exits, the wrapper sends `build_succeeded` (exit code 0) or `build_failed` (any other code), with the elapsed time.
4. The wrapper exits with the child's own exit code, so CI, `&&` chains and your terminal behave exactly as before.

Other points:

* `--script NAME` wraps a different script (`--script rust:build`, `--script tauri:build`). Args work as usual: `npm run build -- --mode staging`.
* `npm run build:kibo` runs the original command directly, with no reporting.
* **Ctrl+C reports nothing** (a cancelled build is neither success nor failure). Same if the child is killed by a signal.
* If Kibo is closed, or its discovery file is stale, the build still runs and its exit code is untouched (verified by tests); if Kibo accepts the connection but never answers, each event waits at most 1.5 s before giving up.
* Wrap build-like scripts only. Do not wrap `dev`, `watch` or `start`: they never finish, so Kibo would only ever see a start.
  `kibo-setup` warns about this. Wrapping a bare `tauri` script also covers `tauri dev`; add `"tauri:build": "tauri build"` and wrap that.
* A `prebuild` / `postbuild` script that already exists keeps running *outside* the measured window; a failing `prebuild` is not reported.
* **The path is machine-specific** when Kibo lives outside the project (it is written as an absolute path). If you commit that
  `package.json`, a teammate without Kibo at that path gets `Cannot find module ... kibo-npm.mjs` and a failing build. Use this for
  your own projects, run `kibo-setup npm disable --apply` before committing, or keep a copy of `scripts/` inside the repo
  (then the path is relative and commit-safe). `kibo-setup npm status` flags a missing path.

### npm lifecycle hooks (limited mode)

```powershell
node C:\Projects\Kibo\scripts\kibo-setup.mjs npm enable --mode hooks --apply
```

Adds `"prebuild": "node .../kibo-npm.mjs pre"` and `"postbuild": "node .../kibo-npm.mjs post"`. `pre` sends `build_started` and stores
the start time; `post` sends `build_succeeded` with the duration and deletes it.

* **A failed build shows "started" and then nothing.** That is a limit of npm, not a bug (see above).
* A `post` with no recorded start (e.g. you ran `npm run postbuild` by hand), or one whose start is older than 6 hours, reports nothing.
  A second `post` for the same start reports nothing. This keeps a stray or repeated hook from claiming a success that did not happen.
* The start time is kept in `%TEMP%\kibo-npm-<hash>.json`: a hash of the project folder and script name plus one timestamp, no path, no
  command. `post` deletes it; the one left by a failed build is overwritten by the next `pre`. Folder spelling (`C:\Projects\App` vs
  `c:/projects/app/`) does not matter on Windows.
* Refuses to overwrite an existing `prebuild` / `postbuild`; it tells you what to add by hand instead.

### Vite plugin

```ts
// vite.config.ts
import kibo from "./scripts/integrations/vite.mjs";   // or the path to Kibo's scripts folder
export default defineConfig({ plugins: [react(), kibo()] });
```

Uses Vite/Rollup's official hooks: `buildStart` → started; an error in `buildEnd` or `renderError` → failed (immediately); `closeBundle` →
succeeded, sent after a 250 ms grace period so that client + SSR builds count as one build. `kibo-setup vite` prints this snippet.

* Only `vite build`. Not the dev server, and not watch mode (rebuilds never "finish").
* It sees the bundler, **not your whole script**: in `"build": "tsc && vite build"`, a TypeScript error stops the script before Vite starts
  and the plugin sees nothing. Use the npm wrapper if you want the outcome of the entire script.
* It cannot read the process exit code; "succeeded" means Rollup finished without an error.
* If the npm wrapper or `kibo-report run` already owns the build, the plugin stays silent (no double reports).
* Tested against the Vite version in this repo (success, unresolved import, syntax error). It is opt-in per project; Kibo's own `vite.config.ts` was not modified.

### Cargo / Rust, Tauri and other tools

Cargo offers no official "build finished" hook, and Kibo will not wrap `rustc` or poll processes, so there is no automatic Cargo integration.

```powershell
node scripts/kibo-report.mjs run --source cargo -- cargo build --release     # explicit, any time
```

To make it automatic, put the command in an npm script and wrap that script with the npm wrapper:

```powershell
# package.json: "rust:build": "cargo build --release"  (and "tauri:build": "tauri build")
node scripts/kibo-setup.mjs npm enable --script rust:build --apply
```

Any other build tool (webpack, esbuild, rollup, `make`...) works the same two ways: wrap its npm script, or prefix it with
`kibo-report run`. A plug-in for another tool would use `scripts/integrations/core.mjs` (see Architecture).

### What is not detected automatically

* Any command typed in a terminal in a project that was not configured (`cargo build`, `npm run build`, `make`, `go build`...).
* Builds started by editors, IDEs, file watchers or CI. Use `kibo-report run` or the wrapper where you control the command.
* Failures with the hooks mode; failures outside Vite's bundling step with the Vite plugin; a failing `prebuild`/`postbuild`.
* Cancelled builds (deliberately: no event).
* Builds run with other package managers: the wrapper calls `npm run`, so for pnpm/yarn use `kibo-report run -- pnpm build`.

### Enable, disable, inspect

| Goal | Command |
| --- | --- |
| See what is configured, and whether Kibo is running | `kibo status [--project DIR]` (long form: `node scripts/kibo-setup.mjs npm status`) |
| See which projects below a folder have it enabled (read-only) | `kibo scan [DIR ...] [--depth N]` |
| Enable (preview, then asks in a terminal) / enable without asking | `kibo enable [--script NAME] [--mode wrapper\|hooks]` / add `--apply` |
| Disable and restore the original scripts (byte for byte) | `kibo disable [--script NAME]` (asks) / `--apply` |
| Turn everything off for one shell session, no file changes | `$env:KIBO_REPORT_DISABLE = "1"` (PowerShell) / `set KIBO_REPORT_DISABLE=1` (cmd) |
| Turn off for one command only | `$env:KIBO_REPORT_DISABLE="1"; npm run build; Remove-Item Env:KIBO_REPORT_DISABLE` |
| Vite | remove `kibo()` from `plugins` |

`KIBO_REPORT_DISABLE=1` silences the wrapper, hooks, Vite plugin and `kibo-report run`; the wrapped command still runs normally.
Explicit commands such as `kibo-report build-failed` are not affected. `KIBO_REPORT_VERBOSE=1` prints why an event was not
delivered. `KIBO_REPORT_ACTIVE` is set internally in everything a reporter starts so nested reporters stay silent ("the
outermost reporter owns the build"); do not set it yourself.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `kibo` is not recognised | You have not run `npm link` (or the Kibo folder moved). Use `node C:\Projects\Kibo\scripts\kibo-setup.mjs <command>` or run `npm link` again. |
| `scan` says ON but nothing happens | ON only means the project is configured. Run `kibo status` (is Kibo running? `KIBO_REPORT_DISABLE`?), then the Nothing-happens steps below. |
| Nothing happens | Run `kibo status` (is the project configured? is Kibo running?). Then `$env:KIBO_REPORT_VERBOSE="1"; npm run build`. Check the dashboard settings (build reactions on), that Kibo is not hidden/asleep, and the cooldowns below. |
| "Started" but never success/failure | Hooks mode and the build failed (expected), the build was cancelled, or `--ignore-scripts`/`post` was skipped. Use wrapper mode for failures. |
| Reaction only on the first of several quick builds | Kibo's duplicate window (2 s) and cooldowns (started 10 s, success 8 s, failure 6 s). |
| `Cannot find module '...kibo-npm.mjs'` and the build fails | The Kibo folder moved or is missing on this machine. Run `kibo-setup.mjs npm disable --apply` from the new location, or restore `"build"` from `"build:kibo"` by hand. |
| Two "started" reactions per build | Hooks and wrapper both enabled on the same script, or a reporter not recognised as nested. Run `status`, then `disable` and enable one mode. |
| `kibo-npm run: "build" would run itself forever` | The wrapper targets its own script. Wrap a different script (`build:kibo`). |
| Path with spaces | Supported: the generated command quotes it. If you edit it by hand keep `node "C:/Some Folder/..."`. |
| Works in one terminal, not another | `KIBO_REPORT_DISABLE=1` set in that shell, or a different user account (the discovery file is per user). |
| Monorepo / workspaces | Run setup with `--project` on the package that owns the script; the wrapper runs in that package's folder. |

## Settings (Dashboard → Quick settings → Reactions)

| Setting | Default | Notes |
| --- | --- | --- |
| Build & task reactions | on | Off → build/task events do nothing. |
| Activity reactions | on | Off → `user_returned` / `system_*` do nothing. |
| Reaction speech bubbles | on | Also requires "Encouragement messages". |
| Bigger cheer for long tasks | on | Off → long tasks get the normal happy animation. |
| Let events wake Kibo | off | Off → sleeping Kibo stays asleep. |
| Quiet mode (existing) | off | Also makes event reactions subtler: no "started" pose, no big celebration, cooldowns ×2, bubbles ×3 rarer. |

Settings use the existing `localStorage` store (`kibo.settings.v1`), apply immediately and survive restarts. Settings saved by
earlier versions load fine and get the new defaults.

## Privacy and security

* Events contain only: type, an optional duration, an optional short source label. Never source code, terminal output, command lines, file names or window titles. No keystroke, clipboard, screenshot or browsing data is touched. Nothing is sent over the internet.
* Automatic integrations add no new data: they send the same three things (type, duration, a label such as `npm` or `vite`). They do not
  read terminal output (the wrapped command's stdio is inherited, never captured), source code, configs, command lines, environment
  variables or window titles, and they send nothing over the network except to `127.0.0.1`. `kibo-setup` reads and edits only the
  target project's `package.json`, and only with your consent (an interactive `y`, or `--apply`). `kibo scan` only reads `package.json` files
  below the folder you name and writes nothing. The one file an integration writes on its own is the hooks-mode start
  marker in `%TEMP%` described above. Kibo installs nothing globally (the optional `npm link` is a command you run yourself and only adds
  `kibo`, `kibo-setup` and `kibo-report` to your PATH), no shell profile is touched, no other process is monitored.
* Transport: Kibo listens on `127.0.0.1` only (random port, no administrator rights, no firewall prompt expected on the loopback interface). It writes the port and a random per-launch token to `%LOCALAPPDATA%\dev.kairoqx.kibo\ipc.json`; a message without the token is rejected. The file is removed when Kibo exits normally.
* Input handling: one line per connection, max 512 bytes, 1 s I/O timeout, at most 8 simultaneous connections, strict whitelist parsing in Rust, then re-validated in TypeScript. Anything malformed is rejected.
* Limits you should know about: any process running as *you* can read `ipc.json` and send events (so can a malicious program already running as you; events can only trigger a harmless animation). The token comes from the OS-seeded hasher in Rust's standard library rather than a dedicated crypto crate. Running two Kibo instances makes the second overwrite `ipc.json`.

## Architecture (for contributors)

```
kibo-report ──TCP 127.0.0.1──▶ src-tauri/src/ipc.rs  (token, size, whitelist)
                                   │ emit "kibo:dev-event" (validated JSON string)
                                   ▼
src/events/types.ts      parseWireEvent()   re-validation, own timestamp
src/events/policy.ts     planReaction()     event → reaction request (pure)
src/events/orchestrator  EventOrchestrator  dedupe, cooldown, priority, hidden/sleep/drag rules
                                   │ play({state, ms, message, wake})
                                   ▼
src/useKibo.ts           react()            overlay on the existing state machine (no timer reset)
                                   ▼
src/kiboRig.ts           unchanged          animates the existing parts
```

Reporter side (`scripts/`), all dependency-free Node:

```
kibo-report.mjs          wire protocol client + `run -- <cmd>` + manual events      (unchanged CLI)
kibo-npm.mjs             npm wrapper (run) and pre/post hooks                        opt-in
kibo-setup.mjs           dry-run-first editor of a project's package.json scripts    opt-in, reversible; asks in a terminal; `scan` is read-only
integrations/core.mjs    BuildRun state machine, exit classification, nesting rules, spawn helper
integrations/vite.mjs    Vite plugin built on the same core
```

To add an integration for another tool: use the tool's *official* lifecycle API, create a `BuildRun` (or `createMultiBuildReporter`
when one build has several phases) with `send = report`, call `start()` / `finish("success" | "failure" | "cancelled")`, and check
`reportingMode(env)` so you stay silent when nested or disabled. `BuildRun` guarantees at most one terminal event per run and none
without a start. Add tests with the mock listener in `scripts/testing/helpers.mjs`.

To add a new event source (an editor extension, a file-based hook, a different transport): produce a JSON string
`{"type": "...", "durationMs": 123, "source": "name"}` and either send it through `kibo-report`/the socket, or
emit it on the `kibo:dev-event` Tauri event. To add a new event *type*: add it to `EVENT_TYPES` (`types.ts`) and the
`EVENTS` list in `ipc.rs`, then add a `case` in `planReaction()` and a test. The rig and the speech bubbles do not change.

## Tests

```powershell
npm test       # Node's built-in test runner (Node 22.18+; older 22.x needs --experimental-strip-types, already in the script)
```

Covers: reaction requests for each event, duplicates, cooldowns, priority, sleep and hidden policy, disabled integrations, invalid
payloads, deferral while dragging, timer cleanup, settings persistence/migration, and the reporter side:

* `kibo-report.test.mjs`: the original reporter (wire format, discovery paths, `run`), unchanged.
* `kibo-core.test.mjs`: start / success / failure, non-zero and cancelled exit codes, duplicate and contradictory events, nesting and the kill
  switch, multi-build sequences, Windows path normalisation and Windows spawn/quoting rules, and `run` compatibility.
* `kibo-npm.test.mjs`: hook and wrapper logic with fakes, plus **real `npm run`** in temp projects (folder names with spaces):
  success, failure, `a && b` chains, argument pass-through, Kibo closed, kill switch, self-recursion guard, `--ignore-scripts`, hooks after a failed build.
* `kibo-setup.test.mjs`: dry run vs `--apply`, refusal to clobber, enable then disable restoring `package.json` byte for byte (CRLF and LF),
  an install path with a space, broken-path detection.
* `kibo-onboarding.test.mjs`: short commands = long forms, the consent prompt (no write before "yes"; no prompt in scripts/CI or with `--apply`), enable touching
  only the chosen `package.json`, no overwriting, `scan` (ON/off/problem/unreadable, skip rules, depth, size cap, writes nothing), hints, `bin`
  entries, running through a symlink as `npm link` creates it, and a real `npm run` end to end with the kill switch and the wire format.
* `kibo-vite.test.mjs`: Rollup hook sequences, and **real `vite build`** for success, unresolved import and syntax error.

One test is Windows-only (`cmd.exe` pass-through) and is reported as skipped on other systems. Rust unit tests for the line parser live in
`src-tauri/src/ipc.rs` (`cargo test` in `src-tauri`).

### Manual test checklist (Windows)

1. `npm run tauri dev`. Open the dashboard → Reactions → click **Try “build succeeded”** (happy + bubble) and **Try “build failed”** (supportive pose + bubble). Click again quickly: the second click is ignored (duplicate/cooldown).
2. In a terminal: `node scripts/kibo-report.mjs run -- cmd /c "timeout /t 65 >nul"` → "focused" pose at start, big celebration after ~65 s.
3. Check `%LOCALAPPDATA%\dev.kairoqx.kibo\ipc.json` exists while Kibo runs and is gone after "Quit Kibo".
4. Quit Kibo, run `node scripts/kibo-report.mjs build-failed`: no output, exit code 0 (`echo %ERRORLEVEL%`).
5. Let Kibo fall asleep, send `build-succeeded`: he must stay asleep. Turn on "Let events wake Kibo" and repeat: he wakes and reacts.
6. Hide Kibo from the tray, send events: nothing appears. Show him again: no stale reaction.
7. Press and hold Kibo (or drag him) while sending `build-succeeded`: the reaction waits and plays after you let go.
8. Turn off "Build & task reactions": events do nothing. Pat, poke, drag, hover, click-through, tray Show/Hide/Reset still work as before.
9. Automatic npm reporting: in a scratch project run `node C:\Projects\Kibo\scripts\kibo-setup.mjs npm enable` (dry run, nothing changes), then `--apply`.
   `npm run build` → focused pose, then happy; make the build fail (e.g. a syntax error) → supportive pose, and `echo %ERRORLEVEL%` is the build's own code.
   Press Ctrl+C during a build → no result reaction. `... npm disable --apply` → `package.json` is back to the original.
10. Same project with `--mode hooks`: success → started + happy; a failing build → only the "started" pose, no failure reaction (expected).

## Known limitations

* The Rust listener and the React/Tauri wiring were written without a Rust toolchain or installed `node_modules` in the authoring environment: they have **not been compiled or run**. Run `cargo test` and `npm run tauri dev` before relying on them.
* Only Windows is targeted; macOS/Linux data-directory paths in the reporter follow Tauri conventions but are untested.
* No automatic idle/return detection, no editor integrations, no per-event customisation of messages.
* `npm link`, the `kibo` command and the consent prompt were verified on Linux (Node 22, npm 10). On Windows npm generates `.cmd` shims for the three commands; that was
  not run here, and the interactive `[y/N]` prompt was tested with injected streams, not in a real Windows terminal. `kibo-setup.mjs <command>` via `node` is the fallback.
* The automatic integrations were verified on Linux with Node 22 and npm 10 (including real `npm run` and `vite build`); the Windows-specific code paths (cmd.exe spawning, path
  rules) are covered by tests that simulate Windows, plus one real Windows-only test. Run `npm test` on your machine to confirm.
* Windows ACLs on `ipc.json` come from the default per-user `%LOCALAPPDATA%` permissions (not set explicitly).
