import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { KiboRig, type KiboState, type MotionMode } from "./kiboRig";

export type { KiboState };

export const STATES: KiboState[] = [
  "idle", "typing", "coding", "happy", "achievement", "wave", "encourage", "break", "sleep", "error",
];

export const STATE_LABEL: Record<KiboState, string> = {
  idle: "Idle", typing: "Typing", coding: "Focused", happy: "Happy", achievement: "Celebrating",
  wave: "Waving", break: "Break time", sleep: "Sleeping", encourage: "Cheering", error: "Supportive",
};

/** "system" follows the OS reduced-motion setting (gentle, small, slow); "full" always plays full motion. */
export type MotionPref = "system" | "full";

// Palette from the approved design sheet (flat fills only, no gradients).
const SHELL = "#E8F0FF";
const PALE = "#C6D2EB";
const NAVY = "#0F172A";
const CYAN = "#4DD0E1";
const PINK = "#FF8FB1";
const EYE_Y = 81.2;

/* ------------------------------------------------------------------ face */
function OpenEye({ cx, part }: { cx: number; part: "eyeL" | "eyeR" }) {
  const rx = 10.5, ry = 15.2;
  return (
    <g data-p={part}>
      <ellipse cx={cx} cy={EYE_Y} rx={rx} ry={ry} fill={CYAN} />
      <ellipse cx={cx + rx * 0.3} cy={EYE_Y - ry * 0.42} rx={rx * 0.3} ry={ry * 0.2} fill="#E8FDFF" opacity=".9" />
    </g>
  );
}

const arc = (cx: number, happy: boolean) =>
  happy
    ? `M${cx - 10} ${EYE_Y + 7} Q${cx} ${EYE_Y - 12} ${cx + 10} ${EYE_Y + 7}`
    : `M${cx - 10} ${EYE_Y - 2} Q${cx} ${EYE_Y + 9} ${cx + 10} ${EYE_Y - 2}`;

function ArcEye({ cx, happy, part }: { cx: number; happy: boolean; part: "arcHL" | "arcHR" | "arcSL" | "arcSR" }) {
  return <path data-p={part} d={arc(cx, happy)} fill="none" stroke={CYAN} strokeWidth="6" strokeLinecap="round" />;
}

const LINE = { fill: "none", stroke: CYAN, strokeWidth: 3.6, strokeLinecap: "round" as const };

/** All mouths are mounted at once and cross-faded by the rig (no swapping). */
function Mouths() {
  return (
    <>
      <path data-p="mIdle" d="M113.5 105.8 A14 9.3 0 0 1 86.5 105.8" fill="none" stroke={CYAN} strokeWidth="3.3" strokeLinecap="round" />
      <g transform="translate(0 12)">
        <path data-p="mSmile" d="M89 93 Q100 105 111 93" {...LINE} />
        <g data-p="mOpen">
          <path d="M89 91 Q100 110 111 91 Z" fill={CYAN} />
          <path d="M94.5 98 Q100 103 105.5 98 Q100 95.5 94.5 98Z" fill={PINK} />
        </g>
        <path data-p="mLine" d="M94 96 Q100 100 106 96" {...LINE} />
        <path data-p="mWorry" d="M93 99 Q100 93 107 99" {...LINE} />
        <path data-p="mSleep" d="M96.5 97 Q100 100 103.5 97" {...LINE} />
        <ellipse data-p="mYawn" cx="100" cy="98" rx="6.5" ry="7.4" fill={CYAN} />
      </g>
    </>
  );
}

