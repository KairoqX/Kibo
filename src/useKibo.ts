import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { KiboState } from "./Kibo";
import { SETTINGS_KEY, loadSettings, saveSettings, type Settings, type StorageLike } from "./settings";

/* ---------- settings (shared between the pet and dashboard windows) ---------- */
// Types, defaults, validation and persistence live in settings.ts (pure, unit-tested).
export { DEFAULT_SETTINGS, type Settings } from "./settings";

const browserStorage = (): StorageLike | null => { try { return localStorage; } catch { return null; } };

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings(browserStorage()));
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === SETTINGS_KEY) setSettings(loadSettings(browserStorage())); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(browserStorage(), next);
      return next;
    });
  }, []);
  return [settings, update] as const;
}

/* ---------- messages ---------- */
export const POOLS: Record<KiboState, string[]> = {
  idle: [
    "Ready when you are!", "One step at a time!", "I'm right here.", "Whenever you're ready!",
    "No rush. We've got time.", "Small steps count!", "Good things take a few tries.", "Let's build something nice.",
  ],
  typing: [
    "Let's keep going!", "You're doing great!", "Nice rhythm!", "Look at those keys go!",
    "Steady and strong!", "You're in the groove!", "Keep that momentum!", "Great pace!",
  ],
  coding: [
    "Locked in. I'm right here.", "Focus looks good on you!", "Deep in the zone!", "I'll stay quiet. You've got this.",
    "Nice and focused!", "Flow state unlocked!", "Take your time. No pressure.",
  ],
  happy: [
    "Nice one!", "That's looking good!", "Keep it up!", "Yes! That's the stuff!",
    "Love that progress!", "Smooth work!", "That felt good!", "Look at that go!",
  ],
  wave: [
    "Hi there!", "Hey, you!", "Hello, builder!", "Oh, hello!",
    "Good to see you!", "Hiya!", "Hey hey!", "Nice to see you here!",
  ],
  achievement: [
    "Another milestone!", "Nice progress!", "We fixed it!", "Look at you go!",
    "High five!", "That's a big one!", "You earned this!", "Milestone unlocked!", "Awesome work today!",
  ],
  break: [
    "Time for a tiny break?", "Stretch and sip some water?", "Rest your eyes for a moment?", "A short walk might help!",
    "Breaks make you sharper.", "Maybe a snack break?", "Shoulders down, deep breath.", "Look away from the screen for a bit?",
  ],
  sleep: [],
  encourage: [
    "You're doing great!", "I'm rooting for you!", "You've got this!", "One step at a time!",
    "Proud of you!", "Keep going, you're close!", "Every line counts!", "You're better than you think!",
    "Progress is progress!", "I believe in you!",
  ],
  error: [
    "Bugs happen. We'll sort it out!", "Take a breath. We can fix this.", "It's okay, we'll figure it out together.",
    "Even great devs hit errors.", "Read it slowly. The clue is in there.", "One bug at a time.",
    "You've solved harder ones!", "Step back, then try again.",
  ],
};
const WELCOME_BACK = [
  "Welcome back!", "Ready when you are!", "There you are!", "Good to have you back!",
  "Missed you! Let's go.", "Back to it!", "Fresh start, fresh ideas!",
];

