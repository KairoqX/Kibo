/**
 * Kibo animation rig
 * ------------------
 * Drives the separate SVG part groups of <Kibo/> by writing `transform` / `opacity`
 * attributes directly (no React re-render per frame, no animation library).
 *
 * Why not CSS keyframes per state?  Swapping `animation-name` restarts the loop at
 * identity, so every state change snapped the body.  Here nothing is ever "restarted":
 *
 *   1. every state has a smoothed WEIGHT (they always sum to 1), so poses and loops
 *      cross-fade instead of swapping;
 *   2. each state contributes a static pose, an optional looping motion (driven by one
 *      continuous clock) and an optional one-shot choreography (driven by time-since-start);
 *   3. the blended targets feed critically/under-damped SPRINGS, which gives easing,
 *      anticipation-free follow-through and tiny overshoots for free;
 *   4. secondary motion (antenna whip, hand flick, feet dangle) is derived from the
 *      velocity of the parts that drive it, so it is physically consistent;
 *   5. periods of the idle oscillators are deliberately incommensurate, so the motion
 *      is organic rather than perfectly synchronised.
 *
 * Privacy: this file never sees input events. It only receives a state name.
 */

export type KiboState =
  | "idle" | "typing" | "coding" | "happy" | "achievement"
  | "wave" | "break" | "sleep" | "encourage" | "error";

export type MotionMode = "full" | "reduced";

/* ---------------------------------------------------------------- tunables */
/** Seconds for a state weight to (mostly) arrive / leave. */
const TAU_IN = 0.3;
const TAU_OUT = 0.45;
/** Spring [angular frequency (rad/s), damping ratio]. zeta<1 = a little overshoot. */
const SPRING: Record<string, [number, number]> = {
  body: [11, 0.72], upper: [9, 0.8], head: [9, 0.72], ant: [9, 0.32],
  arm: [11, 0.6], hand: [13, 0.4], foot: [13, 0.7],
};
/** Reduced-motion profile: tiny, slow, no jumping/squashing, still alive. */
const MOTION = {
  full: { amp: 1, speed: 1, big: 1, osc: 1, spring: 1 },
  reduced: { amp: 0.65, speed: 0.6, big: 0, osc: 0.5, spring: 0.7 },
} as const;
type Motion = (typeof MOTION)[MotionMode];

/* ---------------------------------------------------------------- channels */
const SPRING_CH = [
  "bodyY", "bodySX", "bodySY", "upperY", "sway",
  "headRot", "headX", "headY", "ant",
  "armL", "armR", "handL", "handR",
  "fLX", "fLY", "fLR", "fRX", "fRY", "fRR",
] as const;
const SMOOTH_CH = [
  "breath", "lookX", "lookY", "lids", "eyeSX", "eyeSY", "happy", "wink", "brow", "cheek", "thumb",
  "mIdle", "mSmile", "mOpen", "mLine", "mWorry", "mSleep", "mYawn", "glow",
] as const;
type Ch = (typeof SPRING_CH)[number] | (typeof SMOOTH_CH)[number];
type Vec = Record<Ch, number>;
const CH: Ch[] = [...SPRING_CH, ...SMOOTH_CH];

/* Conventions (all values are DELTAS from the neutral pose, except mIdle which is a weight):
 *  bodyY/headY/upperY/f?Y  px, negative = up
 *  bodySX/SY               scale delta (0.05 = +5 %)
 *  sway/headRot/ant/f?R    degrees, positive = clockwise
 *  armL/armR/handL/handR   "raise" degrees, positive = swing OUTWARD/UP for both sides
 *  breath                  -1..1       lids 0 open .. 1 closed       others 0..1 weights */

/* ----------------------------------------------------------------- helpers */
const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const sstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const osc = (t: number, period: number, phase = 0) => Math.sin((TAU * t) / period + phase);
/** 0→1 between a and b, 1 until c, back to 0 by d. */
const bump = (x: number, a: number, b: number, c: number, d: number) => sstep(a, b, x) * (1 - sstep(c, d, x));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

type Ease = "io" | "out" | "in" | "lin";
type Key = readonly [time: number, value: number, easeIntoThisKey?: Ease];
/** Keyframe interpolation with per-segment easing ("out" = decelerating, good for take-off). */
function kf(t: number, keys: readonly Key[]): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1, e] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      let u = (t - t0) / (t1 - t0);
      switch (e ?? "io") {
        case "out": u = 1 - (1 - u) * (1 - u); break;
        case "in": u = u * u; break;
        case "io": u = 0.5 - 0.5 * Math.cos(Math.PI * u); break;
        default: break;
      }
      return v0 + (v1 - v0) * u;
    }
  }
  return keys[keys.length - 1][1];
}

