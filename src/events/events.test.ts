import { test } from "node:test";
import assert from "node:assert/strict";
import { EventOrchestrator, PENDING_TTL_MS, RETRY_MS, type OrchestratorEnv, type PlayRequest } from "./orchestrator.ts";
import { parseWireEvent, type EventType, type KiboEvent } from "./types.ts";
import { DEFAULT_SETTINGS, type Settings } from "../settings.ts";
import { LONG_TASK_MS } from "./policy.ts";
import type { KiboState } from "../kiboRig.ts";

function rig(over: Partial<Settings> = {}) {
  const t = { now: 1_000_000, settings: { ...DEFAULT_SETTINGS, ...over } as Settings, pet: "idle" as KiboState, hidden: false, busy: false };
  const played: PlayRequest[] = [];
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const env: OrchestratorEnv = {
    now: () => t.now, settings: () => t.settings, petState: () => t.pet, hidden: () => t.hidden, interacting: () => t.busy,
    play: (r) => played.push(r),
    schedule: (fn, ms) => { const h = { fn, at: t.now + ms, live: true }; timers.push(h); return () => { h.live = false; }; },
  };
  const o = new EventOrchestrator(env);
  const ev = (type: EventType, extra: Partial<KiboEvent> = {}): KiboEvent => ({ type, at: t.now, ...extra });
  const advance = (ms: number) => {
    t.now += ms;
    for (const h of timers.filter((x) => x.live && x.at <= t.now)) { h.live = false; h.fn(); }
  };
  return { t, o, ev, played, advance, timers };
}

/* 1 + 2: intended reaction requests */
test("build_succeeded requests the existing happy animation + success message", () => {
  const { o, ev, played } = rig();
  const r = o.handle(ev("build_succeeded", { durationMs: 4000 }));
  assert.equal(r.status, "played");
  assert.equal(played[0].state, "happy");
  assert.equal(played[0].message, "success");
  assert.equal(played[0].wake, false);
});

test("build_failed requests the supportive (error) state, then it is a one-shot overlay with a duration", () => {
  const { o, ev, played } = rig();
  o.handle(ev("build_failed"));
  assert.equal(played[0].state, "error");
  assert.equal(played[0].message, "failure");
  assert.ok(played[0].ms > 0 && played[0].ms < 10_000);
});

test("build_started shows a brief attentive (coding) state with no bubble", () => {
  const { o, ev, played } = rig();
  o.handle(ev("build_started"));
  assert.equal(played[0].state, "coding");
  assert.equal(played[0].message, null);
});

test("long success celebrates more; trivial task_completed never celebrates", () => {
  const a = rig();
  a.o.handle(a.ev("build_succeeded", { durationMs: LONG_TASK_MS + 1 }));
  assert.equal(a.played[0].state, "achievement");
  assert.equal(a.played[0].message, "long");

  const b = rig();
  assert.deepEqual(b.o.handle(b.ev("task_completed", { durationMs: 2000 })), { status: "dropped", reason: "trivial" });
  b.advance(3000);                                       // past the dedupe window so the policy (not dedupe) answers
  assert.deepEqual(b.o.handle(b.ev("task_completed")), { status: "dropped", reason: "trivial" });
  assert.equal(b.played.length, 0);

  const c = rig();
  c.o.handle(c.ev("task_completed", { durationMs: LONG_TASK_MS }));
  assert.equal(c.played[0].state, "achievement");
});

test("long-task celebration can be turned off (falls back to happy) and quiet mode is subtle", () => {
  const a = rig({ longTaskCelebrate: false });
  a.o.handle(a.ev("build_succeeded", { durationMs: LONG_TASK_MS * 2 }));
  assert.equal(a.played[0].state, "happy");
  const q = rig({ quiet: true });
  q.o.handle(q.ev("build_succeeded", { durationMs: LONG_TASK_MS * 2 }));
  assert.equal(q.played[0].state, "happy");
  assert.deepEqual(q.o.handle(q.ev("build_started")), { status: "dropped", reason: "quiet" });
});

