import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit, listen } from "@tauri-apps/api/event";
import Kibo, { STATES, STATE_LABEL, type KiboState } from "./Kibo";
import type { KiboRig } from "./kiboRig";
import { INTERACTION_POOLS, sendActivity, useKibo, useSettings, type Settings } from "./useKibo";
import { PetController, type PetEvent } from "./petInteraction";
import { EventOrchestrator } from "./events/orchestrator";
import { EVENT_MESSAGES } from "./events/messages";
import { parseWireEvent } from "./events/types";
import { IconArrow, IconClock, IconFlame, IconGrid, IconKeys, IconLock, IconMinus, IconSpark, IconStar, KiboMark } from "./icons";

/** Cross-window events (also emitted by the tray menu in Rust). */
const VISIBILITY_EVENT = "kibo:visibility";
const RESET_EVENT = "kibo:reset-position";
/** Validated-by-Rust, re-validated-here developer/activity events (JSON string payload). */
const DEV_EVENT = "kibo:dev-event";

/** Keeps the last message mounted for a moment so the bubble can fade out instead of vanishing. */
function useFadingText(text: string | null, ms = 300) {
  const [shown, setShown] = useState<{ text: string; out: boolean } | null>(null);
  useEffect(() => {
    if (text) { setShown({ text, out: false }); return; }
    setShown((s) => (s ? { ...s, out: true } : s));
    const t = window.setTimeout(() => setShown(null), ms);
    return () => window.clearTimeout(t);
  }, [text, ms]);
  return shown;
}