const zero = (): Vec => { const v = {} as Vec; for (const c of CH) v[c] = 0; return v; };
const reset = (v: Vec) => { for (const c of CH) v[c] = 0; };

/* ------------------------------------------------------------ state specs */
interface Spec {
  /** static posture (deltas from neutral) */
  pose: Partial<Vec>;
  /** continuous looping motion, zero-mean, scaled by M.amp. t = global clock (s). */
  loop?: (t: number, o: Vec) => void;
  /** one-shot choreography, ts = seconds since this state started. */
  shot?: (ts: number, o: Vec, M: Motion) => void;
  /** seconds after which a one-shot's pose/face fades back to idle even if the state lingers */
  dur?: number;
}

const FOOT_RELAXED: Partial<Vec> = { fLX: -1.6, fRX: 1.6, fLR: -7, fRR: 7 };

const SPECS: Record<KiboState, Spec> = {
  idle: {
    pose: { armL: 4, armR: 4 },
    loop: (t, o) => {
      o.bodyY = 2.0 * osc(t, 3.9) + 0.6 * osc(t, 6.3, 1.1);        // float
      o.breath = osc(t, 3.6, -1.2);                                 // torso breathing
      o.sway = 1.5 * osc(t, 5.2, 0.7) + 0.6 * osc(t, 8.7);          // torso sway
      o.headRot = 2.2 * osc(t, 6.7, 0.3) + 0.9 * osc(t, 3.1, 2);    // head tilt
      o.headX = 1.0 * osc(t, 7.3, 1);
      o.headY = 0.7 * osc(t, 4.3);
      o.ant = 3.5 * osc(t, 4.9, 0.5) + 1.8 * osc(t, 2.7);
      o.armL = 4 * osc(t, 4.1);
      o.armR = 4 * osc(t, 4.6, 1.7);
      o.handL = 5 * osc(t, 3.3, 0.4);
      o.handR = 5 * osc(t, 3.7, 1.9);
      const ws = osc(t, 9.1);                                       // slow weight shift
      o.fLY = -0.9 * Math.max(0, ws);
      o.fRY = -0.9 * Math.max(0, -ws);
      o.fLR = 2.2 * ws; o.fRR = 2.2 * ws;
      o.glow = 0.1 * osc(t, 3);
    },
  },

  typing: {
    pose: { headRot: -2.5, headY: 1.5, armL: -12, armR: -12, eyeSX: 0.095, eyeSY: 0.085, glow: 0.06 },
    loop: (t, o) => {
      const p = 0.64;
      o.bodyY = -0.8 * osc(t, p, Math.PI / 2);                       // small rhythmic bounce
      o.bodySY = 0.012 * osc(t, p); o.bodySX = -0.008 * osc(t, p);
      o.breath = osc(t, 2.4);
      o.headRot = 1.1 * osc(t, p * 2, 0.4);
      o.sway = 0.9 * osc(t, p * 2, 1);
      o.ant = 3 * osc(t, p, 0.8);
      o.armL = 5 * osc(t, 0.7) + 2 * osc(t, 0.53, 1.3);              // alternating, not metronomic
      o.armR = 5 * osc(t, 0.7, Math.PI) + 2 * osc(t, 0.61, 0.4);
      o.handL = 11 * osc(t, 0.7, 0.9);
      o.handR = 11 * osc(t, 0.7, Math.PI + 0.9);
      o.fLR = 1.8 * osc(t, 1.28); o.fRR = -1.8 * osc(t, 1.28, 0.9);
      o.glow = 0.12 * osc(t, 1);
    },
  },

  coding: {
    pose: { headRot: 2, headY: 1.5, armL: -10, armR: -10, eyeSX: -0.12, eyeSY: -0.18, mIdle: -1, mLine: 1, glow: 0.1 },
    loop: (t, o) => {
      o.bodyY = 1.2 * osc(t, 2.6);
      o.breath = osc(t, 2.6);
      o.headRot = 1.2 * osc(t, 3.1);
      o.sway = 0.7 * osc(t, 4);
      o.lookX = 3 * osc(t, 3.2);                                      // eyes scan the screen
      o.ant = 3 * osc(t, 1.9);
      o.armL = 4 * osc(t, 0.9); o.armR = 4 * osc(t, 0.9, Math.PI);
      o.handL = 7 * osc(t, 0.9, 1); o.handR = 7 * osc(t, 0.9, Math.PI + 1);
      o.glow = 0.12 * osc(t, 1.5);
    },
  },

  /** small cheerful reaction: dip → lift → bounce → settle */
  happy: {
    dur: 2.4,
    pose: { happy: 1, cheek: 1, mIdle: -1, mSmile: 1 },
    shot: (ts, o, M) => {
      const B = M.big;
      o.bodyY = B * kf(ts, [[0, 0], [0.28, 2.2], [0.62, -9, "out"], [0.92, 0, "in"], [1.04, 1.8, "out"], [1.2, 0], [1.5, -3.5, "out"], [1.78, 0, "in"], [1.9, 0.8], [2.2, 0]]);
      o.bodySX = B * (kf(ts, [[0, 1], [0.28, 1.05], [0.5, 0.97], [0.92, 1], [1.04, 1.05], [1.2, 1], [1.9, 1.02], [2.2, 1]]) - 1);
      o.bodySY = B * (kf(ts, [[0, 1], [0.28, 0.93], [0.5, 1.06], [0.92, 1], [1.04, 0.94], [1.2, 1], [1.9, 0.97], [2.2, 1]]) - 1);
      const arms = kf(ts, [[0, 0], [0.28, -8], [0.62, 100, "out"], [1.45, 100], [2.4, 0]]);
      const fl = 5 * M.osc * bump(ts, 0.7, 1.0, 1.5, 1.9);
      o.armL = arms + fl * osc(ts, 0.55);
      o.armR = arms + fl * osc(ts, 0.55, 1.2);
      o.headRot = kf(ts, [[0, 0], [0.28, -3], [0.62, 5], [1.04, -2], [1.5, 3], [2.2, 0]]);
      o.headY = kf(ts, [[0, 0], [0.28, 1.5], [0.62, -2], [1.04, 1.5], [1.5, -1], [2.2, 0]]);
      o.sway = kf(ts, [[0, 0], [0.28, -1.5], [0.62, 1.5], [1.04, -1], [1.6, 1], [2.3, 0]]);
      const f = kf(ts, [[0, 0], [0.28, -1.2], [0.62, 3, "out"], [0.92, 0, "in"], [1.04, -1], [1.5, 2], [1.78, 0]]);
      o.fLY = f; o.fRY = kf(ts - 0.04, [[0, 0], [0.28, -1.2], [0.62, 3, "out"], [0.92, 0, "in"], [1.04, -1], [1.5, 2], [1.78, 0]]);
      o.fLR = 7 * kf(ts, [[0, 0], [0.62, 1, "out"], [0.92, 0], [1.5, 0.7], [1.78, 0]]);
      o.fRR = -o.fLR;
      o.glow = 0.2 * bump(ts, 0.3, 0.6, 1.4, 2.2);
    },
  },

  /** celebration: anticipation squat → big jump (arms up, feet trailing) → landing squash → small hop → settle */
  achievement: {
    dur: 3.1,
    pose: { happy: 1, cheek: 1, mIdle: -1, mOpen: 1 },
    shot: (ts, o, M) => {
      const B = M.big;
      o.bodyY = B * kf(ts, [[0, 0], [0.3, 2.6], [0.72, -20, "out"], [1.02, 0, "in"], [1.14, 2.8, "out"], [1.3, 0], [1.55, -8, "out"], [1.88, 0, "in"], [2.0, 2, "out"], [2.25, 0]]);
      o.bodySX = B * (kf(ts, [[0, 1], [0.3, 1.06], [0.55, 0.96], [0.72, 0.97], [1.02, 1], [1.14, 1.08], [1.3, 1], [1.55, 0.98], [1.88, 1], [2.0, 1.04], [2.25, 1]]) - 1);
      o.bodySY = B * (kf(ts, [[0, 1], [0.3, 0.92], [0.55, 1.07], [0.72, 1.04], [1.02, 1], [1.14, 0.9], [1.3, 1], [1.55, 1.03], [1.88, 1], [2.0, 0.95], [2.25, 1]]) - 1);
      const arms = kf(ts, [[0, 0], [0.3, -10], [0.76, 122, "out"], [2.35, 122], [3.1, 0]]);
      const fl = 9 * M.osc * bump(ts, 0.8, 1.1, 2.1, 2.6);
      o.armL = arms + fl * osc(ts, 0.5);
      o.armR = arms + fl * osc(ts, 0.5, 1.1);
      o.headRot = kf(ts, [[0, 0], [0.3, -4], [0.72, 6], [1.14, -3], [1.55, 4], [2.3, 0]]);
      o.headY = kf(ts, [[0, 0], [0.3, 2], [0.72, -2.5, "out"], [1.14, 2], [1.55, -1.5], [2.3, 0]]);
      o.sway = kf(ts, [[0, 0], [0.3, -2], [0.72, 2.5], [1.14, -1.5], [1.9, 1.5], [2.8, 0]]);
      const feet = (x: number) => kf(x, [[0, 0], [0.3, -1.5], [0.72, 3.5, "out"], [1.02, 0.5], [1.14, -1.5], [1.3, 0], [1.55, 3], [1.88, 0], [2.25, 0]]);
      o.fLY = feet(ts); o.fRY = feet(ts - 0.05);
      o.fLR = 8 * kf(ts, [[0, 0], [0.72, 1, "out"], [1.02, 0], [1.55, 0.8], [1.88, 0]]);
      o.fRR = -o.fLR;
      o.glow = 0.25 * bump(ts, 0.3, 0.7, 2, 2.8);
    },
  },

  /** one arm waves around its shoulder; hand lags behind; head/torso answer */
  wave: {
    dur: 3.2,
    pose: { mIdle: -1, mSmile: 1, cheek: 0.5 },
    shot: (ts, o, M) => {
      const env = bump(ts, 0.45, 0.8, 2.2, 2.55);
      const ph = osc(ts - 0.5, 0.58);
      o.armR = kf(ts, [[0, 0], [0.38, 124, "out"], [2.55, 124], [3.15, 0]]) + 12 * M.osc * env * ph;
      o.handR = 10 * M.osc * env * osc(ts - 0.5, 0.58, -0.9);
      o.armL = kf(ts, [[0, 0], [0.4, -3], [2.6, -3], [3.15, 0]]);
      o.headRot = kf(ts, [[0, 0], [0.4, 5], [2.5, 5], [3.15, 0]]);
      o.sway = kf(ts, [[0, 0], [0.4, -1.8], [2.5, -1.8], [3.15, 0]]);
      o.headX = kf(ts, [[0, 0], [0.4, -1.2], [2.5, -1.2], [3.15, 0]]);
      o.bodyY = M.big * -0.7 * env * (0.5 + 0.5 * osc(ts - 0.5, 0.58, Math.PI / 2));
      o.fRY = kf(ts, [[0, 0], [0.4, -1.2], [2.5, -1.2], [3.15, 0]]);
    },
  },

  /** gentle cheer: thumbs-up with the left hand, soft wave with the right, wink + smile */
  encourage: {
    dur: 3.4,
    pose: { wink: 1, cheek: 0.7, thumb: 1, mIdle: -1, mSmile: 1 },
    shot: (ts, o, M) => {
      const env = bump(ts, 0.5, 0.9, 2.7, 3.1);
      o.armL = kf(ts, [[0, 0], [0.4, 58, "out"], [3.0, 58], [3.5, 0]]) + 4 * M.osc * env * osc(ts - 0.5, 0.75);
      o.armR = kf(ts, [[0, 0], [0.45, 118, "out"], [2.9, 118], [3.5, 0]]) + 9 * M.osc * env * osc(ts - 0.6, 0.66);
      o.handR = 8 * M.osc * env * osc(ts - 0.6, 0.66, -0.9);
      o.headRot = kf(ts, [[0, 0], [0.4, 5], [3.0, 5], [3.5, 0]]);
      o.bodyY = M.big * -1.8 * env * (0.5 + 0.5 * osc(ts, 1.2, -Math.PI / 2));
      o.sway = kf(ts, [[0, 0], [0.4, -1.2], [3.0, -1.2], [3.5, 0]]);
    },
  },

  /** break: body settles, head tilts, eyelids heavy, relaxed feet; yawn + stretch every 8 s */
  break: {
    pose: { bodyY: 3, headRot: -5, headY: 2, ant: 9, lids: 0.45, mIdle: -1, mLine: 1, armL: 1, armR: 1, ...FOOT_RELAXED },
    loop: (t, o) => {
      const ph = (t % 8) / 8;
      const y = bump(ph, 0.26, 0.34, 0.5, 0.62);                      // yawn envelope
      const st = bump(ph, 0.22, 0.36, 0.52, 0.66);                    // stretch envelope
      o.bodyY = 1.2 * osc(t, 5.5);
      o.breath = osc(t, 5) + 0.9 * y;
      o.headRot = 1.5 * osc(t, 5.5) - 2 * y;
      o.headY = -1.5 * y;
      o.armL = 2 * osc(t, 4.3) + 112 * st; o.armR = 2 * osc(t, 4.9, 1) + 112 * st;
      o.lids = 0.12 * osc(t, 3.3) + 0.55 * y;
      o.mYawn = y; o.mLine = -y;
      o.ant = 2 * osc(t, 5);
      o.glow = 0.06 * osc(t, 4);
    },
  },

  /** sleep: sinks, head droops, antenna droops, eyes close slowly */
  sleep: {
    pose: { bodyY: 8, headRot: 9, headY: 4, ant: 24, lids: 1, mIdle: -1, mSleep: 1, armL: -1, armR: -1, glow: -0.1, ...FOOT_RELAXED },
    loop: (t, o) => {
      o.breath = osc(t, 4.6);
      o.bodyY = 0.5 * osc(t, 4.6);
      o.headRot = 0.9 * osc(t, 4.6, 0.4);
      o.headY = 0.5 * osc(t, 4.6, 0.4);
      o.ant = 1.2 * osc(t, 6);
      o.glow = 0.07 * osc(t, 4.6);
    },
  },

  /** supportive: open hands, gentle tilt, worried brows */
  error: {
    pose: { headRot: -6, ant: 14, armL: 26, armR: 26, brow: 1, mIdle: -1, mWorry: 1, glow: -0.05 },
    loop: (t, o) => {
      o.bodyY = 1.5 * osc(t, 4.5);
      o.breath = osc(t, 4);
      o.headRot = 1.6 * osc(t, 3.2);
      o.armL = 4 * osc(t, 2.6); o.armR = 4 * osc(t, 2.6, Math.PI);
      o.ant = 3 * osc(t, 3);
      o.glow = 0.05 * osc(t, 3);
    },
  },
};
const ORDER = Object.keys(SPECS) as KiboState[];
/** States whose motion is slow enough to render at 30 fps (typing and all one-shots stay at display rate). */
const SLOW_STATES = new Set<KiboState>(["idle", "coding", "break", "sleep", "error"]);

