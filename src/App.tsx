import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readKiboState, subscribeToKiboState, writeKiboState } from "./state";
import type { KiboMood, KiboState } from "./state";

const MOOD_LABELS: Record<KiboMood, string> = {
  idle: "Taking it easy",
  typing: "Typing detected",
  active: "Focused coding",
  achievement: "Milestone moment",
  break: "Taking a little break",
  sleep: "Resting",
  wave: "Waving hello",
  encouragement: "Cheering you on",
  error: "Here to help",
};

function useKiboState(): [KiboState, (change: Partial<KiboState>) => void] {
  const [state, setState] = useState(readKiboState);
  const update = useCallback((change: Partial<KiboState>) => {
    const next = { ...readKiboState(), ...change };
    writeKiboState(next);
    setState(next);
  }, []);

  useEffect(() => subscribeToKiboState(() => setState(readKiboState())), []);
  return [state, update];
}

function Robot({ mood, large = false }: { mood: KiboMood; large?: boolean }) {
  return (
    <svg
      className={`robot-scene ${large ? "robot-large" : ""} mood-${mood}`}
      viewBox="0 0 240 250"
      role="img"
      aria-label={`Kibo the robot: ${MOOD_LABELS[mood]}`}
    >
      <ellipse className="robot-ground-shadow" cx="120" cy="237" rx="58" ry="5" />
      <g className="robot-character">
        <g className="robot-legs">
          <g className="robot-leg robot-leg-left">
            <rect x="91" y="202" width="19" height="21" rx="9" fill="#d9e1ee" stroke="#c3cede" strokeWidth="1.5" />
            <path d="M89 217 Q100 213 112 219 L114 227 Q114 232 108 232 H92 Q86 232 87 227Z" fill="#cfd9e8" stroke="#b9c6d8" strokeWidth="1.5" />
            <path d="M94 226 H107" stroke="#aebbd0" strokeWidth="1.5" strokeLinecap="round" />
          </g>
          <g className="robot-leg robot-leg-right">
            <rect x="130" y="202" width="19" height="21" rx="9" fill="#d9e1ee" stroke="#c3cede" strokeWidth="1.5" />
            <path d="M127 219 Q139 213 151 217 L153 227 Q154 232 148 232 H132 Q126 232 126 227Z" fill="#cfd9e8" stroke="#b9c6d8" strokeWidth="1.5" />
            <path d="M133 226 H146" stroke="#aebbd0" strokeWidth="1.5" strokeLinecap="round" />
          </g>
        </g>

        <g className="robot-arms">
          <g className="robot-arm robot-arm-left">
            <circle cx="84" cy="166" r="9" fill="#bcc9dc" />
            <rect x="51" y="163" width="38" height="17" rx="8.5" fill="#dce4f0" stroke="#bdc9dc" strokeWidth="1.5" />
            <circle cx="54" cy="171.5" r="8" fill="#e4eaf4" stroke="#bdc9dc" strokeWidth="1.5" />
          </g>
          <g className="robot-arm robot-arm-right">
            <circle cx="156" cy="166" r="9" fill="#bcc9dc" />
            <rect x="151" y="163" width="38" height="17" rx="8.5" fill="#dce4f0" stroke="#bdc9dc" strokeWidth="1.5" />
            <circle cx="186" cy="171.5" r="8" fill="#e4eaf4" stroke="#bdc9dc" strokeWidth="1.5" />
          </g>
        </g>

        <g className="robot-torso">
          <path d="M88 160 Q91 153 101 153 H139 Q149 153 152 162 L157 196 Q158 207 147 211 Q120 221 93 211 Q82 207 83 196Z" fill="#e5eaf3" stroke="#c4cedd" strokeWidth="2" />
          <rect x="107" y="173" width="26" height="26" rx="9" fill="#c9f3f5" />
          <circle className="chest-core" cx="120" cy="186" r="7" fill="#55d2de" />
          <circle cx="96" cy="190" r="2" fill="#afbdcf" />
          <circle cx="144" cy="190" r="2" fill="#afbdcf" />
        </g>

        <g className="robot-head">
          <path d="M120 51 V32" stroke="#cbd5e3" strokeWidth="8" strokeLinecap="round" />
          <circle className="antenna-tip" cx="120" cy="27" r="9" fill="#62dce5" />

          <g className="robot-ear robot-ear-left">
            <rect x="34" y="91" width="25" height="39" rx="12" fill="#cad5e5" />
          </g>
          <g className="robot-ear robot-ear-right">
            <rect x="181" y="91" width="25" height="39" rx="12" fill="#cad5e5" />
          </g>

          <rect x="50" y="46" width="140" height="115" rx="47" fill="#f0f2fb" stroke="#fff" strokeWidth="3" />
          <rect x="62" y="63" width="116" height="82" rx="31" fill="#1c1c2b" />

          <g className="face-eyes-open">
            <ellipse className="eye-shape eye-left" cx="94" cy="98" rx="8" ry="12" fill="#55d2df" />
            <ellipse className="eye-shape eye-right" cx="146" cy="98" rx="8" ry="12" fill="#55d2df" />
          </g>
          <g className="face-eyes-closed" fill="none" stroke="#55d2df" strokeWidth="3.2" strokeLinecap="round">
            <path d="M84 100 Q94 108 104 100" />
            <path d="M136 100 Q146 108 156 100" />
          </g>
          <ellipse className="robot-cheek cheek-left" cx="77" cy="116" rx="9" ry="5" fill="#efa2b5" />
          <ellipse className="robot-cheek cheek-right" cx="163" cy="116" rx="9" ry="5" fill="#efa2b5" />
          <path className="robot-smile" d="M108 119 Q120 130 132 119" fill="none" stroke="#62dce5" strokeWidth="3.2" strokeLinecap="round" />
          <path className="robot-concern" d="M108 124 Q120 118 132 124" fill="none" stroke="#62dce5" strokeWidth="3.2" strokeLinecap="round" />
        </g>

        <g className="celebration-sparkles" aria-hidden="true">
          <path d="M35 74 L38 82 L46 85 L38 88 L35 96 L32 88 L24 85 L32 82Z" fill="#62dce5" />
          <path d="M205 124 L207 130 L213 132 L207 134 L205 140 L203 134 L197 132 L203 130Z" fill="#efa2b5" />
          <circle cx="42" cy="146" r="3" fill="#f4cd75" />
          <circle cx="198" cy="66" r="2.5" fill="#62dce5" />
        </g>
        <g className="sleep-zs" aria-hidden="true">
          <text x="187" y="69">z</text><text x="202" y="51">z</text>
        </g>
      </g>
    </svg>
  );
}

