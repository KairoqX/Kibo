import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { KiboState } from "./Kibo";

/* ---------- settings (shared between the pet and dashboard windows) ---------- */
export type Settings = {
  messages: boolean;     // show encouragement speech bubbles
  quiet: boolean;        // fewer, calmer bubbles while focusing
  sleepyAfter: number;   // seconds of inactivity before "break"; sleep starts at 2x
};
const KEY = "kibo.settings.v1";
export const DEFAULT_SETTINGS: Settings = { messages: true, quiet: false, sleepyAfter: 120 };

function load(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; }
  catch { return DEFAULT_SETTINGS; }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === KEY) setSettings(load()); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);
  return [settings, update] as const;
}

/* ---------- messages ---------- */
export const POOLS: Record<KiboState, string[]> = {
  idle: ["Ready when you are!", "One step at a time!"],
  typing: ["Let's keep going!", "You're doing great!", "Nice rhythm!"],
  coding: ["Locked in. I'm right here.", "Focus looks good on you!"],
  achievement: ["Another milestone!", "Nice progress!", "We fixed it!", "Look at you go!"],
  break: ["Time for a tiny break?", "Stretch and sip some water?"],
  sleep: [],
  encourage: ["You're doing great!", "I'm rooting for you!", "You've got this!", "One step at a time!"],
  error: ["Bugs happen. We'll sort it out!", "Take a breath. We can fix this.", "It's okay, we'll figure it out together."],
};
const WELCOME_BACK = ["Welcome back!", "Ready when you are!"];

/* ---------- cross-window activity events ---------- */
export type ActivityEvent = { state: KiboState; ms?: number };
export const ACTIVITY_EVENT = "kibo:activity";

/** Broadcast to every Kibo window. Returns false outside Tauri (plain browser). */
export async function sendActivity(e: ActivityEvent): Promise<boolean> {
  try { await emit(ACTIVITY_EVENT, e); return true; } catch { return false; }
}

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const between = (minS: number, maxS: number) => (minS + Math.random() * (maxS - minS)) * 1000;

/**
 * Kibo's state machine.
 * Privacy: only the *timing/count* of key presses inside Kibo's own windows is used.
 * Key identities and typed text are never read or stored.
 */
export function useKibo(settings: Settings) {
  const [state, setState] = useState<KiboState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const sref = useRef(settings);
  sref.current = settings;

  const r = useRef({
    lastKey: 0, burstStart: 0, lastActivity: Date.now(), lastTick: Date.now(),
    override: null as null | { state: KiboState; until: number },
    prev: "idle" as KiboState, keys: 0, nextKeys: 300,
    activeMs: 0, nextActiveMs: 15 * 60_000,
    lastMsgAt: 0, recent: [] as string[], hideTimer: 0,
    nextCheer: Date.now() + between(240, 420),
  });

  const say = useCallback((pool: string[], force = false) => {
    const c = r.current, s = sref.current, now = Date.now();
    if (!s.messages || pool.length === 0) return;
    const gap = force ? 6_000 : s.quiet ? 90_000 : 25_000;   // never spam
    if (now - c.lastMsgAt < gap) return;
    const fresh = pool.filter((m) => !c.recent.includes(m));
    const notLast = pool.filter((m) => m !== c.recent[0]);   // never repeat back to back
    const m = pick(fresh.length ? fresh : notLast.length ? notLast : pool);
    c.recent = [m, ...c.recent].slice(0, 6);
    c.lastMsgAt = now;
    setMessage(m);
    window.clearTimeout(c.hideTimer);
    c.hideTimer = window.setTimeout(() => setMessage(null), 4000);
  }, []);

  const trigger = useCallback((s: KiboState, ms = 4000, withMessage = true) => {
    const c = r.current, now = Date.now();
    c.lastActivity = now;
    c.override = s === "idle" ? null : { state: s, until: now + ms };
    c.prev = s;
    setState(s);
    if (withMessage) say(POOLS[s], true);
  }, [say]);

  const noteKey = useCallback(() => {
    const c = r.current, now = Date.now();
    if (now - c.lastKey > 3000) c.burstStart = now;
    c.lastKey = now; c.lastActivity = now; c.keys += 1;
    if (c.keys >= c.nextKeys) { c.nextKeys += 300; trigger("achievement", 4200); }
  }, [trigger]);

  // key activity (counts only)
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (!e.repeat) noteKey(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [noteKey]);

  // events from other windows / the Rust side
  useEffect(() => {
    let off: (() => void) | undefined, dead = false;
    listen<ActivityEvent>(ACTIVITY_EVENT, (e) => {
      const p = e.payload;
      if (p.state === "typing") noteKey(); else trigger(p.state, p.ms ?? 5000);
    }).then((f) => { if (dead) f(); else off = f; }).catch(() => { /* not running in Tauri */ });
    return () => { dead = true; off?.(); };
  }, [noteKey, trigger]);

  // single lightweight 500 ms tick drives all passive transitions
  useEffect(() => {
    const id = window.setInterval(() => {
      const c = r.current, now = Date.now(), dt = now - c.lastTick;
      c.lastTick = now;
      const sinceKey = now - c.lastKey;
      let next: KiboState;
      if (c.override && now < c.override.until) next = c.override.state;
      else {
        c.override = null;
        const focused = now - c.burstStart > 8000;
        if (sinceKey < 1500) next = focused ? "coding" : "typing";
        else if (sinceKey < 4000 && focused) next = "coding";
        else {
          const idleS = (now - c.lastActivity) / 1000, n = sref.current.sleepyAfter;
          next = idleS > n * 2 ? "sleep" : idleS > n ? "break" : "idle";
        }
      }
      if (sinceKey < 3000) {
        c.activeMs += dt;
        if (c.activeMs >= c.nextActiveMs) { c.nextActiveMs += 15 * 60_000; trigger("achievement", 4200); return; }
      }
      if (next !== c.prev) {
        const was = c.prev; c.prev = next;
        if (next === "typing" && (was === "break" || was === "sleep")) say(WELCOME_BACK, true);
        else if (next === "typing" || next === "coding" || next === "break") say(POOLS[next]);
      }
      if (next === "idle" && now >= c.nextCheer) {
        c.nextCheer = now + between(240, 420);
        trigger("encourage", 3800);
        return;
      }
      setState(next);
    }, 500);
    return () => window.clearInterval(id);
  }, [say, trigger]);

  useEffect(() => { if (!settings.messages) setMessage(null); }, [settings.messages]);

  return { state, message, trigger };
}
