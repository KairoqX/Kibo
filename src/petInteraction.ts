/**
 * Desktop-pet interaction controller
 * ----------------------------------
 * Plain TypeScript (no React state per frame). It owns:
 *   - click-through: the transparent window ignores the mouse except where Kibo is actually drawn;
 *   - cursor awareness: Kibo looks toward the pointer when it is near (even outside the window);
 *   - click / pat / poke / repeated-click policy with a cooldown;
 *   - dragging with the OS's native window drag (smooth), lean-from-velocity, soft landing;
 *   - keeping Kibo reachable (clamped into the nearest monitor, never lost off-screen);
 *   - size presets.
 *
 * Privacy: the only input signal used is the pointer POSITION relative to Kibo, read locally,
 * never stored, logged or transmitted. No keystrokes, no window titles, no screen content.
 *
 * Polling is only used because a click-through window receives no mouse events. It runs on a
 * setTimeout chain (never overlapping), fast only while the pointer is near Kibo, slow when far,
 * slower still when the pointer is still, and stops completely while Kibo is hidden.
 */
import { availableMonitors, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import type { KiboRig } from "./kiboRig";
import type { KiboState } from "./kiboRig";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type PetEvent = "hover" | "pat" | "patStreak" | "poke" | "giggle" | "wake" | "pickup" | "drop";

export interface PetHooks {
  rig: () => KiboRig | null;
  robot: () => HTMLElement | null;
  getState: () => KiboState;
  /** semantic events for the React side (speech bubbles, activity timers, state changes) */
  onEvent: (e: PetEvent) => void;
  /** pointer is over Kibo (true) / has left it (false, after a short grace period) */
  onPresence: (on: boolean) => void;
}

/* ---- layout constants shared with kibo.css (CSS pixels at scale 1) ---- */
export const SCALES = { small: 0.8, normal: 1, large: 1.25 } as const;
export type PetSize = keyof typeof SCALES;
const BASE_W = 60, BASE_H = 81, ROBOT_W = 200, ROBOT_H = 241;
export const windowSizeFor = (s: number) => ({ w: Math.round(BASE_W + ROBOT_W * s), h: Math.round(BASE_H + ROBOT_H * s) });

/* ---- behaviour tunables ---- */
const DRAG_THRESHOLD = 5;          // px before a press becomes a drag
const NEAR = 140, FAR = 420;       // attention radius (CSS px): full attention inside NEAR, none beyond FAR
const LOSE_INTEREST_MS = 5000;     // a motionless cursor stops holding Kibo's attention
const GRACE_MS = 700;              // hover buttons stay for a moment so the pointer can reach them
const CLICKS_FOR_GIGGLE = 4, CLICK_WINDOW_MS = 2400, GIGGLE_COOLDOWN_MS = 5500;
const MIN_POLL = 33, MID_POLL = 100, SLOW_POLL = 250;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const sstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

type Rect = { x: number; y: number; w: number; h: number };
type MonitorLike = {
  position: { x: number; y: number }; size: { width: number; height: number };
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
};
const areaOf = (m: MonitorLike): Rect => {
  const a = m.workArea ?? { position: m.position, size: m.size };   // work area (taskbar excluded) when the runtime provides it
  return { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height };
};

export class PetController {
  private win = isTauri() ? getCurrentWindow() : null;
  private running = false;
  private visible = true;
  aware = true;                       // cursor awareness + click-through (user setting)

  // window geometry cache (physical px), kept fresh by onMoved + a slow refresh
  private winX = 0; private winY = 0; private lastPosRefresh = 0;
  private unlistenMoved: (() => void) | null = null;
  private lastMoveEvt = 0;

  // polling / click-through
  private timer = 0; private polling = false;
  private ignoring = false; private ignoreBusy = false; private failures = 0;
  private lastCursor = { x: NaN, y: NaN }; private lastCursorMove = 0;
  private hover = false; private presence = false; private presenceTimer = 0;
  private lastHit = false;

  // press / drag
  private press: { x: number; y: number; zone: "head" | "body"; dragged: boolean } | null = null;
  private armed = false; private dragMoved = false; private lastDragMove = 0; private armedAt = 0;
  private watch = 0;

  // click policy
  private clicks: number[] = []; private cooldownUntil = 0; private lastMini = 0; private pats: number[] = [];

  private glideId = 0;
  private scale = 1;

  constructor(private h: PetHooks) {}

  /* ------------------------------------------------------------ lifecycle */
  async start() {
    if (this.running) return;
    this.running = true;
    window.addEventListener("pointermove", this.onWinPointerMove);
    window.addEventListener("pointerup", this.onWinPointerUp);
    window.addEventListener("pointercancel", this.onWinPointerUp);
    document.addEventListener("visibilitychange", this.onVisibility);
    const win = this.win;
    if (win) {
      try {
        const p = await win.outerPosition();
        this.winX = p.x; this.winY = p.y; this.lastPosRefresh = performance.now();
        const un = await win.onMoved(({ payload }) => this.onMoved(payload.x, payload.y));
        if (this.running) this.unlistenMoved = un; else un();
      } catch { /* geometry unavailable: awareness will simply stay off */ }
    }
    if (!this.running) return;
    this.watch = window.setInterval(this.watchDrag, 80);
    this.schedule(0);
  }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer); window.clearTimeout(this.presenceTimer); window.clearInterval(this.watch);
    window.removeEventListener("pointermove", this.onWinPointerMove);
    window.removeEventListener("pointerup", this.onWinPointerUp);
    window.removeEventListener("pointercancel", this.onWinPointerUp);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unlistenMoved?.(); this.unlistenMoved = null;
    this.glideId++;
    // never leave the window click-through when we are gone
    if (this.ignoring && this.win) this.win.setIgnoreCursorEvents(false).catch(() => {});
    this.ignoring = false;
  }

  setAware(on: boolean) {
    this.aware = on;
    if (!on) {
      this.h.rig()?.setLook(0, 0, 0); this.setIgnore(false);
    } else this.schedule(0);
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v) {
      this.win?.setAlwaysOnTop(true).catch(() => {});
      this.schedule(0);
      this.keepOnScreen(false);
    } else {
      window.clearTimeout(this.timer);
      this.h.rig()?.setLook(0, 0, 0); this.h.rig()?.setHover(false);
      this.setPresence(false, true); this.hover = false;
    }
  }

  /* ------------------------------------------------------------- polling */
  private schedule(ms: number) {
    window.clearTimeout(this.timer);
    if (!this.running || !this.visible) return;
    this.timer = window.setTimeout(() => { void this.poll(); }, ms);
  }

  private onVisibility = () => { if (!document.hidden) this.schedule(0); };

  private async poll() {
    if (!this.running || !this.visible || this.polling) return;
    if (document.hidden || !this.aware || !this.win) { this.schedule(500); return; }
    this.polling = true;
    let delay = SLOW_POLL;
    try {
      const now = performance.now();
      if (now - this.lastPosRefresh > 1500) {
        const p = await this.win.outerPosition();
        this.winX = p.x; this.winY = p.y; this.lastPosRefresh = now;
      }
      const c = await this.win.cursorPosition();
      if (!this.running) return;
      this.failures = 0;
      delay = this.onCursor(c.x, c.y);
    } catch {
      // Permission/IPC problem: fail OPEN (window becomes normally clickable) rather than unreachable.
      if (++this.failures >= 4) { this.aware = false; await this.setIgnore(false); }
    } finally { this.polling = false; }
    this.schedule(delay);
  }

  /** Handles one global cursor sample (physical px). Returns the delay before the next sample. */
  private onCursor(px: number, py: number): number {
    const dpr = window.devicePixelRatio || 1;
    return this.onLocal((px - this.winX) / dpr, (py - this.winY) / dpr, px, py);
  }

  private onLocal(lx: number, ly: number, rawX = lx, rawY = ly): number {
    const now = performance.now();
    if (rawX !== this.lastCursor.x || rawY !== this.lastCursor.y) { this.lastCursor = { x: rawX, y: rawY }; this.lastCursorMove = now; }
    const el = document.elementFromPoint(lx, ly);
    const hit = !!el?.closest("[data-hit]");
    this.lastHit = hit;
    const interacting = hit || !!this.press || this.armed;
    if (this.win && this.aware) void this.setIgnore(!interacting);

    const interested = now - this.lastCursorMove < LOSE_INTEREST_MS;
    const hov = hit && !this.armed && interested;
    if (hov !== this.hover) {
      this.hover = hov;
      this.h.rig()?.setHover(hov);
      if (hov) this.h.onEvent("hover");
    }
    this.setPresence(hit || this.armed);

    // look toward the pointer
    const rig = this.h.rig(), robot = this.h.robot();
    let dist = Infinity;
    if (rig && robot) {
      const r = robot.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height * (82 / 241);
      const dx = lx - cx, dy = ly - cy, k = r.width / ROBOT_W;
      dist = Math.hypot(dx, dy);
      const att = interested && !this.armed ? 1 - sstep(NEAR * k, FAR * k, dist) : 0;
      rig.setLook(Math.tanh(dx / (140 * k)), 0.8 * Math.tanh(dy / (140 * k)), att);
    }
    if (interacting || dist < FAR) return MIN_POLL;
    return now - this.lastCursorMove < 2000 ? MID_POLL : SLOW_POLL;
  }

  private setPresence(on: boolean, immediate = false) {
    if (on) {
      window.clearTimeout(this.presenceTimer); this.presenceTimer = 0;
      if (!this.presence) { this.presence = true; this.h.onPresence(true); }
    } else if (this.presence && !this.presenceTimer) {
      const off = () => { this.presenceTimer = 0; this.presence = false; this.h.onPresence(false); };
      if (immediate) off(); else this.presenceTimer = window.setTimeout(off, GRACE_MS);
    }
  }

  private async setIgnore(v: boolean) {
    if (!this.win || v === this.ignoring || this.ignoreBusy) return;
    this.ignoreBusy = true;
    try { await this.win.setIgnoreCursorEvents(v); this.ignoring = v; }
    catch { this.aware = false; this.ignoring = false; }       // not allowed → stay fully clickable
    finally { this.ignoreBusy = false; }
  }

  /* ----------------------------------------------- pointer events (React) */
  /** In a plain browser (no Tauri) the window's own pointer events drive look/hover. */
  private onWinPointerMove = (e: PointerEvent) => {
    if (this.armed && this.dragMoved && e.buttons === 0) this.release();     // OS drag loop ended
    if (!this.win && this.visible) this.onLocal(e.clientX, e.clientY);
  };
  private onWinPointerUp = () => {
    if (this.armed && this.dragMoved) this.release();
    if (!this.armed) this.press = null;                                      // (the React pointerup handler already ran)
  };

  pointerDown(e: { button: number; clientX: number; clientY: number; target: EventTarget | null }) {
    if (e.button !== 0) return;
    const zone = (e.target as Element | null)?.closest?.('[data-p="head"]') ? "head" : "body";
    this.press = { x: e.clientX, y: e.clientY, zone, dragged: false };
  }

  pointerMove(e: { buttons: number; clientX: number; clientY: number }) {
    const p = this.press;
    if (!p || p.dragged || !(e.buttons & 1)) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) this.beginDrag(p);
  }

  pointerUp(e: { clientX: number }) {
    const p = this.press;
    if (!p || p.dragged) return;
    this.press = null;
    const robot = this.h.robot();
    const r = robot?.getBoundingClientRect();
    const dir = r ? (r.left + r.width / 2 - e.clientX >= 0 ? 1 : -1) : 1;    // recoil away from the poke
    this.click(p.zone, dir);
  }

  /** Enter/Space on the focused robot */
  activate() { this.click("body", Math.random() < 0.5 ? 1 : -1); }

  /* ----------------------------------------------------------------- drag */
  private beginDrag(p: NonNullable<PetController["press"]>) {
    p.dragged = true;
    this.armed = true; this.dragMoved = false; this.armedAt = this.lastDragMove = performance.now();
    this.glideId++;
    this.h.rig()?.setDrag(true); this.h.rig()?.setHover(false);
    this.h.onEvent("pickup");
    if (this.win) this.win.startDragging().catch(() => this.release());
    else this.dragMoved = true;                // plain browser: nothing to drag, behave as a tap-and-hold
  }

  private onMoved(x: number, y: number) {
    const now = performance.now(), dpr = window.devicePixelRatio || 1;
    const dt = Math.max(0.008, (now - (this.lastMoveEvt || now - 16)) / 1000);
    const vx = (x - this.winX) / dpr / dt;
    this.lastMoveEvt = now;
    this.winX = x; this.winY = y; this.lastPosRefresh = now;
    this.h.rig()?.dragVelocity(vx);
    if (this.armed) { this.dragMoved = true; this.lastDragMove = now; }
  }

  /** Native drag loops swallow the pointer-up, so release is inferred from "window stopped moving". */
  private watchDrag = () => {
    if (!this.armed) return;
    const now = performance.now();
    if (now - this.lastDragMove > (this.dragMoved ? 180 : 700)) this.release();
  };

  private release() {
    if (!this.armed) return;
    this.armed = false; this.dragMoved = false; this.press = null;
    const rig = this.h.rig();
    rig?.setDrag(false); rig?.react("land");
    this.h.onEvent("drop");
    window.setTimeout(() => { if (this.running) void this.keepOnScreen(true); }, 120);
  }

  /* ---------------------------------------------------------------- clicks */
  private click(zone: "head" | "body", dir: number) {
    const rig = this.h.rig(); if (!rig) return;
    const now = performance.now();
    this.clicks = this.clicks.filter((t) => now - t < CLICK_WINDOW_MS); this.clicks.push(now);
    const st = this.h.getState();
    if (st === "sleep" || st === "break") { this.clicks = []; this.h.onEvent("wake"); return; }
    if (now < this.cooldownUntil) {                // cooling down: a tiny acknowledgement, no bubble, no new routine
      if (now - this.lastMini > 650) { rig.react(zone === "head" ? "pat" : "poke", 0.4, dir); this.lastMini = now; }
      return;
    }
    if (this.clicks.length >= CLICKS_FOR_GIGGLE) {
      this.clicks = []; this.cooldownUntil = now + GIGGLE_COOLDOWN_MS;
      rig.react("giggle"); this.h.onEvent("giggle"); return;
    }
    if (zone === "head") {
      this.pats = this.pats.filter((t) => now - t < 6000); this.pats.push(now);
      rig.react("pat", 1, dir);
      if (this.pats.length >= 3) { this.pats = []; this.h.onEvent("patStreak"); } else this.h.onEvent("pat");
    } else { rig.react("poke", 1, dir); this.h.onEvent("poke"); }
  }

  /* ----------------------------------------------- keeping Kibo reachable */
  /** Clamp the pet into the nearest monitor's work area (taskbar excluded when the runtime reports it). */
  async keepOnScreen(animate = true) {
    const win = this.win, robot = this.h.robot();
    if (!win || !robot || this.armed) return;
    try {
      const [pos, mons] = await Promise.all([win.outerPosition(), availableMonitors()]);
      this.winX = pos.x; this.winY = pos.y;
      if (!mons.length) return;
      const dpr = window.devicePixelRatio || 1, r = robot.getBoundingClientRect();
      const rl = r.left * dpr, rr = r.right * dpr, rb = r.bottom * dpr, bubbleTop = Math.max(0, r.top - 56) * dpr;
      const cx = pos.x + (rl + rr) / 2, cy = pos.y + ((r.top + r.bottom) / 2) * dpr;
      let best = areaOf(mons[0] as MonitorLike), bd = Infinity;
      for (const m of mons) {
        const a = areaOf(m as MonitorLike);
        const d = Math.hypot(Math.max(a.x - cx, 0, cx - (a.x + a.w)), Math.max(a.y - cy, 0, cy - (a.y + a.h)));
        if (d < bd) { bd = d; best = a; }
      }
      const margin = 6 * dpr;
      let nx = pos.x, ny = pos.y;
      const minX = best.x + margin - rl, maxX = best.x + best.w - margin - rr;
      const minY = best.y - bubbleTop, maxY = best.y + best.h - margin - rb;
      if (minX <= maxX) nx = clamp(nx, minX, maxX);
      if (minY <= maxY) ny = clamp(ny, minY, maxY);
      nx = Math.round(nx); ny = Math.round(ny);
      if (Math.abs(nx - pos.x) < 1 && Math.abs(ny - pos.y) < 1) return;
      if (animate) await this.glideTo(nx, ny); else await win.setPosition(new PhysicalPosition(nx, ny));
    } catch { /* monitor info unavailable: leave the window where it is */ }
  }

  private glideTo(x: number, y: number) {
    const win = this.win!, id = ++this.glideId, fx = this.winX, fy = this.winY, t0 = performance.now(), D = 240;
    return new Promise<void>((resolve) => {
      const step = async () => {
        if (id !== this.glideId || !this.running) return resolve();
        const u = clamp((performance.now() - t0) / D, 0, 1), e = 1 - Math.pow(1 - u, 3);
        try { await win.setPosition(new PhysicalPosition(Math.round(fx + (x - fx) * e), Math.round(fy + (y - fy) * e))); }
        catch { return resolve(); }
        if (u < 1) requestAnimationFrame(step); else resolve();
      };
      void step();
    });
  }

  /** Bottom-right of the primary monitor (tray: "Bring Kibo back"). */
  async resetPosition() {
    const win = this.win; if (!win) return;
    try {
      const m = await primaryMonitor();
      const ws = await win.outerSize();
      if (m) {
        const a = areaOf(m as MonitorLike), dpr = window.devicePixelRatio || 1;
        await win.setPosition(new PhysicalPosition(Math.round(a.x + a.w - ws.width - 24 * dpr), Math.round(a.y + a.h - ws.height - 24 * dpr)));
      }
      await win.show();
    } catch { /* ignore */ }
    await this.keepOnScreen(true);
  }

  /** Pet size preset. Vector art is re-laid-out (not transform-scaled), so it stays crisp. */
  async setSize(size: PetSize) {
    const s = SCALES[size] ?? 1;
    document.documentElement.style.setProperty("--pet-scale", String(s));
    if (s === this.scale) return;
    const old = this.scale; this.scale = s;
    const win = this.win; if (!win) return;
    try {
      const dpr = window.devicePixelRatio || 1;
      const a = windowSizeFor(old), b = windowSizeFor(s);
      const pos = await win.outerPosition();
      await win.setSize(new LogicalSize(b.w, b.h));
      // keep the feet where they were (bottom-centre anchored)
      await win.setPosition(new PhysicalPosition(Math.round(pos.x + ((a.w - b.w) / 2) * dpr), Math.round(pos.y + (a.h - b.h) * dpr)));
      await this.keepOnScreen(false);
    } catch { /* ignore */ }
  }
}
