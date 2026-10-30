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

/* ------------------------------------------------------- interaction layer */
/**
 * Pointer interactions are an ADDITIVE layer on top of the state blend. Nothing here swaps a pose:
 *  - continuous inputs (look-at, hover, being held, drag velocity) are smoothed and added to the targets;
 *  - short reactions (pat / poke / giggle / land) are keyframed deltas that start and end at zero.
 * Everything still goes through the same springs, so interactions blend with idle, typing, sleep...
 */
export type Reaction = "pat" | "poke" | "giggle" | "land";
const REACTION_DUR: Record<Reaction, number> = { pat: 1.5, poke: 1.1, giggle: 1.9, land: 0.8 };

/** Move the mouth/cheeks toward the smile without breaking the "mouth weights sum to 1" rule. */
function smile(T: Vec, w: number, eyes = true) {
  const k = clamp(w, 0, 1);
  if (eyes) T.happy = Math.max(T.happy, k);
  T.cheek = Math.max(T.cheek, k);
  const take = clamp(T.mIdle, 0, 1) * k;
  T.mIdle -= take; T.mSmile += take;
}

type ReactionFn = (u: number, T: Vec, M: Motion, k: number, dir: number) => void;
const REACTIONS: Record<Reaction, ReactionFn> = {
  /** head pat: head is pressed down and nuzzles, happy ^ ^ eyes, antenna wiggles, arms lift a little */
  pat: (u, T, M, k) => {
    const A = M.amp * k, B = M.big * k;
    const joy = bump(u, 0.1, 0.4, 0.95, 1.4);
    T.headY += A * 3.2 * kf(u, [[0, 0], [0.12, 1, "out"], [0.4, 0.5], [0.62, 0.75], [0.95, 0.15], [1.4, 0]]);
    T.bodySY += B * kf(u, [[0, 0], [0.12, -0.04, "out"], [0.4, -0.015], [0.62, -0.025], [1.0, 0.01], [1.4, 0]]);
    T.bodySX += B * kf(u, [[0, 0], [0.12, 0.028, "out"], [0.5, 0.012], [1.4, 0]]);
    T.headRot += A * 4 * osc(u, 0.75) * joy;
    T.ant += A * 10 * osc(u, 0.42) * bump(u, 0.1, 0.35, 1.0, 1.5);
    T.armL += A * 9 * joy; T.armR += A * 9 * joy;
    T.fLR += A * 5 * osc(u, 0.5) * joy; T.fRR -= A * 5 * osc(u, 0.5) * joy;
    smile(T, bump(u, 0, 0.14, 0.95, 1.5) * k);
  },
  /** poke on the body: small recoil away from the poke, arms flinch up, quick hop, then a shy smile */
  poke: (u, T, M, k, dir) => {
    const A = M.amp * k, B = M.big * k;
    T.bodyY += B * kf(u, [[0, 0], [0.07, 2.2, "out"], [0.2, -5.5, "out"], [0.42, 0.8, "in"], [0.55, -1.2], [0.78, 0]]);
    T.bodySX += B * (kf(u, [[0, 1], [0.07, 1.05], [0.2, 0.97], [0.42, 1.04], [0.7, 1]]) - 1);
    T.bodySY += B * (kf(u, [[0, 1], [0.07, 0.94], [0.2, 1.04], [0.42, 0.95], [0.7, 1]]) - 1);
    T.sway += A * dir * kf(u, [[0, 0], [0.1, 5], [0.35, -2.5], [0.7, 0.8], [1.0, 0]]);
    T.headRot += A * dir * kf(u, [[0, 0], [0.12, -3], [0.4, 3], [0.8, 0]]);
    const flinch = kf(u, [[0, 0], [0.1, 26], [0.45, 12], [1.0, 0]]);
    T.armL += A * flinch; T.armR += A * flinch;
    T.handL += A * 10 * osc(u, 0.4) * bump(u, 0, 0.1, 0.4, 0.8);
    T.handR += A * 10 * osc(u, 0.4, 1) * bump(u, 0, 0.1, 0.4, 0.8);
    T.ant -= A * dir * 14 * osc(u, 0.35) * Math.max(0, 1 - u);
    const wide = bump(u, 0, 0.08, 0.4, 0.7) * k;
    T.eyeSX += 0.1 * wide; T.eyeSY += 0.14 * wide;
    const f = kf(u, [[0, 0], [0.2, 0], [0.5, 1], [0.8, 1], [1.1, 0]]) * k;   // "hehe" after the surprise
    smile(T, f, false);
    const fy = A * kf(u, [[0, 0], [0.2, -1.5], [0.5, 0], [1.1, 0]]);
    T.fLY += fy; T.fRY += fy;
  },
  /** repeated clicks: a quick happy wiggle with little hops and flapping arms */
  giggle: (u, T, M, k) => {
    const A = M.amp * k, B = M.big * k, env = bump(u, 0, 0.18, 1.35, 1.9);
    T.bodyY -= B * 2.6 * Math.abs(osc(u, 0.7)) * env;
    T.sway += A * 4 * osc(u, 0.28) * env;
    T.headRot += A * 5 * osc(u, 0.36, 1) * env;
    T.armL += A * (14 + 12 * osc(u, 0.4)) * env;
    T.armR += A * (14 + 12 * osc(u, 0.4, 1.3)) * env;
    T.ant += A * 12 * osc(u, 0.3) * env;
    smile(T, env * k);
  },
  /** after being dropped: soft landing squash, little rebound, everything settles */
  land: (u, T, M, k) => {
    const A = M.amp * k, B = M.big * k;
    T.bodyY += B * kf(u, [[0, 0], [0.1, 2.4, "out"], [0.3, -1.2], [0.55, 0.5], [0.7, 0]]);
    T.bodySY += B * kf(u, [[0, 0], [0.1, -0.07, "out"], [0.3, 0.025], [0.55, -0.008], [0.7, 0]]);
    T.bodySX += B * kf(u, [[0, 0], [0.1, 0.05, "out"], [0.3, -0.015], [0.7, 0]]);
    const arms = kf(u, [[0, 0], [0.1, 14, "out"], [0.45, -3], [0.8, 0]]);
    T.armL += A * arms; T.armR += A * arms;
    const fy = kf(u, [[0, 0], [0.1, -1.2], [0.4, 0.3], [0.7, 0]]);
    T.fLY += A * fy; T.fRY += A * fy;
    T.ant += A * 8 * osc(u, 0.4) * Math.max(0, 1 - u / 0.8);
  },
};

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

  // interaction inputs (smoothed in step(); written by setLook/setHover/setDrag/dragVelocity)
  private I = { lx: 0, ly: 0, att: 0, hover: 0, drag: 0, vx: 0, tlx: 0, tly: 0, tatt: 0, thover: 0, tdrag: 0, tvx: 0 };
  private rxs: { kind: Reaction; start: number; dur: number; k: number; dir: number }[] = [];

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
  /** Cursor direction from the head, each -1..1, and how much attention to pay (0..1). */
  setLook(x: number, y: number, attention: number) {
    const I = this.I;
    I.tlx = clamp(x, -1, 1); I.tly = clamp(y, -1, 1); I.tatt = clamp(attention, 0, 1);
  }
  /** Cursor is over Kibo: soft smile, blush, perked antenna. */
  setHover(on: boolean) { this.I.thover = on ? 1 : 0; }
  /** Kibo is being held / dragged: arms lift, eyes widen, feet dangle. */
  setDrag(on: boolean) { this.I.tdrag = on ? 1 : 0; }
  /** Window velocity in CSS px/s while moving; Kibo leans against it. */
  dragVelocity(vx: number) { this.I.tvx = clamp(vx, -2500, 2500); }
  /** Short additive reaction. `dir` (+1/-1) is the side Kibo recoils toward. */
  react(kind: Reaction, strength = 1, dir = 1) {
    if (this.rxs.length >= 2) this.rxs.shift();
    this.rxs.push({ kind, start: this.t, dur: REACTION_DUR[kind], k: clamp(strength, 0, 1.2), dir: dir >= 0 ? 1 : -1 });
  }
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
    if (SLOW_STATES.has(this.state) && this.w[this.state] > 0.98 && dt < 0.032 && !this.interacting()) return;
    this.last = now;
    this.step(Math.min(dt, 0.05));
    this.render();
  };

  /** reactions / dragging need display-rate frames even while the base state is a slow ambient one */
  private interacting() {
    const I = this.I;
    return this.rxs.length > 0 || I.drag > 0.01 || I.tdrag > 0 || Math.abs(I.vx) > 8 || Math.abs(I.tvx) > 8;
  }

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
    this.interaction(T, dt, M, e);
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

  /** pointer layer: look-at, hover, held/dragged, and the short reactions (all additive, all smoothed) */
  private interaction(T: Vec, dt: number, M: Motion, e: Record<KiboState, number>) {
    const I = this.I, k = (tau: number) => 1 - Math.exp(-dt / tau);
    I.lx += (I.tlx - I.lx) * k(0.12); I.ly += (I.tly - I.ly) * k(0.12);
    I.att += (I.tatt - I.att) * k(I.tatt > I.att ? 0.35 : 1.1);
    I.hover += (I.thover - I.hover) * k(I.thover > I.hover ? 0.25 : 0.7);
    I.drag += (I.tdrag - I.drag) * k(I.tdrag > I.drag ? 0.14 : 0.45);
    I.tvx *= Math.exp(-dt / 0.18);                       // velocity fades when no new window moves arrive
    I.vx += (I.tvx - I.vx) * k(0.08);

    const awake = clamp(1 - e.sleep - 0.55 * e.break, 0, 1);                        // a sleeping Kibo doesn't track
    const calm = clamp(e.idle + 0.35 * (e.typing + e.coding + e.error + e.encourage + e.wave), 0, 1);
    const a = I.att * awake * calm * M.amp;
    if (a > 0.002) {                                                                // eyes lead, head follows softly
      T.lookX += I.lx * 5 * a; T.lookY += I.ly * 3.2 * a;
      T.headRot += I.lx * 3.5 * a; T.headX += I.lx * 1.6 * a; T.headY += I.ly * 1.2 * a;
      T.sway += I.lx * 0.9 * a;
    }
    const h = I.hover * awake * calm;
    if (h > 0.002) {
      smile(T, 0.7 * h, false);
      T.headY -= 0.8 * h * M.amp; T.bodyY -= 0.8 * h * M.big;
      T.ant += 5 * h * M.amp * osc(this.t * M.speed, 0.9);
      T.eyeSX += 0.04 * h; T.eyeSY += 0.05 * h;
      T.armL += 3 * h; T.armR += 3 * h;
    }
    const d = I.drag;
    if (d > 0.002) {                                                                // being held
      const tt = this.t * M.speed;
      T.armL += (20 + 5 * osc(tt, 0.9)) * d * M.amp; T.armR += (20 + 5 * osc(tt, 0.9, 1.4)) * d * M.amp;
      T.handL += 9 * d * osc(tt, 0.5) * M.amp; T.handR += 9 * d * osc(tt, 0.5, 2) * M.amp;
      T.eyeSX += 0.06 * d; T.eyeSY += 0.1 * d;
      T.bodyY -= 2 * d * M.big; T.fLY += 1.5 * d * M.amp; T.fRY += 1.5 * d * M.amp;
      smile(T, 0.6 * d, false);
    }
    const vn = clamp(I.vx / 900, -1, 1);                                            // lean against the motion
    if (Math.abs(vn) > 0.004) {
      const L = M.amp * (0.5 + 0.5 * Math.max(d, 0.4));
      T.sway -= vn * 7 * L; T.headRot -= vn * 6 * L; T.ant -= vn * 16 * L;
      T.fLR += vn * 14 * L; T.fRR += vn * 14 * L;
      const up = Math.abs(vn) * 15 * d * M.amp; T.armL += up; T.armR += up;
    }
    this.applyReactions(T, M);
  }

  private applyReactions(T: Vec, M: Motion) {
    const list = this.rxs;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i], u = this.t - r.start;
      if (u > r.dur) { list.splice(i, 1); continue; }
      REACTIONS[r.kind](u, T, M, r.k, r.dir);
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
