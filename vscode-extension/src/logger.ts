export type LogLevel = "off" | "error" | "info";
export interface Sink { appendLine(s: string): void }
const RANK: Record<LogLevel, number> = { off: 0, error: 1, info: 2 };

/** Output-channel logger. Messages are short, fixed strings/reason codes; nothing sensitive is ever passed in. */
export class Logger {
  constructor(private sink: () => Sink, private level: () => LogLevel) {}
  private w(l: LogLevel, m: string) { if (RANK[this.level()] >= RANK[l]) this.sink().appendLine(`[${l}] ${m}`); }
  info(m: string) { this.w("info", m); }
  error(m: string) { this.w("error", m); }
}
