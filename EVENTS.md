# Kibo Alpha 0.2 — Reactive Companion

Kibo can react to a few things you *explicitly* tell it about: a build starting, succeeding or failing,
a long task finishing, or you coming back. Nothing is watched automatically.

## Supported event sources in this release

| Source | Status |
| --- | --- |
| `kibo-report` command line reporter (`scripts/kibo-report.mjs`) | Implemented. Works with any tool that can run a command. |
| Dashboard "Try build succeeded / failed" buttons | Implemented (simulated events for testing). |
| Editor plug-ins (VS Code, JetBrains...), CI, Cargo/npm hooks | **Not implemented.** You can call the reporter from them yourself. |
| Automatic idle / "user returned" detection | **Not implemented.** The event types exist and the policy handles them, but nothing detects idleness by itself (that would need system-wide input monitoring, which Kibo deliberately avoids). `kibo-report user-returned` can be wired to e.g. a screen-unlock task. |

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

To add a new event source (an editor extension, a file-based hook, a different transport): produce a JSON string
`{"type": "...", "durationMs": 123, "source": "name"}` and either send it through `kibo-report`/the socket, or
emit it on the `kibo:dev-event` Tauri event. To add a new event *type*: add it to `EVENT_TYPES` (`types.ts`) and the
`EVENTS` list in `ipc.rs`, then add a `case` in `planReaction()` and a test. The rig and the speech bubbles do not change.

## Tests

```powershell
npm test       # Node's built-in test runner (Node 22.18+; older 22.x needs --experimental-strip-types, already in the script)
```

Covers: reaction requests for each event, duplicates, cooldowns, priority, sleep and hidden policy, disabled
integrations, invalid payloads, deferral while dragging, timer cleanup, settings persistence/migration, and the CLI
reporter against a mock listener. Rust unit tests for the line parser live in `src-tauri/src/ipc.rs` (`cargo test` in `src-tauri`).

### Manual test checklist (Windows)

1. `npm run tauri dev`. Open the dashboard → Reactions → click **Try “build succeeded”** (happy + bubble) and **Try “build failed”** (supportive pose + bubble). Click again quickly: the second click is ignored (duplicate/cooldown).
2. In a terminal: `node scripts/kibo-report.mjs run -- cmd /c "timeout /t 65 >nul"` → "focused" pose at start, big celebration after ~65 s.
3. Check `%LOCALAPPDATA%\dev.kairoqx.kibo\ipc.json` exists while Kibo runs and is gone after "Quit Kibo".
4. Quit Kibo, run `node scripts/kibo-report.mjs build-failed`: no output, exit code 0 (`echo %ERRORLEVEL%`).
5. Let Kibo fall asleep, send `build-succeeded`: he must stay asleep. Turn on "Let events wake Kibo" and repeat: he wakes and reacts.
6. Hide Kibo from the tray, send events: nothing appears. Show him again: no stale reaction.
7. Press and hold Kibo (or drag him) while sending `build-succeeded`: the reaction waits and plays after you let go.
8. Turn off "Build & task reactions": events do nothing. Pat, poke, drag, hover, click-through, tray Show/Hide/Reset still work as before.

## Known limitations

* The Rust listener and the React/Tauri wiring were written without a Rust toolchain or installed `node_modules` in the authoring environment: they have **not been compiled or run**. Run `cargo test` and `npm run tauri dev` before relying on them.
* Only Windows is targeted; macOS/Linux data-directory paths in the reporter follow Tauri conventions but are untested.
* No automatic idle/return detection, no editor integrations, no per-event customisation of messages.
* Windows ACLs on `ipc.json` come from the default per-user `%LOCALAPPDATA%` permissions (not set explicitly).
