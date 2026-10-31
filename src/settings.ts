/**
 * Settings shared by the pet window and the dashboard. Pure (no React / Tauri) so it can be tested
 * in plain Node; `useSettings` in useKibo.ts wraps it with React state.
 */
export type Settings = {
  messages: boolean;     // show encouragement speech bubbles
  quiet: boolean;        // fewer, calmer bubbles and subtler reactions (also applies to events)
  sleepyAfter: number;   // seconds of inactivity before "break"; sleep starts at 2x
  motion: "system" | "full"; // "system" follows the OS reduced-motion setting (gentle); "full" always animates fully
  aware: boolean;        // pointer awareness: look at the cursor + let clicks pass through transparent areas
  petSize: "small" | "normal" | "large";
  // --- reactive companion (Alpha 0.2) ---
  devEvents: boolean;         // react to build / task events reported by the Kibo CLI
  activityEvents: boolean;    // react to "user returned" style activity events
  eventMessages: boolean;     // speech bubbles for event reactions (needs `messages` on too)
  longTaskCelebrate: boolean; // stronger celebration when a long-running task finishes
  eventsWake: boolean;        // allow events to wake a sleeping Kibo (off: sleeping Kibo ignores events)
};

export const SETTINGS_KEY = "kibo.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  messages: true, quiet: false, sleepyAfter: 120, motion: "system", aware: true, petSize: "normal",
  devEvents: true, activityEvents: true, eventMessages: true, longTaskCelebrate: true, eventsWake: false,
};

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Merges stored values over the defaults, dropping anything of the wrong type. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    messages: bool(o.messages, d.messages),
    quiet: bool(o.quiet, d.quiet),
    sleepyAfter: typeof o.sleepyAfter === "number" && o.sleepyAfter >= 5 && o.sleepyAfter <= 3600 ? o.sleepyAfter : d.sleepyAfter,
    motion: o.motion === "full" || o.motion === "system" ? o.motion : d.motion,
    aware: bool(o.aware, d.aware),
    petSize: o.petSize === "small" || o.petSize === "normal" || o.petSize === "large" ? o.petSize : d.petSize,
    devEvents: bool(o.devEvents, d.devEvents),
    activityEvents: bool(o.activityEvents, d.activityEvents),
    eventMessages: bool(o.eventMessages, d.eventMessages),
    longTaskCelebrate: bool(o.longTaskCelebrate, d.longTaskCelebrate),
    eventsWake: bool(o.eventsWake, d.eventsWake),
  };
}

export function loadSettings(storage: StorageLike | null | undefined): Settings {
  try { return sanitizeSettings(JSON.parse(storage?.getItem(SETTINGS_KEY) ?? "{}")); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(storage: StorageLike | null | undefined, s: Settings): boolean {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(s)); return !!storage; } catch { return false; }
}