function useMoodTransitions(state: KiboState, update: (change: Partial<KiboState>) => void) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = readKiboState();
      const now = Date.now();
      let mood = current.mood;
      let message = current.message;
      let messageUntil = current.messageUntil;

      if (messageUntil > 0 && now >= messageUntil) {
        message = "";
        messageUntil = 0;
        mood = current.tracking ? "active" : "idle";
      } else if (current.tracking) {
        const inactiveFor = now - current.lastInteractionAt;
        const restAfter = current.inactivityMinutes * 60_000;
        if (inactiveFor >= restAfter * 2) mood = "sleep";
        else if (inactiveFor >= restAfter) mood = "break";
        else if (!["typing", "achievement", "wave", "encouragement", "error"].includes(current.mood)) mood = "active";
      } else if (["active", "typing", "break", "sleep"].includes(mood)) {
        mood = "idle";
      }

      if (mood !== current.mood || message !== current.message || messageUntil !== current.messageUntil) {
        update({ mood, message, messageUntil });
      }
    }, 850);
    return () => window.clearInterval(timer);
  }, [state.tracking, state.lastInteractionAt, state.mood, state.messageUntil, state.inactivityMinutes, update]);
}

function PetWindow({ state, update }: { state: KiboState; update: (change: Partial<KiboState>) => void }) {
  const showMessage = state.encouragementEnabled && !state.quietMode && Boolean(state.message);

  async function openDashboard() {
    try {
      const dashboard = await WebviewWindow.getByLabel("dashboard");
      if (dashboard) await dashboard.show();
      else new WebviewWindow("dashboard", {
        url: "/?view=dashboard",
        title: "Kibo Dashboard",
        width: 1100,
        height: 820,
        minWidth: 900,
        minHeight: 700,
        center: true,
      });
    } catch {
      update({ mood: "error", message: "I couldn't open that window. Try again?", messageUntil: Date.now() + 2400 });
    }
  }

  async function hidePet() {
    try { await getCurrentWindow().hide(); } catch { /* Browser preview fallback */ }
  }

  function wave() {
    update({
      mood: "wave",
      message: "Hey there! A tiny wave for you.",
      messageUntil: Date.now() + 2700,
      lastInteractionAt: Date.now(),
    });
  }

  return (
    <main className="pet-shell">
      <header className="pet-topbar" data-tauri-drag-region>
        <span className="brand-dot" /> <span className="pet-wordmark">KIBO</span>
        <div className="top-actions">
          <button className="icon-button" onClick={openDashboard} title="Open dashboard" aria-label="Open dashboard">▦</button>
          <button className="icon-button close-button" onClick={hidePet} title="Hide Kibo" aria-label="Hide Kibo">×</button>
        </div>
      </header>
      <div className={`speech-wrap ${showMessage ? "is-visible" : "is-hidden"}`} aria-live="polite">
        <div className="speech">{showMessage ? state.message : " "}</div>
      </div>
      <button className="robot-button" onClick={wave} aria-label="Ask Kibo to wave hello" title="Click Kibo for a wave">
        <Robot mood={state.mood} />
      </button>
      <div className="pet-status"><span className={`status-pulse ${state.tracking ? "is-running" : ""}`} />{MOOD_LABELS[state.mood]}</div>
    </main>
  );
}