/** Short, occasional lines for pointer interactions (the caller rate-limits them). */
export const INTERACTION_POOLS = {
  hover: ["Hey!", "Oh, hi!", "Hi, builder!", "Hello there!", "You called?", "Oh! Hey!", "Need me?", "Psst, hi!"],
  pat: ["Hehe!", "Nice!", "That's nice!", "Ooh, that feels good!", "Aww, thanks!", "Yay!", "More pats, please!", "I like that!", "Hehe, thank you!"],
  patStreak: ["Let's code!", "Okay, I'm happy!", "You're the best!", "Now I'm ready to build!", "Energy restored!", "Let's make something great!"],
  poke: ["Hey!", "Boop!", "Hehe, that tickles!", "Oh! Hi!", "Eep!", "What's up?", "I'm ticklish!", "Boing!", "You got me!"],
  giggle: ["Hehehe!", "Okay, okay!", "You're silly!", "Hahaha, stop!", "That tickles!", "I give up, you win!", "Alright, alright!"],
  drop: ["Whoa!", "New spot!", "Wheee!", "Nice view!", "Comfy here!", "Ooh, I like it here!", "Landed it!", "Cozy corner!"],
  wake: ["Oh! Hi!", "I'm up, I'm up!", "Mm? Oh, hello!", "I was just resting my eyes!", "Good to see you!", "Back online!"],
} as const;

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
  const [pulse, setPulse] = useState(0);   // bumps on every trigger so Kibo can replay a one-shot
  const sref = useRef(settings);
  sref.current = settings;

  const r = useRef({
    lastKey: 0, burstStart: 0, lastActivity: Date.now(), lastTick: Date.now(), nextHappy: 100,
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
    c.recent = [m, ...c.recent].slice(0, 10);
    c.lastMsgAt = now;
    setMessage(m);
    window.clearTimeout(c.hideTimer);
    c.hideTimer = window.setTimeout(() => setMessage(null), 4000);
  }, []);

  /** Pointer-interaction bubble: short, rate-limited, shares the single bubble slot with `say`. */
  const speak = useCallback((pool: readonly string[], { gap = 8000, show = 2400 } = {}) => {
    const c = r.current, s = sref.current, now = Date.now();
    if (!s.messages || pool.length === 0) return false;
    if (now - c.lastMsgAt < (s.quiet ? gap * 3 : gap)) return false;
    const fresh = pool.filter((x) => !c.recent.includes(x));            // avoid anything said in the last few bubbles
    const notLast = pool.filter((x) => x !== c.recent[0]);
    const m = pick(fresh.length ? fresh : notLast.length ? notLast : [...pool]);
    c.recent = [m, ...c.recent].slice(0, 10); c.lastMsgAt = now;
    setMessage(m);
    window.clearTimeout(c.hideTimer);
    c.hideTimer = window.setTimeout(() => setMessage(null), show);
    return true;
  }, []);

  /** Any deliberate interaction counts as activity so Kibo does not fall asleep under the user's hand. */
  const touch = useCallback(() => { r.current.lastActivity = Date.now(); }, []);

  const trigger = useCallback((s: KiboState, ms = 4000, withMessage = true) => {
    const c = r.current, now = Date.now();
    c.lastActivity = now;
    c.override = s === "idle" ? null : { state: s, until: now + ms };
    c.prev = s;
    setState(s);
    setPulse((n) => n + 1);
    if (withMessage) say(POOLS[s], true);
  }, [say]);

  /**
   * Event reaction overlay (reactive companion). Like `trigger`, but does NOT reset the inactivity
   * timer, so once the short reaction ends Kibo falls back to the state he was really in
   * (e.g. still "break" or "sleep") instead of being silently woken. Pass `wake` to opt in to waking.
   */
  const react = useCallback((s: KiboState, ms: number, wake = false) => {
    if (wake) { trigger(s, ms, false); return; }
    const c = r.current, now = Date.now();
    c.override = { state: s, until: now + ms };
    c.prev = s;
    setState(s);
    setPulse((n) => n + 1);
  }, [trigger]);

  const noteKey = useCallback(() => {
    const c = r.current, now = Date.now();
    if (now - c.lastKey > 3000) c.burstStart = now;
    c.lastKey = now; c.lastActivity = now; c.keys += 1;
    if (c.keys >= c.nextKeys) {
      c.nextKeys += 300; c.nextHappy = c.nextKeys - 200;      // next small cheer 100 keys later
      trigger("achievement", 4200);
    } else if (c.keys >= c.nextHappy) { c.nextHappy += 100; trigger("happy", 2800, false); }
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

  return { state, message, trigger, react, pulse, speak, touch };
}