/* -------------------------------------------------------------------- rig */
type Spr = { x: number; v: number; w: number; z: number };

const GROUP_OF: Record<string, string> = {
  bodyY: "body", bodySX: "body", bodySY: "body", upperY: "upper", sway: "upper",
  headRot: "head", headX: "head", headY: "head", ant: "ant",
  armL: "arm", armR: "arm", handL: "hand", handR: "hand",
  fLX: "foot", fLY: "foot", fLR: "foot", fRX: "foot", fRY: "foot", fRR: "foot",
};
const TAU_SMOOTH: Partial<Record<Ch, number>> = {
  breath: 0.3, lookX: 0.09, lookY: 0.09, glow: 0.25, brow: 0.2, thumb: 0.15,
};
const PART_NAMES = [
  "shadow", "body", "upper", "torso", "neck", "head", "antenna", "eyes",
  "eyeL", "eyeR", "arcHL", "arcHR", "arcSL", "arcSR", "brow", "cheekL", "cheekR",
  "mIdle", "mSmile", "mOpen", "mLine", "mWorry", "mSleep", "mYawn",
  "armL", "armR", "handL", "handR", "thumb", "footL", "footR", "halo",
] as const;
type Part = (typeof PART_NAMES)[number];

const f2 = (x: number) => (Math.round(x * 100) / 100).toString();