function PetWindow() {
  const [settings] = useSettings();
  const { state, message, trigger, react, pulse, speak, touch } = useKibo(settings);
  const bubble = useFadingText(message);
  const rigRef = useRef<KiboRig | null>(null);
  const robotRef = useRef<HTMLButtonElement>(null);
  const ctl = useRef<PetController | null>(null);
  const [showControls, setShowControls] = useState(false);

  // latest values for the long-lived controller callbacks (no re-subscribing, no stale closures)
  const live = useRef({ state, trigger, react, speak, touch, settings });
  live.current = { state, trigger, react, speak, touch, settings };
  const hiddenRef = useRef(false);     // mirrors the tray/dashboard hide state; hidden Kibo never reacts to events

  useEffect(() => {
    document.body.classList.add("is-pet");
    return () => document.body.classList.remove("is-pet");
  }, []);

  // controller: pointer awareness, click-through, drag, edge safety. Created once, fully cleaned up.
  useEffect(() => {
    const said: Record<string, number> = {};
    const roll = (key: string, p: number, cooldownMs: number) => {   // occasional, never constant
      const now = Date.now();
      if (Math.random() > p || now - (said[key] ?? 0) < cooldownMs) return false;
      said[key] = now; return true;
    };
    const c = new PetController({
      rig: () => rigRef.current,
      robot: () => robotRef.current,
      getState: () => live.current.state,
      onPresence: setShowControls,
      onEvent: (e: PetEvent) => {
        const { state: st, trigger: trig, speak: say, touch: wake } = live.current;
        switch (e) {
          case "hover": if (st !== "sleep" && st !== "break") { wake(); if (roll("hover", 0.5, 90_000)) say(INTERACTION_POOLS.hover); } break;
          case "pat": wake(); if (roll("pat", 0.5, 12_000)) say(INTERACTION_POOLS.pat); break;
          case "patStreak": wake(); trig("happy", 2800, false); say(INTERACTION_POOLS.patStreak, { gap: 2000 }); break;
          case "poke": wake(); if (roll("poke", 0.4, 12_000)) say(INTERACTION_POOLS.poke); break;
          case "giggle": wake(); say(INTERACTION_POOLS.giggle, { gap: 1500, show: 2200 }); break;
          case "wake": wake(); trig("wave", 3400, false); say(INTERACTION_POOLS.wake, { gap: 1000 }); break;   // waking blends through the normal state weights
          case "pickup": wake(); break;
          case "drop": wake(); if (roll("drop", 0.35, 20_000)) say(INTERACTION_POOLS.drop); break;
        }
      },
    });
    ctl.current = c;
    void c.start();

    const offs: Array<() => void> = [];
    let dead = false;
    const sub = (name: string, fn: (payload: unknown) => void) =>
      listen(name, (e) => fn(e.payload)).then((f) => { if (dead) f(); else offs.push(f); }).catch(() => { /* browser preview */ });
    void sub(VISIBILITY_EVENT, (v) => { hiddenRef.current = v === false; c.setVisible(v !== false); });
    void sub(RESET_EVENT, () => { void c.resetPosition().then(() => c.setVisible(true)); });
    void c.keepOnScreen(false);                         // never start off-screen (monitor unplugged, resolution change...)

    return () => { dead = true; offs.forEach((f) => f()); c.stop(); ctl.current = null; };
  }, []);

  // reactive companion: events -> orchestrator -> existing state machine / speech bubble. Created once, fully cleaned up.
  useEffect(() => {
    const orch = new EventOrchestrator({
      now: () => Date.now(),
      settings: () => live.current.settings,
      petState: () => live.current.state,
      hidden: () => hiddenRef.current,
      interacting: () => ctl.current?.isInteracting() ?? false,
      schedule: (fn, ms) => { const id = window.setTimeout(fn, ms); return () => window.clearTimeout(id); },
      play: (r) => {
        const { react: rx, speak: say, settings: st } = live.current;
        rx(r.state, r.ms, r.wake);
        if (r.message && st.eventMessages) say(EVENT_MESSAGES[r.message], { gap: 6000, show: 3200 });
      },
    });
    let off: (() => void) | undefined, dead = false;
    listen<unknown>(DEV_EVENT, (e) => {
      const ev = parseWireEvent(e.payload, Date.now());    // untrusted until validated; invalid input is silently ignored
      if (ev) orch.handle(ev);
    }).then((f) => { if (dead) f(); else off = f; }).catch(() => { /* browser preview: no event source */ });
    return () => { dead = true; off?.(); orch.dispose(); };
  }, []);

  useEffect(() => { ctl.current?.setAware(settings.aware); }, [settings.aware]);
  useEffect(() => { void ctl.current?.setSize(settings.petSize); }, [settings.petSize]);

  async function openDashboard() {
    try {
      const existing = await WebviewWindow.getByLabel("dashboard"); // async in Tauri 2
      if (existing) { await existing.show(); await existing.setFocus(); }
      else new WebviewWindow("dashboard", {
        url: "/?view=dashboard",
        title: "Kibo Dashboard",
        width: 1120,
        height: 780,
        minWidth: 860,
        minHeight: 600,
        center: true,
      });
    } catch { /* browser preview */ }
  }

  async function hidePet() {
    try {
      await getCurrentWindow().hide();
      hiddenRef.current = true;
      ctl.current?.setVisible(false);
      await emit(VISIBILITY_EVENT, false);
    } catch { /* browser preview */ }
  }

  return (
    <main className={`pet${showControls ? " show-controls" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      <div className="pet-controls" data-hit={showControls ? "" : undefined}>
        <button className="icon-button" onClick={openDashboard} title="Open dashboard" aria-label="Open dashboard" tabIndex={showControls ? 0 : -1}><IconGrid /></button>
        <button className="icon-button" onClick={hidePet} title="Hide Kibo (restore from the tray icon)" aria-label="Hide Kibo" tabIndex={showControls ? 0 : -1}><IconMinus /></button>
      </div>
      <div className="pet-bubble-slot">
        {bubble && <div className={`speech${bubble.out ? " is-out" : ""}`} key={bubble.text} role="status">{bubble.text}<span className="speech-tail" /></div>}
      </div>
      <button
        ref={robotRef} className="pet-robot" data-hit aria-label="Kibo the robot. Click to say hi, drag to move."
        onPointerDown={(e) => ctl.current?.pointerDown(e)}
        onPointerMove={(e) => ctl.current?.pointerMove(e)}
        onPointerUp={(e) => ctl.current?.pointerUp(e)}
        onClick={(e) => { if (e.detail === 0) ctl.current?.activate(); }}   // keyboard activation only; mouse is handled above
      >
        <Kibo state={state} replay={pulse} motion={settings.motion} rigHandle={rigRef} />
      </button>
    </main>
  );
}

const SLEEPY_OPTIONS = [
  { v: 30, l: "30 seconds" }, { v: 60, l: "1 minute" }, { v: 120, l: "2 minutes" },
  { v: 300, l: "5 minutes" }, { v: 600, l: "10 minutes" },
];

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" role="switch" className="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />;
}

function Dashboard() {
  const [tracking, setTracking] = useState(false);
  const [settings, update] = useSettings();
  const { state, message, trigger, pulse } = useKibo(settings);

  useEffect(() => {
    document.body.classList.add("is-dashboard");
    return () => document.body.classList.remove("is-dashboard");
  }, []);

  async function preview(s: KiboState) {
    // Broadcast so the desktop Kibo reacts too; fall back to local-only in a browser.
    const ok = await sendActivity({ state: s, ms: 6000 });
    if (!ok) trigger(s, 6000);
  }

  async function toggleDesktopKibo() {
    try {
      const w = await WebviewWindow.getByLabel("main");
      if (!w) return;
      if (await w.isVisible()) { await w.hide(); await emit(VISIBILITY_EVENT, false); }
      else { await w.show(); await emit(VISIBILITY_EVENT, true); }
    } catch { /* browser preview */ }
  }

  async function bringKiboBack() {
    try { await emit(RESET_EVENT); } catch { /* browser preview */ }
  }

  /** Sends a simulated event down the same path the CLI uses (Rust -> "kibo:dev-event"), for manual testing. */
  async function simulate(type: "build_succeeded" | "build_failed") {
    try { await emit(DEV_EVENT, JSON.stringify({ type, source: "dashboard" })); } catch { /* browser preview */ }
  }

  function toggleSession() {
    const next = !tracking;
    setTracking(next);
    if (next) preview("encourage");
  }

  return (
    <main className="dashboard-shell">
      <aside className="sidebar" aria-label="Navigation">
        <div className="dashboard-brand"><KiboMark size={40} /><div><strong>Kibo</strong><small>Coding companion</small></div></div>
        <nav>
          <div className="nav-label">Workspace</div>
          <button className="nav-item active" aria-current="page"><IconGrid /><span>Overview</span></button>
          <button className="nav-item" onClick={() => alert("Achievements are coming in the next milestone!")}><IconStar /><span>Achievements</span></button>
          <button className="nav-item" onClick={() => alert("Companion customization is coming soon!")}><IconSpark /><span>Companion</span></button>
        </nav>
        <div className="sidebar-bottom"><KiboMark size={34} /><div><strong>Kibo is here</strong><small>Your progress, your pace.</small></div></div>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div><p className="eyebrow">Your developer space</p><h1>Welcome back, builder.</h1><p className="muted">Small steps make great software.</p></div>
          <div className="online-pill"><span className="status-pulse" /> Kibo is online</div>
        </header>

        <section className="hero-card">
          <div className="hero-copy">
            <span className="tag">Your companion</span>
            <h2>Ready to make something awesome?</h2>
            <p>Kibo will celebrate your coding milestones, one keystroke at a time.</p>
            <button className="primary-button" onClick={toggleSession}>{tracking ? "Pause activity tracking" : "Start a coding session"} <IconArrow size={18} /></button>
          </div>
          <div className="hero-robot"><div className="robot-scene"><Kibo state={state} replay={pulse} motion={settings.motion} /></div></div>
        </section>

        <div className="section-heading"><div><h2>Your activity</h2><p className="muted">A calm look at your coding day.</p></div><span className="date-chip">Today</span></div>
        <section className="stats-grid">
          <article className="stat-card"><span className="stat-icon violet"><IconClock /></span><span className="stat-label">Active time</span><strong className="stat-value">{tracking ? "00:01" : "00:00"}<small>hrs</small></strong><p>{tracking ? "Session in progress" : "Start a session to begin"}</p></article>
          <article className="stat-card"><span className="stat-icon blue"><IconKeys /></span><span className="stat-label">Typing activity</span><strong className="stat-value">—<small>CPM</small></strong><p>Activity engine not connected yet</p></article>
          <article className="stat-card"><span className="stat-icon peach"><IconFlame /></span><span className="stat-label">Coding streak</span><strong className="stat-value">0<small>days</small></strong><p>Your next milestone awaits</p></article>
        </section>

        <div className="two-col">
          <section className="card preview-card">
            <h3>Preview Kibo</h3>
            <p className="muted">Try each mood. The desktop Kibo reacts too.</p>
            <div className="preview-now">
              <span className="state-badge" data-testid="state-badge">{STATE_LABEL[state]}</span>
              <span data-testid="kibo-says">{message ? `Kibo says: “${message}”` : "Kibo is quiet right now."}</span>
            </div>
            <div className="state-chips">
              {STATES.map((s) => (
                <button key={s} className={`state-chip${state === s ? " active" : ""}`} aria-pressed={state === s} onClick={() => preview(s)}>{STATE_LABEL[s]}</button>
              ))}
            </div>
          </section>

          <section className="card pet-card">
            <h3>Desktop Kibo</h3>
            <p className="muted">Pat, poke and drag Kibo on your desktop.</p>
            <div className="button-row">
              <button className="ghost-button" onClick={toggleDesktopKibo}>Show / hide desktop Kibo</button>
              <button className="ghost-button" onClick={bringKiboBack}>Bring Kibo back on screen</button>
            </div>
            <label className="setting-row"><span><strong>Follow my pointer</strong><small>Kibo looks at your mouse, and clicks pass through the empty space around it. Pointer position is used live and never stored.</small></span><Switch label="Follow my pointer" checked={settings.aware} onChange={(v) => update({ aware: v })} /></label>
            <label className="setting-row"><span><strong>Kibo size</strong><small>Resizes the floating window; the character stays sharp.</small></span>
              <select className="setting-select" value={settings.petSize} onChange={(e) => update({ petSize: e.target.value as Settings["petSize"] })}>
                <option value="small">Small</option><option value="normal">Normal</option><option value="large">Large</option>
              </select></label>
            <p className="muted tip">Tip: the tray icon menu can also show, hide or reset Kibo.</p>
          </section>
        </div>

        <section className="card settings-card"><div><h3>Quick settings</h3><p className="muted">Make Kibo work your way.</p></div>
          <label className="setting-row"><span><strong>Activity tracking</strong><small>Local-only tracking; typed text is never stored.</small></span><Switch label="Activity tracking" checked={tracking} onChange={setTracking} /></label>
          <label className="setting-row"><span><strong>Encouragement messages</strong><small>Short speech bubbles, never repeated back to back.</small></span><Switch label="Encouragement messages" checked={settings.messages} onChange={(v) => update({ messages: v })} /></label>
          <label className="setting-row"><span><strong>Quiet mode</strong><small>Keep celebrations subtle while you focus.</small></span><Switch label="Quiet mode" checked={settings.quiet} onChange={(v) => update({ quiet: v })} /></label>
          <label className="setting-row"><span><strong>Get sleepy after</strong><small>Kibo takes a break after this much inactivity, then falls asleep at double the time.</small></span>
            <select className="setting-select" value={settings.sleepyAfter} onChange={(e) => update({ sleepyAfter: Number(e.target.value) })}>
              {SLEEPY_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select></label>
          <label className="setting-row"><span><strong>Animation</strong><small>“Follow system” keeps Kibo gentle if Windows has animation effects turned off. “Always full” ignores that setting.</small></span>
            <select className="setting-select" value={settings.motion} onChange={(e) => update({ motion: e.target.value as "system" | "full" })}>
              <option value="system">Follow system</option><option value="full">Always full</option>
            </select></label>
          <div className="settings-subhead"><h3>Reactions</h3><p className="muted">How Kibo reacts to builds and tasks reported by the <code>kibo-report</code> command. Nothing is watched automatically.</p></div>
          <label className="setting-row"><span><strong>Build &amp; task reactions</strong><small>Cheer on a finished build, look concerned when one fails.</small></span><Switch label="Build and task reactions" checked={settings.devEvents} onChange={(v) => update({ devEvents: v })} /></label>
          <label className="setting-row"><span><strong>Activity reactions</strong><small>Say hi when you come back (only when something reports it).</small></span><Switch label="Activity reactions" checked={settings.activityEvents} onChange={(v) => update({ activityEvents: v })} /></label>
          <label className="setting-row"><span><strong>Reaction speech bubbles</strong><small>Short lines like “Build complete!”. Also needs encouragement messages on.</small></span><Switch label="Reaction speech bubbles" checked={settings.eventMessages} onChange={(v) => update({ eventMessages: v })} /></label>
          <label className="setting-row"><span><strong>Bigger cheer for long tasks</strong><small>A fuller celebration when something that ran for a minute or more finishes. Quiet mode keeps it subtle.</small></span><Switch label="Bigger cheer for long tasks" checked={settings.longTaskCelebrate} onChange={(v) => update({ longTaskCelebrate: v })} /></label>
          <label className="setting-row"><span><strong>Let events wake Kibo</strong><small>Off by default: a sleeping Kibo stays asleep and ignores events.</small></span><Switch label="Let events wake Kibo" checked={settings.eventsWake} onChange={(v) => update({ eventsWake: v })} /></label>
          <div className="button-row"><button className="ghost-button" onClick={() => simulate("build_succeeded")}>Try “build succeeded”</button><button className="ghost-button" onClick={() => simulate("build_failed")}>Try “build failed”</button></div>
          <p className="privacy-note"><IconLock size={16} /> Privacy first · No account · No cloud required</p></section>
        <footer className="dashboard-footer"><span>Kibo v0.1.0</span><span>Made for the love of building things</span></footer>
      </section>
    </main>
  );
}

export default function App() {
  const dashboard = new URLSearchParams(window.location.search).get("view") === "dashboard";
  return dashboard ? <Dashboard /> : <PetWindow />;
}