test("duration is inferred from a matching build_started", () => {
  const { t, o, ev, played, advance } = rig();
  o.handle(ev("build_started", { source: "cargo" }));
  advance(LONG_TASK_MS + 5000);
  o.handle(ev("build_succeeded", { source: "cargo" }));
  assert.equal(played[played.length - 1].state, "achievement");
  assert.ok(t.now > 0);
});

/* 3: duplicates */
test("duplicate events inside the dedupe window are dropped", () => {
  const { o, ev, played, advance } = rig();
  o.handle(ev("build_succeeded"));
  advance(500);
  assert.deepEqual(o.handle(ev("build_succeeded")), { status: "dropped", reason: "duplicate" });
  assert.equal(played.length, 1);
});

/* 4: cooldown */
test("cooldown stops repeated celebrations, then allows another one", () => {
  const { o, ev, played, advance } = rig();
  o.handle(ev("build_succeeded"));
  advance(3000);
  assert.deepEqual(o.handle(ev("build_succeeded")), { status: "dropped", reason: "cooldown" });
  advance(6000);
  assert.equal(o.handle(ev("build_succeeded")).status, "played");
  assert.equal(played.length, 2);
});

test("quiet mode doubles cooldowns", () => {
  const { o, ev, advance } = rig({ quiet: true });
  o.handle(ev("build_succeeded"));
  advance(10_000);                                       // > 8s normal cooldown, < 16s quiet cooldown
  assert.deepEqual(o.handle(ev("build_succeeded")), { status: "dropped", reason: "cooldown" });
});

/* 5: priority */
test("a lower-priority event cannot interrupt a higher-priority reaction in progress", () => {
  const { o, ev, played, advance } = rig();
  o.handle(ev("build_succeeded", { durationMs: LONG_TASK_MS }));      // achievement, priority 4
  advance(2500);
  assert.deepEqual(o.handle(ev("build_failed")), { status: "dropped", reason: "lower-priority" });
  assert.equal(played.length, 1);
});

test("a finished build replaces the brief 'started' reaction; once it ends anything may play", () => {
  const { o, ev, played, advance } = rig();
  o.handle(ev("build_started"));
  advance(1000);
  assert.equal(o.handle(ev("build_failed")).status, "played");
  assert.equal(played.map((p) => p.state).join(), "coding,error");
});

test("a lower-priority welcome does not interrupt a build outcome", () => {
  const { o, ev, advance } = rig();
  o.handle(ev("build_failed"));
  advance(1000);
  assert.deepEqual(o.handle(ev("user_returned")), { status: "dropped", reason: "lower-priority" });
});

/* 6: sleep policy */
test("sleeping Kibo ignores events by default", () => {
  const { t, o, ev, played } = rig();
  t.pet = "sleep";
  assert.deepEqual(o.handle(ev("build_succeeded")), { status: "dropped", reason: "sleeping" });
  assert.equal(played.length, 0);
});

test("with eventsWake enabled a sleeping Kibo is woken explicitly", () => {
  const { t, o, ev, played } = rig({ eventsWake: true });
  t.pet = "sleep";
  o.handle(ev("build_succeeded"));
  assert.equal(played[0].wake, true);
});

test("break state is not sleep: reaction plays without waking", () => {
  const { t, o, ev, played } = rig();
  t.pet = "break";
  o.handle(ev("build_succeeded"));
  assert.equal(played[0].wake, false);
});

/* 7: hidden */
test("hidden Kibo never reacts, even when eventsWake is on, and nothing is queued", () => {
  const { t, o, ev, played, advance, timers } = rig({ eventsWake: true });
  t.hidden = true;
  assert.deepEqual(o.handle(ev("build_failed")), { status: "dropped", reason: "hidden" });
  t.hidden = false;
  advance(10_000);
  assert.equal(played.length, 0);
  assert.equal(timers.length, 0);
});

