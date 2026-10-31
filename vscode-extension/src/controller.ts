import type { KiboClient } from "./client";

export interface Ui { info(msg: string): void; warn(msg: string): void }
export interface ControllerDeps {
  client: Pick<KiboClient, "sendNow">;
  reportingEnabled: () => boolean;
  setReporting: (on: boolean) => PromiseLike<void> | void;
  ui: Ui;
}

const SOURCE = "vscode";

const REASONS: Record<string, string> = {
  "not-running": "Kibo does not seem to be running (no discovery file, or nothing is listening). Start Kibo and try again.",
  "invalid-discovery": "Kibo's discovery file is invalid or from an unsupported version. Restart Kibo.",
  timeout: "Kibo did not answer in time.",
  unauthorized: "Kibo rejected the token (stale discovery file?). Restart Kibo or this window.",
  closed: "Kibo closed the connection without answering.",
  busy: "Kibo is busy. Try again in a moment.",
};
export const explain = (reason: string) => REASONS[reason] ?? `Kibo could not accept the event (${/^[a-z-]{1,40}$/.test(reason) ? reason : "error"}).`;

/** Command behaviour, free of VS Code imports so it can be tested. Messages appear only as a direct answer to a command. */
export class Controller {
  constructor(private d: ControllerDeps) {}

  private async sendOrExplain(event: string, ok: string) {
    if (!this.d.reportingEnabled()) { this.d.ui.warn("Kibo event reporting is disabled. Run \"Kibo: Enable Event Reporting\" first."); return; }
    const r = await this.d.client.sendNow(event, { source: SOURCE });
    if (r.ok) this.d.ui.info(ok); else this.d.ui.warn(explain(r.reason));
  }

  /** Uses `system_idle`: authenticated and whitelisted, but Kibo shows no reaction for it, so the check is invisible. */
  checkConnection() { return this.sendOrExplain("system_idle", "Connected to Kibo."); }
  testHappy() { return this.sendOrExplain("build_succeeded", "Sent a \"build succeeded\" event. Kibo may stay quiet if asleep, hidden, in quiet mode or on cooldown."); }
  testError() { return this.sendOrExplain("build_failed", "Sent a \"build failed\" event. Kibo may stay quiet if asleep, hidden, in quiet mode or on cooldown."); }
  async enable() { await this.d.setReporting(true); this.d.ui.info("Kibo event reporting enabled."); }
  async disable() { await this.d.setReporting(false); this.d.ui.info("Kibo event reporting disabled. Nothing will be sent."); }
}
