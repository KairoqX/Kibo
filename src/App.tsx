import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import Kibo, { STATES, STATE_LABEL, type KiboState } from "./Kibo";
import { sendActivity, useKibo, useSettings } from "./useKibo";

function PetWindow() {
  const [settings] = useSettings();
  const { state, message, trigger } = useKibo(settings);
  const press = useRef<{ x: number; y: number; dragged: boolean } | null>(null);

  useEffect(() => {
    document.body.classList.add("is-pet");
    return () => document.body.classList.remove("is-pet");
  }, []);

  async function openDashboard() {
    try {
      const existing = await WebviewWindow.getByLabel("dashboard"); // async in Tauri 2
      if (existing) { await existing.show(); await existing.setFocus(); }
      else new WebviewWindow("dashboard", {
        url: "/?view=dashboard",
        title: "Kibo Dashboard",
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 560,
        center: true,
      });
    } catch { /* browser preview */ }
  }

  async function hidePet() {
    try { await getCurrentWindow().hide(); } catch { /* browser preview */ }
  }

  // Drag the window by grabbing Kibo; a plain click still cheers.
  function onPointerDown(e: ReactPointerEvent) { press.current = { x: e.clientX, y: e.clientY, dragged: false }; }
  function onPointerMove(e: ReactPointerEvent) {
    const p = press.current;
    if (!p || p.dragged || !(e.buttons & 1)) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
      p.dragged = true;
      getCurrentWindow().startDragging().catch(() => { /* browser preview */ });
    }
  }
  function onClick() {
    if (press.current?.dragged) { press.current = null; return; }
    trigger("encourage", 3800);
  }

  return (
    <main className="pet" data-tauri-drag-region>
      <div className="pet-controls">
        <button className="icon-button" onClick={openDashboard} title="Open dashboard" aria-label="Open dashboard">▦</button>
        <button className="icon-button" onClick={hidePet} title="Hide Kibo (restore from the tray icon)" aria-label="Hide Kibo">—</button>
      </div>
      <div className="pet-bubble-slot" data-tauri-drag-region>
        {message && <div className="speech" key={message} role="status">{message}<span className="speech-tail" /></div>}
      </div>
      <button className="pet-robot" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onClick={onClick} aria-label="Kibo the robot">
        <Kibo state={state} />
      </button>
    </main>
  );
}

const SLEEPY_OPTIONS = [
  { v: 30, l: "30 seconds" }, { v: 60, l: "1 minute" }, { v: 120, l: "2 minutes" },
  { v: 300, l: "5 minutes" }, { v: 600, l: "10 minutes" },
];

