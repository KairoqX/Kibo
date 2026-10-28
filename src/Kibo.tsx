import { useEffect, useState, type CSSProperties } from "react";

export type KiboState =
  | "idle" | "typing" | "coding" | "achievement"
  | "break" | "sleep" | "encourage" | "error";

export const STATES: KiboState[] = [
  "idle", "typing", "coding", "achievement", "break", "sleep", "encourage", "error",
];

export const STATE_LABEL: Record<KiboState, string> = {
  idle: "Idle", typing: "Typing", coding: "Focused", achievement: "Celebrating",
  break: "Break time", sleep: "Sleeping", encourage: "Cheering", error: "Supportive",
};

// Palette from the approved design sheet (flat fills only, no gradients).
const SHELL = "#E8F0FF";
const PALE = "#C6D2EB";
const NAVY = "#0F172A";
const CYAN = "#4DD0E1";
const PINK = "#FF8FB1";
const EYE_Y = 75;

function Eye({ cx, rx, ry }: { cx: number; rx: number; ry: number }) {
  return (
    <g className="k-eye" style={{ transformOrigin: `${cx}px ${EYE_Y}px` }}>
      <ellipse cx={cx} cy={EYE_Y} rx={rx} ry={ry} fill={CYAN} />
      <ellipse cx={cx + rx * 0.3} cy={EYE_Y - ry * 0.42} rx={rx * 0.3} ry={ry * 0.2} fill="#E8FDFF" opacity=".9" />
    </g>
  );
}

/** Closed eye: happy (^) or sleepy (u-shape). */
function ArcEye({ cx, happy }: { cx: number; happy: boolean }) {
  const d = happy
    ? `M${cx - 10} ${EYE_Y + 7} Q${cx} ${EYE_Y - 12} ${cx + 10} ${EYE_Y + 7}`
    : `M${cx - 10} ${EYE_Y - 2} Q${cx} ${EYE_Y + 9} ${cx + 10} ${EYE_Y - 2}`;
  return <path d={d} fill="none" stroke={CYAN} strokeWidth="6" strokeLinecap="round" />;
}

function Eyes({ state }: { state: KiboState }) {
  switch (state) {
    case "achievement": return <><ArcEye cx={80} happy /><ArcEye cx={120} happy /></>;
    case "sleep": return <><ArcEye cx={80} happy={false} /><ArcEye cx={120} happy={false} /></>;
    case "encourage": return <><Eye cx={80} rx={10} ry={14.5} /><ArcEye cx={120} happy /></>;
    case "typing": return <><Eye cx={80} rx={11} ry={15.5} /><Eye cx={120} rx={11} ry={15.5} /></>;
    case "coding": return <><Eye cx={80} rx={9} ry={12} /><Eye cx={120} rx={9} ry={12} /></>;
    case "break": return <><Eye cx={80} rx={10} ry={7.5} /><Eye cx={120} rx={10} ry={7.5} /></>;
    default: return <><Eye cx={80} rx={10} ry={14.5} /><Eye cx={120} rx={10} ry={14.5} /></>;
  }
}

function Mouth({ state }: { state: KiboState }) {
  const line = { fill: "none", stroke: CYAN, strokeWidth: 3.6, strokeLinecap: "round" as const };
  switch (state) {
    case "achievement":
      return <><path d="M89 91 Q100 110 111 91 Z" fill={CYAN} /><path d="M94.5 98 Q100 103 105.5 98 Q100 95.5 94.5 98Z" fill={PINK} /></>;
    case "encourage": return <path d="M89 93 Q100 105 111 93" {...line} />;
    case "coding": return <path d="M94 96 Q100 100 106 96" {...line} />;
    case "error": return <path d="M93 99 Q100 93 107 99" {...line} />;
    case "sleep": return <path d="M96.5 97 Q100 100 103.5 97" {...line} />;
    case "break":
      return <><path className="k-smile" d="M93 95 Q100 101 107 95" {...line} /><ellipse className="k-yawn" cx="100" cy="98" rx="6.5" ry="8" fill={CYAN} /></>;
    default: return <path d="M91 93 Q100 102 109 93" {...line} />;
  }
}

