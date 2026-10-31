# Kibo Companion for VS Code

Tells your running **Kibo** desktop companion when a VS Code **build task** (or, optionally, **test task**) starts, succeeds or fails.
It uses Kibo's existing authenticated local IPC and its existing event whitelist. It adds no event types, no listener, and no reaction logic: Kibo's orchestrator decides what (if anything) Kibo does.

## What is detected

| Source | Events sent | How it is detected | Default |
| --- | --- | --- | --- |
| **Build tasks** | `build_started`, `build_succeeded`, `build_failed` (source `vscode`) | VS Code Tasks API: process start, and the **real exit code** of the task process | on |
| **Test tasks** | same three events (source `vscode-test`) | Tasks in the **Test group** only, same mechanism | **off** |
| **Diagnostics** | nothing | observed only when enabled; Kibo has no diagnostics event | off |

**Build workflows detected today:** a VS Code Task that (a) is in the **Build** group (`"group": "build"` in `tasks.json`, or "Configure Default Build Task"), (b) is not a background/watch task, and (c) runs a process (shell or process execution). With `kibo.build.taskScope = "all"`, every non-background task counts as a build.

- Started = process started. Succeeded = exit code `0`. Failed = any other exit code.
- **Cancelled** (task terminated, exit code unavailable) sends **no result event**. Kibo has no "cancelled" event and never guesses.
- Several tasks in one go (compound tasks, `dependsOn`, parallel test tasks) are **aggregated into one reaction**: one started, then one failed (immediately, if any failed) or one succeeded (after all finished, plus 400 ms grace so sequential steps count as one build).
- Durations are measured from the first start to the last finish.

### Limitations (please read)

- **Arbitrary integrated-terminal commands are not detected.** VS Code does not expose a success/failure event for commands typed in a terminal, and this extension does not read terminal output or intercept commands. Run builds as Tasks, or use Kibo's own `kibo-report run -- <cmd>` / npm wrapper (see Kibo's `EVENTS.md`).
- Tasks without a process (pure compound "dependsOn" container tasks, custom executions) produce no event of their own; their child tasks do, if they qualify.
- A task's exit code is the only truth: a task that exits 0 despite errors reports success.
- **Diagnostics:** Kibo's protocol cannot express them, and an editor error is not a failed build, so nothing is sent. With `kibo.diagnostics.enabled` the extension only counts errors/warnings (debounced, deduplicated, counts only) and writes a line to the *Kibo* output channel at `info` level. Wiring a real reaction needs a new Kibo event type, a deliberate change to `ipc.rs`/`types.ts`/`policy.ts` that this extension does not make.
- **Tests:** VS Code's stable API gives an extension no way to observe other extensions' Test Explorer runs (the result APIs are proposed/unstable), so Test Explorer runs are **not** detected. Only Test-group **tasks** are. Because Kibo has no "tests" event, test results reuse `build_*` events, so Kibo's bubbles say "Build complete!"/"Build failed". That is why test reporting is off by default.
- Not verified inside a real VS Code yet (see "Validation status" below).

## Install (local)

```powershell
cd C:\Projects\Kibo\vscode-extension
npm install
npm run package                 # produces kibo-vscode-0.1.0.vsix
code --install-extension kibo-vscode-0.1.0.vsix
```
Or press **F5** in VS Code with this folder open (needs a `launch.json` with an "Extension Development Host" config, or use *Run > Start Debugging* and pick "VS Code Extension Development").

Requires VS Code 1.85+ and a running Kibo (Alpha 0.2+). Same machine and same OS user as Kibo (the discovery file is per user).

## Connect to Kibo

Nothing to configure. The extension reads Kibo's discovery file, `%LOCALAPPDATA%\dev.kairoqx.kibo\ipc.json` (override with the `KIBO_IPC_FILE` environment variable, like Kibo's reporter), and connects to **127.0.0.1 only** on the port inside it, sending Kibo's token. Run **Kibo: Check Connection**: it sends `system_idle`, which Kibo accepts but shows no reaction for.

## Commands

| Command | Sends |
| --- | --- |
| Kibo: Check Connection | `system_idle` (invisible) |
| Kibo: Test Happy Reaction | `build_succeeded` |
| Kibo: Test Error Reaction | `build_failed` |
| Kibo: Enable / Disable Event Reporting | toggles `kibo.reporting.enabled` |

Kibo may still stay quiet after a successful send: it is asleep, hidden, in quiet mode, the reaction is off in its settings, or a cooldown/duplicate rule applies. Those rules live in Kibo and are respected, not bypassed.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `kibo.reporting.enabled` | true | Master switch; off = nothing is ever sent (commands included) |
| `kibo.build.enabled` | true | Build tasks |
| `kibo.build.taskScope` | `buildGroup` | `buildGroup` or `all` |
| `kibo.tests.enabled` | false | Test-group tasks |
| `kibo.diagnostics.enabled` | false | Observe diagnostic counts (sends nothing) |
| `kibo.logLevel` | `error` | `off` / `error` / `info` for the *Kibo* output channel |

The extension is quiet: no status bar item, no notifications except as the direct answer to one of the commands. When Kibo is not running, event sends are skipped with exponential backoff (2 s up to 60 s), one log line is written when availability changes, and events are dropped rather than queued. If Kibo restarts, the new port/token is picked up automatically.

## Privacy and security

- Sent to Kibo: event type, duration, and the label `vscode` or `vscode-test`. Nothing else.
- **Never read or sent:** keystrokes, source code, file names/paths, task names, command lines, terminal output, clipboard, screenshots, diagnostic messages.
- No telemetry, no external network requests; the only socket is to `127.0.0.1`.
- The token is read per send, held only in memory for that send, and never logged, shown or stored. Log lines are fixed strings and reason codes.
- Events outside Kibo's whitelist cannot be sent: they are rejected in the client before any connection.
- The discovery file is validated (size, JSON, `v: 1`, port range, token charset with no whitespace) before use. Any host field is ignored.
- Known limit, inherited from Kibo's design: any process running as you can read the discovery file and send events.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Kibo does not seem to be running" | Start Kibo. Check `%LOCALAPPDATA%\dev.kairoqx.kibo\ipc.json` exists. Same Windows user? |
| Rejected / unauthorized | Stale discovery file (Kibo crashed) or two Kibo instances. Restart Kibo. |
| Connected, but no reaction | Kibo asleep (enable "Let events wake Kibo"), hidden, quiet mode, "Build & task reactions" off, or a cooldown (started 10 s, success 8 s, failure 6 s). |
| Task finished, nothing sent | Not in the Build group, a background task, `kibo.build.enabled` off, or the task was terminated (cancelled). Set `kibo.logLevel` to `info`. |
| Only "started" appeared | Task was cancelled, or has no process exit code. |

## Develop and test

```powershell
cd C:\Projects\Kibo\vscode-extension
npm install
npm run compile      # tsc
npm test             # tsc + node --test "out/test/*.test.js" (77 tests, no VS Code needed)
```
Core logic imports nothing from `vscode`; only `src/extension.ts` does, so tests use a real mock TCP listener (same wire rules as `ipc.rs`) plus injected fake task APIs and fake timers. A test compares the extension's event list with `src-tauri/src/ipc.rs` (skipped when built outside the Kibo repo).