/* --------------------------------------------------------------- effects */
function EffectLayer({ state }: { state: KiboState }) {
  if (state === "achievement") {
    const stars = [
      { x: 26, y: 46, dx: -12, dy: -18, c: "#FFD166", d: 0.5 }, { x: 176, y: 40, dx: 12, dy: -20, c: "#FFD166", d: 0.65 },
      { x: 14, y: 110, dx: -14, dy: -6, c: CYAN, d: 0.8 }, { x: 188, y: 104, dx: 14, dy: -8, c: "#FFD166", d: 0.95 },
    ];
    const bits = [
      { x: 54, y: 8, c: PINK, d: 0.6 }, { x: 92, y: 0, c: CYAN, d: 0.9 },
      { x: 146, y: 8, c: "#FFB067", d: 0.75 }, { x: 120, y: 2, c: "#7AA7FF", d: 1.05 },
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
    // vector "Z" glyphs (paths, not <text>: no font dependency and no text relayout while animating)
    return (
      <g fill="none" stroke={CYAN} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {[0, 1.2, 2.4].map((d, i) => (
          <g key={i} transform="translate(160 30)">
            <path className="k-z" d={`M${-3.5 - i} ${-3.5 - i} H${3.5 + i} L${-3.5 - i} ${3.5 + i} H${3.5 + i}`} style={{ animationDelay: `${d}s` }} />
          </g>
        ))}
      </g>
    );
  }
  if (state === "break") {
    return (
      <g transform="translate(150 207)">
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
          <path className="k-tick" d="M190 88 q6 5 0 12" /><path className="k-tick k-tick-2" d="M196 84 q9 9 0 20" />
        </g>
      </g>
    );
  }
  if (state === "typing") {
    return (
      <g stroke={CYAN} strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path className="k-tick" d="M188 173 q6 5 0 12" /><path className="k-tick k-tick-2" d="M194 169 q9 9 0 20" />
        <path className="k-tick" d="M12 173 q-6 5 0 12" /><path className="k-tick k-tick-2" d="M6 169 q-9 9 0 20" />
      </g>
    );
  }
  return null;
}

type Fx = { key: string; state: KiboState; on: boolean };
const HAS_FX: KiboState[] = ["achievement", "sleep", "break", "error", "typing"];

/** Effect layers fade in/out (CSS) instead of popping; an exiting layer is unmounted after its fade. */
function useEffects(state: KiboState, replay: number): Fx[] {
  const [fx, setFx] = useState<Fx[]>([]);
  useEffect(() => {
    const key = `${state}-${replay}`;
    setFx((prev) => {
      const faded = prev.map((f) => (f.key === key ? f : { ...f, on: false }));
      if (!HAS_FX.includes(state) || faded.some((f) => f.key === key)) return faded;
      return [...faded, { key, state, on: true }];
    });
    const t = window.setTimeout(() => setFx((p) => p.filter((f) => f.on)), 700);
    return () => window.clearTimeout(t);
  }, [state, replay]);
  return fx;
}

/* ----------------------------------------------------------------- scene */
/**
 * One stable SVG scene. Hierarchy (every `data-p` group is moved by KiboRig):
 *   body (float / squash, pivot at the feet)
 *     ├ footL, footR
 *     └ upper (sway about the torso base)
 *         ├ neck  ├ torso (breathing)  ├ armL > handL  ├ armR > handR
 *         └ head > antenna, eyes, cheeks, mouths
 * The default pose is identical to the approved design.
 */
export default function Kibo({ state, replay = 0, motion = "system", rigHandle }: {
  state: KiboState; replay?: number; motion?: MotionPref;
  /** optional handle to the rig so the desktop pet can feed it pointer interactions without re-rendering */
  rigHandle?: MutableRefObject<KiboRig | null>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rigRef = useRef<KiboRig | null>(null);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const mode: MotionMode = motion === "full" ? "full" : reduced ? "reduced" : "full";
  const fx = useEffects(state, replay);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // create the rig once; first pose is applied before the first paint
  useLayoutEffect(() => {
    const rig = new KiboRig(svgRef.current!);
    rigRef.current = rig;
    if (rigHandle) rigHandle.current = rig;
    rig.setMode(mode);
    rig.setState(state);
    rig.start();
    const vis = () => (document.hidden ? rig.stop() : rig.start());
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); rig.dispose(); rigRef.current = null; if (rigHandle) rigHandle.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { rigRef.current?.setMode(mode); }, [mode]);
  useEffect(() => { rigRef.current?.setState(state); }, [state]);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } rigRef.current?.replay(); }, [replay]);

  return (
    <svg ref={svgRef} className="kibo" data-state={state} data-motion={mode} viewBox="0 0 200 241" role="img"
      aria-label={`Kibo is ${STATE_LABEL[state].toLowerCase()}`}>
      <ellipse data-p="shadow" cx="100" cy="232" rx="40" ry="4.5" fill={CYAN} opacity=".3" />

      <g data-p="body">
        {/* feet: two small rounded shoes close under the torso (no legs) */}
        <g data-p="footL">
          <ellipse cx="86" cy="216" rx="12" ry="7.5" fill={CYAN} /><ellipse cx="86" cy="213.5" rx="12" ry="7.5" fill={SHELL} />
        </g>
        <g data-p="footR">
          <ellipse cx="114" cy="216" rx="12" ry="7.5" fill={CYAN} /><ellipse cx="114" cy="213.5" rx="12" ry="7.5" fill={SHELL} />
        </g>

        <g data-p="upper">
          {/* neck: its top is tucked BEHIND the head shell (drawn before the head), so it grows out of the head */}
          <g data-p="neck"><rect x="89" y="131" width="22" height="18" rx="8" fill={PALE} /></g>

          <g data-p="torso">
            <rect x="73" y="152" width="54" height="50" rx="19" fill={SHELL} />
            <circle data-p="halo" cx="100" cy="177" r="15" fill={CYAN} opacity=".25" />
            <circle cx="100" cy="177" r="9.5" fill={NAVY} />
            <circle cx="100" cy="177" r="6.3" fill={CYAN} />
          </g>

          {/* head: proportions taken directly from the approved icon */}
          <g data-p="head">
            <g data-p="antenna">
              <rect x="98" y="9" width="4" height="21" rx="2" fill={PALE} />
              <circle cx="100" cy="9" r="7" fill={CYAN} />
            </g>
            <rect x="15.5" y="59" width="18.7" height="46.7" rx="8.4" fill={PALE} />
            <rect x="165.8" y="59" width="18.7" height="46.7" rx="8.4" fill={PALE} />
            <rect x="30" y="24" width="140" height="116.7" rx="46.7" fill={SHELL} />
            <rect x="43.5" y="45" width="113" height="74.7" rx="30.3" fill={NAVY} />
            <g data-p="eyes">
              <OpenEye cx={76} part="eyeL" /><OpenEye cx={124} part="eyeR" />
              <ArcEye cx={76} happy part="arcHL" /><ArcEye cx={124} happy part="arcHR" />
              <ArcEye cx={76} happy={false} part="arcSL" /><ArcEye cx={124} happy={false} part="arcSR" />
            </g>
            <g data-p="brow" stroke={CYAN} strokeWidth="3" strokeLinecap="round" fill="none">
              <path d="M64 62 L88 56" /><path d="M112 56 L136 62" />
            </g>
            <ellipse data-p="cheekL" cx="58.7" cy="103.3" rx="8.2" ry="4.7" fill={PINK} />
            <ellipse data-p="cheekR" cx="141.3" cy="103.3" rx="8.2" ry="4.7" fill={PINK} />
            <Mouths />
          </g>

          {/* arms: capsules hugging the upper sides of the torso, with small detached hands that pivot at the wrist */}
          <g data-p="armL">
            <rect x="57" y="158" width="13" height="26" rx="6.5" fill={CYAN} />
            <rect x="57" y="158" width="13" height="19.5" rx="6.5" fill={SHELL} />
            <g data-p="handL">
              <ellipse data-p="thumb" cx="53.5" cy="193" rx="6.5" ry="4" fill={SHELL} />
              <circle cx="63.5" cy="194.5" r="7.5" fill={SHELL} />
            </g>
          </g>
          <g data-p="armR">
            <rect x="130" y="158" width="13" height="26" rx="6.5" fill={CYAN} />
            <rect x="130" y="158" width="13" height="19.5" rx="6.5" fill={SHELL} />
            <g data-p="handR"><circle cx="136.5" cy="194.5" r="7.5" fill={SHELL} /></g>
          </g>
        </g>
      </g>

      {fx.map((f) => (
        <g key={f.key} className={`fx${f.on ? "" : " is-off"}`}><EffectLayer state={f.state} /></g>
      ))}
    </svg>
  );
}