function Effects({ state }: { state: KiboState }) {
  if (state === "achievement") {
    const stars = [
      { x: 26, y: 46, dx: -12, dy: -18, c: "#FFD166", d: 0 }, { x: 176, y: 40, dx: 12, dy: -20, c: "#FFD166", d: 0.15 },
      { x: 14, y: 110, dx: -14, dy: -6, c: CYAN, d: 0.3 }, { x: 188, y: 104, dx: 14, dy: -8, c: "#FFD166", d: 0.45 },
    ];
    const bits = [
      { x: 54, y: 8, c: PINK, d: 0.1 }, { x: 92, y: 0, c: CYAN, d: 0.4 },
      { x: 146, y: 8, c: "#FFB067", d: 0.25 }, { x: 120, y: 2, c: "#7AA7FF", d: 0.55 },
    ];
    return (
      <g>
        {stars.map((s, i) => (
          <g key={i} transform={`translate(${s.x} ${s.y})`}>
            <path className="k-star" d="M0 -7 L2 -2 L7 0 L2 2 L0 7 L-2 2 L-7 0 L-2 -2Z" fill={s.c}
              style={{ "--dx": `${s.dx}px`, "--dy": `${s.dy}px`, animationDelay: `${s.d}s` } as CSSProperties} />
          </g>
        ))}
        {bits.map((b, i) => (
          <g key={i} transform={`translate(${b.x} ${b.y})`}>
            <rect className="k-confetti" width="5" height="9" rx="1.5" fill={b.c} style={{ animationDelay: `${b.d}s` }} />
          </g>
        ))}
      </g>
    );
  }
  if (state === "sleep") {
    return (
      <g fill={CYAN} fontFamily="'Space Grotesk', sans-serif" fontWeight="700">
        {[0, 1.2, 2.4].map((d, i) => (
          <g key={i} transform="translate(160 30)">
            <text className="k-z" fontSize={13 + i * 3} style={{ animationDelay: `${d}s` }}>{i === 2 ? "Z" : "z"}</text>
          </g>
        ))}
      </g>
    );
  }
  if (state === "break") {
    return (
      <g transform="translate(150 198)">
        <path className="k-steam" d="M8 -2 q-4 -5 0 -9 q4 -4 0 -8" fill="none" stroke={PALE} strokeWidth="2" strokeLinecap="round" />
        <path className="k-steam k-steam-2" d="M15 -2 q-4 -5 0 -9 q4 -4 0 -8" fill="none" stroke={PALE} strokeWidth="2" strokeLinecap="round" />
        <rect x="0" y="2" width="20" height="16" rx="5" fill={SHELL} />
        <path d="M20 6 q7 0 7 5 q0 5 -7 5" fill="none" stroke={SHELL} strokeWidth="3" strokeLinecap="round" />
        <rect x="0" y="2" width="20" height="5" rx="2.5" fill={CYAN} opacity=".85" />
      </g>
    );
  }
  if (state === "error") {
    return (
      <g>
        <g transform="translate(167 42)"><path className="k-drip" d="M0 0 Q7 11 0 16 Q-7 11 0 0Z" fill="#8FD3FF" /></g>
        <g stroke={CYAN} strokeWidth="2.6" strokeLinecap="round" fill="none">
          <path className="k-tick" d="M186 88 q6 5 0 12" /><path className="k-tick k-tick-2" d="M192 84 q9 9 0 20" />
        </g>
      </g>
    );
  }
  if (state === "typing") {
    return (
      <g stroke={CYAN} strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path className="k-tick" d="M188 164 q6 5 0 12" /><path className="k-tick k-tick-2" d="M194 160 q9 9 0 20" />
        <path className="k-tick" d="M12 164 q-6 5 0 12" /><path className="k-tick k-tick-2" d="M6 160 q-9 9 0 20" />
      </g>
    );
  }
  return null;
}

/** Part groups: `p-*` holds the pose (CSS-transitioned between states),
 *  `m-*` holds the looping motion. Keeping them separate makes state changes smooth. */