export class KiboRig {
  private el = {} as Record<Part, SVGElement>;
  private cache = new Map<SVGElement, string>();
  private opCache = new Map<SVGElement, string>();
  private S = {} as Record<(typeof SPRING_CH)[number], Spr>;
  private F = {} as Record<(typeof SMOOTH_CH)[number], number>;
  private w = {} as Record<KiboState, number>;
  private startAt = {} as Record<KiboState, number>;
  private state: KiboState = "idle";
  private M: Motion = MOTION.full;
  private t = 0;
  private raf = 0;
  private last = 0;
  private running = false;

  // scratch vectors (allocated once)
  private T = zero();
  private sc = zero();

  // blinking + idle micro-behaviours
  private blinkAt = rnd(1.5, 3);
  private blinkDouble = false;
  private ev = { kind: "" as "" | "glance" | "twitch" | "fidget" | "hop", start: 0, dur: 1, dir: 1, next: rnd(3, 6) };

  constructor(private svg: SVGSVGElement) {
    for (const n of PART_NAMES) {
      const e = svg.querySelector<SVGElement>(`[data-p="${n}"]`);
      if (!e) throw new Error(`Kibo part missing: ${n}`);
      this.el[n] = e;
    }
    for (const c of SPRING_CH) {
      const [w, z] = SPRING[GROUP_OF[c]];
      this.S[c] = { x: 0, v: 0, w, z };
    }
    for (const c of SMOOTH_CH) this.F[c] = c === "mIdle" ? 1 : 0;
    for (const s of ORDER) { this.w[s] = s === "idle" ? 1 : 0; this.startAt[s] = 0; }
    this.t = rnd(0, 20);               // desync multiple Kibos (dashboard + desktop)
    this.settle();
  }