/* 8: disabled integrations */
test("disabled dev events / activity events trigger nothing", () => {
  const a = rig({ devEvents: false });
  for (const type of ["build_started", "build_succeeded", "build_failed", "task_completed"] as const) {
    assert.deepEqual(a.o.handle(a.ev(type, { durationMs: LONG_TASK_MS })), { status: "dropped", reason: "disabled" });
  }
  const b = rig({ activityEvents: false });
  assert.deepEqual(b.o.handle(b.ev("user_returned")), { status: "dropped", reason: "disabled" });
  assert.equal(a.played.length + b.played.length, 0);
});

test("activity events: user_returned waves; system_active only after a real absence; system_idle is reserved", () => {
  const a = rig();
  a.o.handle(a.ev("user_returned"));
  assert.equal(a.played[0].state, "wave");
  const b = rig();
  assert.deepEqual(b.o.handle(b.ev("system_active", { durationMs: 1000 })), { status: "dropped", reason: "short-absence" });
  b.advance(3000);
  assert.equal(b.o.handle(b.ev("system_active", { durationMs: 10 * 60_000 })).status, "played");
  assert.deepEqual(b.o.handle(b.ev("system_idle")), { status: "dropped", reason: "ignored" });
});

/* user interaction priority */
test("a build outcome during a drag is deferred and plays once the user lets go", () => {
  const { t, o, ev, played, advance } = rig();
  t.busy = true;
  assert.deepEqual(o.handle(ev("build_succeeded")), { status: "deferred" });
  advance(RETRY_MS);
  assert.equal(played.length, 0);
  t.busy = false;
  advance(RETRY_MS);
  assert.equal(played.length, 1);
});

test("a deferred event expires instead of firing long after the fact", () => {
  const { t, o, ev, played, advance } = rig();
  t.busy = true;
  o.handle(ev("build_succeeded"));
  for (let i = 0; i < 12; i++) advance(RETRY_MS);
  t.busy = false;
  advance(PENDING_TTL_MS);
  assert.equal(played.length, 0);
});

test("ambient events are dropped (not queued) while the user interacts; dispose cancels timers", () => {
  const { t, o, ev, timers } = rig();
  t.busy = true;
  assert.deepEqual(o.handle(ev("user_returned")), { status: "dropped", reason: "user-interacting" });
  o.handle(ev("build_failed"));
  o.dispose();
  assert.ok(timers.every((x) => !x.live));
});

test("an exploding environment cannot crash event handling", () => {
  const { t, o, ev } = rig();
  (t as { settings: unknown }).settings = null;
  assert.equal(o.handle(ev("build_failed")).status, "dropped");
});

/* 9: invalid events */
test("parseWireEvent accepts valid payloads and stamps its own timestamp", () => {
  const e = parseWireEvent('{"type":"build_failed","durationMs":1200,"source":"npm","at":1,"junk":"x"}', 42);
  assert.deepEqual(e, { type: "build_failed", at: 42, durationMs: 1200, source: "npm" });
});

test("parseWireEvent rejects malformed, oversized and out-of-range input", () => {
  const bad: unknown[] = [
    "", "not json", "null", "[]", "42", '"build_failed"', null, undefined, 7, [],
    '{"type":"rm_rf"}', '{"type":1}', "{}",
    '{"type":"build_failed","durationMs":-1}', '{"type":"build_failed","durationMs":"5"}',
    '{"type":"build_failed","durationMs":1e12}', '{"type":"build_failed","durationMs":null}',
    '{"type":"build_failed","source":"has space"}', '{"type":"build_failed","source":"../etc"}',
    '{"type":"build_failed","source":""}', `{"type":"build_failed","source":"${"a".repeat(33)}"}`,
    `{"type":"build_failed","pad":"${"x".repeat(600)}"}`,
  ];
  for (const b of bad) assert.equal(parseWireEvent(b, 1), null, JSON.stringify(b)?.slice(0, 60));
});