export default function Kibo({ state }: { state: KiboState }) {
  const [blink, setBlink] = useState(false);
  const [paused, setPaused] = useState(document.hidden);

  useEffect(() => {
    const on = () => setPaused(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // Randomised blinking; a single timer, only while the eyes are open.
  useEffect(() => {
    if (state === "sleep" || state === "achievement") return;
    let t = 0;
    const schedule = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        t = window.setTimeout(() => { setBlink(false); schedule(); }, 130);
      }, 2400 + Math.random() * 3800);
    };
    schedule();
    return () => { window.clearTimeout(t); setBlink(false); };
  }, [state]);

  return (
    <svg className={`kibo${paused ? " is-paused" : ""}${blink ? " is-blinking" : ""}`}
      data-state={state} viewBox="0 0 200 232" role="img" aria-label={`Kibo is ${STATE_LABEL[state].toLowerCase()}`}>
      <ellipse className="k-shadow" cx="100" cy="223" rx="40" ry="4.5" fill={CYAN} opacity=".3" />

      <g className="p-body"><g className="m-body">
        {/* feet: two small rounded shoes close under the torso (no legs) */}
        <g className="p-foot-l"><g className="m-foot-l">
          <ellipse cx="86" cy="207" rx="12" ry="7.5" fill={CYAN} /><ellipse cx="86" cy="204.5" rx="12" ry="7.5" fill={SHELL} />
        </g></g>
        <g className="p-foot-r"><g className="m-foot-r">
          <ellipse cx="114" cy="207" rx="12" ry="7.5" fill={CYAN} /><ellipse cx="114" cy="204.5" rx="12" ry="7.5" fill={SHELL} />
        </g></g>

        {/* neck: its top is tucked BEHIND the head shell (drawn before the head), so it grows out of the head */}
        <rect x="89" y="122" width="22" height="18" rx="8" fill={PALE} />

        <g className="m-torso">
          <rect x="73" y="143" width="54" height="50" rx="19" fill={SHELL} />
          <circle className="k-core-halo" cx="100" cy="168" r="15" fill={CYAN} />
          <circle cx="100" cy="168" r="9.5" fill={NAVY} />
          <circle className="k-core" cx="100" cy="168" r="6.3" fill={CYAN} />
        </g>

        {/* head: thick pale shell around a smaller navy screen */}
        <g className="p-head"><g className="m-head">
          <g className="p-antenna"><g className="m-antenna">
            <rect x="98" y="9" width="4" height="21" rx="2" fill={PALE} />
            <circle cx="100" cy="9" r="7" fill={CYAN} />
          </g></g>
          <rect x="18" y="60" width="20" height="38" rx="9" fill={PALE} />
          <rect x="162" y="60" width="20" height="38" rx="9" fill={PALE} />
          <rect x="30" y="24" width="140" height="108" rx="48" fill={SHELL} />
          <rect x="49" y="44" width="102" height="68" rx="30" fill={NAVY} />
          <g className="m-eyes"><Eyes state={state} /></g>
          {state === "error" && (
            <g stroke={CYAN} strokeWidth="3" strokeLinecap="round" fill="none" opacity=".85">
              <path d="M68 56 L90 50" /><path d="M110 50 L132 56" />
            </g>
          )}
          <ellipse cx="65" cy="97" rx="8.5" ry="5" fill={PINK} />
          <ellipse cx="135" cy="97" rx="8.5" ry="5" fill={PINK} />
          <Mouth state={state} />
        </g></g>

        {/* arms: capsules hugging the upper sides of the torso, with small detached hands */}
        <g className="p-arm-l"><g className="m-arm-l">
          <rect x="57" y="149" width="13" height="26" rx="6.5" fill={CYAN} />
          <rect x="57" y="149" width="13" height="19.5" rx="6.5" fill={SHELL} />
          {state === "encourage" && <ellipse cx="53.5" cy="184" rx="6.5" ry="4" fill={SHELL} />}
          <circle cx="63.5" cy="185.5" r="7.5" fill={SHELL} />
        </g></g>
        <g className="p-arm-r"><g className="m-arm-r">
          <rect x="130" y="149" width="13" height="26" rx="6.5" fill={CYAN} />
          <rect x="130" y="149" width="13" height="19.5" rx="6.5" fill={SHELL} />
          <circle cx="136.5" cy="185.5" r="7.5" fill={SHELL} />
        </g></g>
      </g></g>

      <Effects key={state} state={state} />
    </svg>
  );
}