function Dashboard() {
  const [tracking, setTracking] = useState(false);
  const [settings, update] = useSettings();
  const { state, message, trigger } = useKibo(settings);

  async function preview(s: KiboState) {
    // Broadcast so the desktop Kibo reacts too; fall back to local-only in a browser.
    const ok = await sendActivity({ state: s, ms: 6000 });
    if (!ok) trigger(s, 6000);
  }

  async function toggleDesktopKibo() {
    try {
      const w = await WebviewWindow.getByLabel("main");
      if (!w) return;
      if (await w.isVisible()) await w.hide();
      else { await w.show(); await w.setFocus(); }
    } catch { /* browser preview */ }
  }

  function toggleSession() {
    const next = !tracking;
    setTracking(next);
    if (next) preview("encourage");
  }

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <div className="dashboard-brand"><span className="brand-icon">K</span><div><strong>KIBO</strong><small>CODING COMPANION</small></div></div>
        <div className="nav-label">WORKSPACE</div>
        <button className="nav-item active">◫ <span>Overview</span></button>
        <button className="nav-item" onClick={() => alert("Achievements are coming in the next milestone!")}>✧ <span>Achievements</span></button>
        <button className="nav-item" onClick={() => alert("Companion customization is coming soon!")}>♧ <span>Companion</span></button>
        <div className="sidebar-bottom"><div className="mini-robot">🤖</div><div><strong>Kibo is here</strong><small>Your progress, your pace.</small></div></div>
      </aside>
      <section className="dashboard-main">
        <header className="dashboard-header"><div><p className="eyebrow">YOUR DEVELOPER SPACE</p><h1>Welcome back, builder.</h1><p className="muted">Small steps make great software.</p></div><div className="online-pill"><span className="status-pulse" /> Kibo is online</div></header>
        <section className="hero-card">
          <div className="hero-copy"><span className="tag">✦ YOUR COMPANION</span><h2>Ready to make<br />something awesome?</h2><p>Kibo will celebrate your coding milestones, one keystroke at a time.</p><button className="primary-button" onClick={toggleSession}>{tracking ? "Pause activity tracking" : "Start a coding session"} <span>→</span></button></div>
          <div className="hero-robot"><div className="robot-scene"><Kibo state={state} /></div></div>
          <div className="hero-orb orb-one" /><div className="hero-orb orb-two" />
        </section>
        <div className="section-heading"><div><h2>Your activity</h2><p className="muted">A calm look at your coding day.</p></div><span className="date-chip">TODAY</span></div>
        <section className="stats-grid">
          <article className="stat-card"><span className="stat-icon violet">◷</span><span className="stat-label">ACTIVE TIME</span><strong>{tracking ? "00:01" : "00:00"} <small>hrs</small></strong><p>{tracking ? "Session in progress" : "Start a session to begin"}</p></article>
          <article className="stat-card"><span className="stat-icon blue">⌨</span><span className="stat-label">TYPING ACTIVITY</span><strong>— <small>CPM</small></strong><p>Activity engine not connected yet</p></article>
          <article className="stat-card"><span className="stat-icon peach">✦</span><span className="stat-label">CODING STREAK</span><strong>0 <small>days</small></strong><p>Your next milestone awaits</p></article>
        </section>

        <section className="preview-card">
          <h3>Preview Kibo</h3>
          <p className="muted">Try each mood. The desktop Kibo reacts too.</p>
          <div className="preview-now">
            <span className="state-badge" data-testid="state-badge">● {STATE_LABEL[state]}</span>
            <span data-testid="kibo-says">{message ? `Kibo says: “${message}”` : "Kibo is quiet right now."}</span>
          </div>
          <div className="state-chips">
            {STATES.map((s) => (
              <button key={s} className={`state-chip${state === s ? " active" : ""}`} onClick={() => preview(s)}>{STATE_LABEL[s]}</button>
            ))}
          </div>
          <div className="visibility-row"><button className="ghost-button" onClick={toggleDesktopKibo}>Show / hide desktop Kibo</button></div>
        </section>

        <section className="settings-card"><div><h3>Quick settings</h3><p className="muted">Make Kibo work your way.</p></div>
          <label className="setting-row"><span><strong>Activity tracking</strong><small>Local-only tracking; typed text is never stored.</small></span><input type="checkbox" checked={tracking} onChange={e => setTracking(e.target.checked)} /></label>
          <label className="setting-row"><span><strong>Encouragement messages</strong><small>Short speech bubbles, never repeated back to back.</small></span><input type="checkbox" checked={settings.messages} onChange={e => update({ messages: e.target.checked })} /></label>
          <label className="setting-row"><span><strong>Quiet mode</strong><small>Keep celebrations subtle while you focus.</small></span><input type="checkbox" checked={settings.quiet} onChange={e => update({ quiet: e.target.checked })} /></label>
          <label className="setting-row"><span><strong>Get sleepy after</strong><small>Kibo takes a break after this much inactivity, then falls asleep at double the time.</small></span>
            <select className="setting-select" value={settings.sleepyAfter} onChange={e => update({ sleepyAfter: Number(e.target.value) })}>
              {SLEEPY_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select></label>
          <p className="privacy-note">🔒 Privacy first · No account · No cloud required</p></section>
        <footer className="dashboard-footer">KIBO V0.1.0 <span>MADE FOR THE LOVE OF BUILDING THINGS</span></footer>
      </section>
    </main>
  );
}

export default function App() {
  const dashboard = new URLSearchParams(window.location.search).get("view") === "dashboard";
  return dashboard ? <Dashboard /> : <PetWindow />;
}
