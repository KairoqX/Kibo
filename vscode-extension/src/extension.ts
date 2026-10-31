import * as vscode from "vscode";
import { KiboClient } from "./client";
import { Controller } from "./controller";
import { DiagnosticsTracker, mapTransition } from "./diagnostics";
import { Logger, type LogLevel } from "./logger";
import { RunTracker } from "./runTracker";
import { TaskMonitor, type TasksApi, type TaskSettings } from "./tasks";

const SECTION = "kibo";
const cfg = () => vscode.workspace.getConfiguration(SECTION);

export function activate(context: vscode.ExtensionContext): void {
  let channel: vscode.OutputChannel | undefined;
  const log = new Logger(
    () => (channel ??= vscode.window.createOutputChannel("Kibo")),
    () => cfg().get<LogLevel>("logLevel", "error"),
  );

  // One log line when availability changes, never per event. Reasons are fixed codes; the token is never logged.
  const client = new KiboClient({ onStatus: (s, reason) => (s === "available" ? log.info("Kibo is available.") : log.info(`Kibo unavailable (${reason}); events are skipped until it is back.`)) });

  const reporting = () => cfg().get<boolean>("reporting.enabled", true);
  const mk = (source: string) => new RunTracker({ source, send: (event, meta) => client.send(event, meta), enabled: reporting });
  const trackers = { build: mk("vscode"), test: mk("vscode-test") };

  const settings = (): TaskSettings => ({
    buildEnabled: cfg().get<boolean>("build.enabled", true),
    buildScope: cfg().get<"buildGroup" | "all">("build.taskScope", "buildGroup"),
    testsEnabled: cfg().get<boolean>("tests.enabled", false),
  });
  const monitor = new TaskMonitor(vscode.tasks as unknown as TasksApi, trackers, settings);

  const diag = new DiagnosticsTracker({
    read: () => {
      let errors = 0, warnings = 0;
      for (const [, list] of vscode.languages.getDiagnostics()) for (const d of list) {   // severity only; message/range/uri are never read
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++; else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      }
      return { errors, warnings };
    },
    onTransition: (t, c) => { if (mapTransition(t) === null) log.info(`Diagnostics ${t} (errors=${c.errors}, warnings=${c.warnings}); no Kibo event exists for this, nothing sent.`); },
  });
  const diagSub = vscode.languages.onDidChangeDiagnostics(() => { if (reporting() && cfg().get<boolean>("diagnostics.enabled", false)) diag.notify(); });

  const ctl = new Controller({
    client,
    reportingEnabled: reporting,
    setReporting: (on) => cfg().update("reporting.enabled", on, vscode.ConfigurationTarget.Global),
    ui: { info: (m) => void vscode.window.showInformationMessage(m), warn: (m) => void vscode.window.showWarningMessage(m) },
  });

  const reg = vscode.commands.registerCommand;
  context.subscriptions.push(
    monitor.register(), diagSub,
    { dispose: () => { trackers.build.dispose(); trackers.test.dispose(); diag.dispose(); channel?.dispose(); } },
    reg("kibo.checkConnection", () => ctl.checkConnection()),
    reg("kibo.testHappy", () => ctl.testHappy()),
    reg("kibo.testError", () => ctl.testError()),
    reg("kibo.enableReporting", () => ctl.enable()),
    reg("kibo.disableReporting", () => ctl.disable()),
  );
}

export function deactivate(): void { /* subscriptions dispose everything */ }