  /* ---- public API ---- */
  setState(s: KiboState) {
    if (s === this.state) return;
    this.state = s;
    this.startAt[s] = this.t;
  }
  /** Re-trigger the current one-shot (e.g. the same preview button pressed twice). */
  replay() { this.startAt[this.state] = this.t; }
  setMode(m: MotionMode) {
    this.M = MOTION[m];
    for (const c of SPRING_CH) this.S[c].w = SPRING[GROUP_OF[c]][0] * this.M.spring;
  }
  start() {
    if (this.running) return;
    this.running = true; this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  dispose() { this.stop(); this.cache.clear(); this.opCache.clear(); }
  /** Test hook: advance the simulation without rAF. */
  advance(dt: number) { this.step(dt); this.render(); }

  /* ---- loop ---- */
  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.last === 0) { this.last = now; return; }
    const dt = (now - this.last) / 1000;
    // slow ambient states are fully smooth at 30 fps; skipping frames roughly halves their CPU cost
    if (SLOW_STATES.has(this.state) && this.w[this.state] > 0.98 && dt < 0.032) return;
    this.last = now;
    this.step(Math.min(dt, 0.05));
    this.render();
  };

  private settle() {
    // run the blend until springs sit exactly on target: first paint is already a valid pose
    for (let i = 0; i < 4; i++) this.step(0.25);
    this.render();
  }

  private step(dt: number) {
    const M = this.M;
    this.t += dt;
    const tt = this.t * M.speed;                      // clock for loops
    const { T, sc, S, F, w } = this;

    /* 1. state weights: smooth, always normalised to sum 1 */
    const k = M.speed < 1 ? 1.5 : 1;
    let sum = 0;
    for (const s of ORDER) {
      const target = s === this.state ? 1 : 0;
      const tau = (target > w[s] ? TAU_IN : TAU_OUT) * k;
      w[s] += (target - w[s]) * (1 - Math.exp(-dt / tau));
      sum += w[s];
    }
    for (const s of ORDER) w[s] /= sum;

    /* 2. effective weights: one-shots fade back to idle after `dur` */
    let eNon = 0;
    const e = {} as Record<KiboState, number>;
    for (const s of ORDER) {
      if (s === "idle") continue;
      const d = SPECS[s].dur;
      const act = d === undefined ? 1 : 1 - sstep(d, d + 0.9, this.t - this.startAt[s]);
      e[s] = w[s] * act; eNon += e[s];
    }
    e.idle = Math.max(0, 1 - eNon);

    /* 3. blend poses, loops, one-shots, idle micro-behaviours */
    reset(T); T.mIdle = 1;
    for (const s of ORDER) {
      const es = e[s], ws = w[s];
      if (es < 0.002 && ws < 0.002) continue;
      const spec = SPECS[s];
      for (const c of CH) { const p = spec.pose[c]; if (p !== undefined) T[c] += es * p; }
      if (spec.loop && es > 0.002) {
        reset(sc); spec.loop(tt, sc);
        for (const c of CH) T[c] += es * M.amp * sc[c];
      }
      if (spec.shot && ws > 0.002) {
        reset(sc); spec.shot(this.t - this.startAt[s], sc, M);
        for (const c of CH) T[c] += ws * sc[c];
      }
    }
    this.idleBehaviours(T, e.idle, M);          // running gestures fade out with the idle weight; no hard cut
    const blink = this.blink();

    /* 4. secondary motion derived from the velocity of the driving parts */
    T.ant += clamp(-0.14 * S.headRot.v - 0.22 * S.headX.v - 0.08 * S.sway.v, -20, 20);
    T.handL += clamp(-0.11 * S.armL.v, -25, 25);
    T.handR += clamp(-0.11 * S.armR.v, -25, 25);
    const drag = clamp(-0.035 * S.bodyY.v, -4, 4) * (M.big ? 1 : 0.2);   // feet trail the body
    T.fLY += drag; T.fRY += drag;
    T.headY = Math.max(T.headY, -5);                                     // keep neck covered

    /* 5. integrate */
    for (const c of SPRING_CH) this.spring(S[c], T[c], dt);
    for (const c of SMOOTH_CH) {
      let tau = TAU_SMOOTH[c] ?? 0.16;
      if (c === "lids") tau = T.lids > F.lids ? 0.8 : 0.22;               // eyes close slowly, open quickly
      F[c] += (T[c] - F[c]) * (1 - Math.exp(-dt / tau));
    }
    this.blinkV = blink;
  }
  private blinkV = 0;

  private spring(s: Spr, target: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt / (1 / 90))), h = dt / n;
    for (let i = 0; i < n; i++) {
      s.v += (s.w * s.w * (target - s.x) - 2 * s.z * s.w * s.v) * h;
      s.x += s.v * h;
    }
  }

  /** random natural blink, sometimes a double blink. Returns 0..1 closure. */
  private blink(): number {
    const u = this.t - this.blinkAt;
    if (u < 0) return 0;
    const one = (x: number) => (x < 0 ? 0 : sstep(0, 0.07, x) * (1 - sstep(0.1, 0.2, x)));
    const v = Math.max(one(u), this.blinkDouble ? one(u - 0.28) : 0);
    if (u > (this.blinkDouble ? 0.55 : 0.3)) {
      this.blinkAt = this.t + rnd(2.4, 6.2);
      this.blinkDouble = Math.random() < 0.18;
    }
    return v;
  }

  /** occasional glance / antenna twitch / arm fidget / tiny hop, only while idle */
  private idleBehaviours(T: Vec, weight: number, M: Motion) {
    const ev = this.ev;
    if (!ev.kind && this.t >= ev.next && weight > 0.9) {      // only START a new gesture while really idle
      const r = Math.random();
      ev.kind = r < 0.5 ? "glance" : r < 0.72 ? "twitch" : r < 0.92 ? "fidget" : (M.big ? "hop" : "glance");
      ev.start = this.t; ev.dir = Math.random() < 0.5 ? -1 : 1;
      ev.dur = ev.kind === "glance" ? 2 : ev.kind === "twitch" ? 1.2 : ev.kind === "fidget" ? 1.6 : 0.9;
    }
    if (!ev.kind) return;
    const u = this.t - ev.start;
    if (u > ev.dur) { ev.kind = ""; ev.next = this.t + rnd(5, 11); return; }
    const a = M.amp * weight;
    switch (ev.kind) {
      case "glance": {                                    // eyes lead, head follows a beat later
        const eyes = bump(u, 0, 0.25, 1.3, 1.6), head = bump(u, 0.2, 0.55, 1.4, 1.85);
        T.lookX += ev.dir * 4.2 * eyes * weight; T.lookY -= 0.8 * eyes * weight;
        T.headRot += ev.dir * 3.2 * head * a; T.headX += ev.dir * 1.8 * head * a; T.sway += ev.dir * 0.8 * head * a;
        break;
      }
      case "twitch": T.ant += 12 * Math.sin(TAU * 2.5 * u) * (1 - u / ev.dur) * a; T.lookY -= 0.6 * bump(u, 0, 0.2, 0.6, 1) * weight; break;
      case "fidget": {
        const env = bump(u, 0, 0.25, 1.2, 1.6), side = ev.dir > 0;
        const v = 9 * Math.sin(TAU * 1.6 * u) * env * a;
        if (side) { T.armR += v; T.handR += 0.6 * v; } else { T.armL += v; T.handL += 0.6 * v; }
        break;
      }
      case "hop": {
        const h = Math.sin(Math.PI * clamp(u / 0.9, 0, 1));
        T.bodyY -= 3.5 * h * weight; T.bodySY += 0.02 * h * weight; T.armL += 10 * h * weight; T.armR += 10 * h * weight;
        break;
      }
    }
  }

  /* ---- DOM ---- */
  private tf(part: Part, value: string) {
    const el = this.el[part];
    if (this.cache.get(el) === value) return;      // skip redundant DOM writes
    el.setAttribute("transform", value);
    this.cache.set(el, value);
  }
  private op(part: Part, v: number) {
    const el = this.el[part], val = f2(clamp(v, 0, 1));
    if (this.opCache.get(el) === val) return;      // opacity is only written when its rounded value changes
    el.setAttribute("opacity", val);
    this.opCache.set(el, val);
  }

  private render() {
    const S = this.S, F = this.F;
    const around = (px: number, py: number, sx: number, sy: number) =>
      `translate(${px} ${py}) scale(${f2(sx)} ${f2(sy)}) translate(${-px} ${-py})`;

    const lift = -S.bodyY.x;
    this.tf("body", `translate(0 ${f2(S.bodyY.x)}) ${around(100, 224, 1 + S.bodySX.x, 1 + S.bodySY.x)}`);
    this.tf("upper", `translate(0 ${f2(S.upperY.x - 0.7 * F.breath)}) rotate(${f2(S.sway.x)} 100 202)`);
    this.tf("torso", around(100, 202, 1 + 0.006 * F.breath, 1 + 0.014 * F.breath));
    this.tf("neck", `rotate(${f2(0.4 * S.headRot.x)} 100 149)`);
    this.tf("head", `translate(${f2(S.headX.x)} ${f2(S.headY.x)}) rotate(${f2(S.headRot.x)} 100 141)`);
    this.tf("antenna", `rotate(${f2(S.ant.x)} 100 28)`);
    this.tf("armL", `rotate(${f2(S.armL.x)} 63.5 158)`);
    this.tf("handL", `rotate(${f2(S.handL.x)} 63.5 184)`);
    this.tf("armR", `rotate(${f2(-S.armR.x)} 136.5 158)`);
    this.tf("handR", `rotate(${f2(-S.handR.x)} 136.5 184)`);
    this.tf("footL", `translate(${f2(S.fLX.x)} ${f2(S.fLY.x)}) rotate(${f2(S.fLR.x)} 86 214)`);
    this.tf("footR", `translate(${f2(S.fRX.x)} ${f2(S.fRY.x)}) rotate(${f2(S.fRR.x)} 114 214)`);
    this.tf("shadow", around(100, 232, clamp(1 - lift * 0.018, 0.55, 1.1), 1));
    this.op("shadow", 0.3 - lift * 0.006);

    // face: eyes never swap, they cross-fade and scale
    this.tf("eyes", `translate(${f2(F.lookX)} ${f2(F.lookY)})`);
    const lids = clamp(F.lids, 0, 1), happy = clamp(F.happy, 0, 1), wink = clamp(F.wink, 0, 1);
    const happyR = Math.max(happy, wink);
    const sx = 1 + F.eyeSX;
    const syBase = (1 + F.eyeSY) * (1 - 0.88 * lids) * (1 - 0.92 * this.blinkV);
    // Cross-fades are SEQUENTIAL, never two half-transparent eyes at once: the open eye squashes
    // and fades out first, then the arc fades in (reads as "close eyes, then smile").
    const openFade = 1 - sstep(0.65, 0.95, lids), sleepFade = sstep(0.55, 0.95, lids);
    const syL = syBase * (1 - 0.6 * sstep(0, 0.55, happy)), syR = syBase * (1 - 0.6 * sstep(0, 0.55, happyR));
    this.tf("eyeL", around(76, 81.2, sx, syL)); this.tf("eyeR", around(124, 81.2, sx, syR));
    const outL = 1 - sstep(0.15, 0.55, happy), outR = 1 - sstep(0.15, 0.55, happyR);
    this.op("eyeL", outL * openFade); this.op("eyeR", outR * openFade);
    const inL = sstep(0.45, 0.85, happy), inR = sstep(0.45, 0.85, happyR);
    this.op("arcHL", inL); this.op("arcHR", inR);
    this.op("arcSL", (1 - inL) * outL * sleepFade); this.op("arcSR", (1 - inR) * outR * sleepFade);
    this.op("brow", F.brow);
    const ch = 1 + 0.18 * clamp(F.cheek, 0, 1);
    this.tf("cheekL", around(58.7, 103.3, ch, ch)); this.tf("cheekR", around(141.3, 103.3, ch, ch));
    // mouth weights sum to 1; sharpening avoids two overlapping half-opaque mouths mid-transition
    const m = (w: number) => sstep(0.3, 1, w);
    this.op("mIdle", m(F.mIdle)); this.op("mSmile", m(F.mSmile)); this.op("mOpen", m(F.mOpen));
    this.op("mLine", m(F.mLine)); this.op("mWorry", m(F.mWorry)); this.op("mSleep", m(F.mSleep));
    const y = clamp(F.mYawn, 0, 1);
    this.op("mYawn", y); this.tf("mYawn", around(100, 98, 0.35 + 0.65 * y, 0.2 + 0.8 * y));
    const th = clamp(F.thumb, 0, 1);
    this.op("thumb", th); this.tf("thumb", around(60, 193, 0.6 + 0.4 * th, 0.6 + 0.4 * th));
    const g = clamp(0.22 + F.glow, 0.05, 0.7);
    this.op("halo", g); this.tf("halo", around(100, 177, 1 + (g - 0.22) * 1.4, 1 + (g - 0.22) * 1.4));
  }
}