function Dashboard({ state, update }: { state: KiboState; update: (change: Partial<KiboState>) => void }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = state.sessionElapsedSeconds + (state.tracking && state.sessionStartedAt ? Math.floor((clock - state.sessionStartedAt) / 1000) : 0);
  const hours = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");

  function announce(mood: KiboMood, message: string, duration = 2400) {
    update({
      mood,
      message: state.encouragementEnabled ? message : "",
      messageUntil: duration ? Date.now() + duration : 0,
      lastInteractionAt: Date.now(),
    });
  }

  function toggleSession() {
    if (state.tracking) {
      const finalElapsed = state.sessionElapsedSeconds + (state.sessionStartedAt ? Math.floor((Date.now() - state.sessionStartedAt) / 1000) : 0);
      update({ tracking: false, sessionElapsedSeconds: finalElapsed, sessionStartedAt: 0, mood: "idle", message: "Session paused. Nice work showing up.", messageUntil: Date.now() + 2600 });
    } else {
      update({ tracking: true, sessionStartedAt: Date.now(), lastInteractionAt: Date.now(), mood: "active", message: "Your focused time starts now.", messageUntil: Date.now() + 2400 });
    }
  }

  function celebrate() {
    announce("achievement", "Another milestone! You did it!", 3000);
  }

  function selectPage(page: "overview" | "companion") {
    if (page === "companion") document.getElementById("companion-controls")?.scrollIntoView({ behavior: "smooth", block: "center" });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <div className="dashboard-brand"><span className="brand-icon">K</span><div><strong>KIBO</strong><small>CODING COMPANION</small></div></div>
        <div className="nav-label">YOUR SPACE</div>
        <button className="nav-item active" onClick={() => selectPage("overview")}><span className="nav-glyph">◫</span><span>Overview</span></button>
        <button className="nav-item" onClick={celebrate}><span className="nav-glyph">✧</span><span>Celebrate a win</span></button>
        <button className="nav-item" onClick={() => selectPage("companion")}><span className="nav-glyph">♧</span><span>Companion</span></button>
        <div className="sidebar-bottom"><div className="sidebar-buddy"><Robot mood={state.mood} /></div><div><strong>Kibo is here</strong><small>{MOOD_LABELS[state.mood]}</small></div></div>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div><p className="eyebrow">YOUR DEVELOPER SPACE</p><h1>Welcome back, builder.</h1><p className="muted">Small steps make great software.</p></div>
          <div className="online-pill"><span className={`status-pulse ${state.tracking ? "is-running" : ""}`} /> {state.tracking ? "Session in progress" : "Companion ready"}</div>
        </header>

        <section className="hero-card">
          <div className="hero-copy"><span className="tag">✦ YOUR COMPANION</span><h2>Ready to make<br />something awesome?</h2><p>Kibo stays by your side. Start a local timer or try a reaction below.</p><button className="primary-button" onClick={toggleSession}>{state.tracking ? "Pause this session" : "Start a local session"}<span>→</span></button></div>
          <div className="hero-robot"><Robot mood={state.mood} large /></div>
          <div className="hero-orb orb-one" /><div className="hero-orb orb-two" />
        </section>

        <div className="section-heading"><div><h2>Your activity</h2><p className="muted">A private, on-device view of your session.</p></div><span className="date-chip">LOCAL ONLY</span></div>
        <section className="stats-grid">
          <article className="stat-card"><span className="stat-icon violet">◷</span><span className="stat-label">SESSION TIME</span><strong>{hours}:{minutes}<small> hrs</small></strong><p>{state.tracking ? `Running · ${seconds} sec` : "Timer runs only when you start it"}</p></article>
          <article className="stat-card"><span className="stat-icon blue">⌨</span><span className="stat-label">EDITOR ACTIVITY</span><strong>Not connected</strong><p>No keys, code, or editor data are collected.</p></article>
          <article className="stat-card"><span className="stat-icon peach">✦</span><span className="stat-label">CODING STREAK</span><strong>Not recorded</strong><p>Kibo doesn't track days or upload activity.</p></article>
        </section>

        <section className="controls-card" id="companion-controls">
          <div className="controls-heading"><div><span className="tag tag-light">KIBO, RIGHT NOW</span><h2>Give your buddy a cue</h2><p className="muted">These local demo controls change Kibo's live animation. They do not read your editor.</p></div><div className="mood-chip"><span className={`mood-dot mood-dot-${state.mood}`} />{MOOD_LABELS[state.mood]}</div></div>
          <div className="reaction-grid">
            <button className="reaction-button" onClick={() => announce("typing", "Tap tap! You're on a roll.", 1800)}><span>⌨</span><strong>Typing pulse</strong><small>Play a quick work animation</small></button>
            <button className="reaction-button" onClick={celebrate}><span>✦</span><strong>Celebrate a win</strong><small>Raise Kibo's arms</small></button>
            <button className="reaction-button" onClick={() => announce("wave", "Hey there! A tiny wave for you.", 2700)}><span>⌁</span><strong>Wave hello</strong><small>Get a friendly little wave</small></button>
            <button className="reaction-button" onClick={() => announce("encouragement", "One step at a time. I'm rooting for you!", 2800)}><span>♡</span><strong>Encourage me</strong><small>Get a little pep talk</small></button>
            <button className="reaction-button" onClick={() => announce("error", "Bumps happen. We'll figure it out together.", 3000)}><span>↻</span><strong>Debug moment</strong><small>A gentle, supportive reaction</small></button>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-title"><div><h3>Quick settings</h3><p className="muted">Make Kibo work your way.</p></div></div>
          <label className="setting-row"><span><strong>Encouragement messages</strong><small>Show short, occasional speech bubbles.</small></span><input type="checkbox" checked={state.encouragementEnabled} onChange={event => update({ encouragementEnabled: event.target.checked, message: event.target.checked ? "I'm here whenever you need me." : "", messageUntil: 0 })} /></label>
          <label className="setting-row"><span><strong>Quiet mode</strong><small>Keep messages tucked away while you focus.</small></span><input type="checkbox" checked={state.quietMode} onChange={event => update({ quietMode: event.target.checked })} /></label>
          <label className="setting-row setting-select-row"><span><strong>Sleepy-mode timing</strong><small>Rest after inactivity; Kibo dozes after twice this time.</small></span><select value={state.inactivityMinutes} onChange={event => update({ inactivityMinutes: Number(event.target.value), lastInteractionAt: Date.now() })}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={20}>20 minutes</option><option value={30}>30 minutes</option></select></label>
          <p className="privacy-note"><span aria-hidden="true">◈</span> Privacy first · No keystroke logging · No code capture · No cloud tracking</p>
        </section>
        <footer className="dashboard-footer">KIBO V0.1.0 <span>MADE FOR THE LOVE OF BUILDING THINGS</span></footer>
      </section>
    </main>
  );
}

export default function App() {
  const dashboard = new URLSearchParams(window.location.search).get("view") === "dashboard";
  const [state, update] = useKiboState();
  useMoodTransitions(state, update);
  return dashboard ? <Dashboard state={state} update={update} /> : <PetWindow state={state} update={update} />;
}
