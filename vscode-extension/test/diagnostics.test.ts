import { test } from "node:test";
import * as assert from "node:assert/strict";
import { describeTransition, DiagnosticsTracker, mapTransition, type Counts, type Transition } from "../src/diagnostics";
import { FakeClock } from "./helpers";

function rig() {
  const clock = new FakeClock(); const out: Array<[Transition, Counts]> = []; let counts: Counts = { errors: 0, warnings: 0 }; let reads = 0;
  const tr = new DiagnosticsTracker({ read: () => { reads++; return { ...counts }; }, onTransition: (t, c) => out.push([t, c]), debounceMs: 1_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, out, tr, set: (c: Counts) => { counts = c; }, reads: () => reads };
}

test("burst of changes is debounced into one evaluation", () => {
  const r = rig();
  r.tr.notify(); r.clock.advance(1_000);                    // baseline
  r.set({ errors: 3, warnings: 0 });
  for (let i = 0; i < 40; i++) { r.tr.notify(); r.clock.advance(100); }
  assert.equal(r.reads(), 1, "no evaluation while changes keep arriving");
  r.clock.advance(1_000);
  assert.equal(r.reads(), 2);
  assert.deepEqual(r.out.map((o) => o[0]), ["errors-appeared"]);
});

test("first sample is only a baseline", () => {
  const r = rig(); r.set({ errors: 5, warnings: 2 });
  r.tr.notify(); r.clock.advance(1_000);
  assert.equal(r.out.length, 0);
});

test("unchanged counts never re-fire (deduplication)", () => {
  const r = rig(); r.tr.notify(); r.clock.advance(1_000);
  r.set({ errors: 2, warnings: 0 }); r.tr.notify(); r.clock.advance(1_000);
  for (let i = 0; i < 5; i++) { r.tr.notify(); r.clock.advance(1_000); }
  assert.deepEqual(r.out.map((o) => o[0]), ["errors-appeared"]);
});

test("errors reduced / cleared, warnings appeared", () => {
  const r = rig(); r.tr.notify(); r.clock.advance(1_000);
  r.set({ errors: 4, warnings: 0 }); r.tr.notify(); r.clock.advance(1_000);
  r.set({ errors: 1, warnings: 0 }); r.tr.notify(); r.clock.advance(1_000);
  r.set({ errors: 0, warnings: 0 }); r.tr.notify(); r.clock.advance(1_000);
  r.set({ errors: 0, warnings: 2 }); r.tr.notify(); r.clock.advance(1_000);
  assert.deepEqual(r.out.map((o) => o[0]), ["errors-appeared", "errors-reduced", "errors-cleared", "warnings-appeared"]);
});

test("transitions carry counts only", () => {
  const r = rig(); r.tr.notify(); r.clock.advance(1_000);
  r.set({ errors: 1, warnings: 0 }); r.tr.notify(); r.clock.advance(1_000);
  assert.deepEqual(Object.keys(r.out[0][1]).sort(), ["errors", "warnings"]);
});

test("no transition is mapped to a Kibo event (protocol has none; diagnostics never imply a failed build)", () => {
  for (const t of ["errors-appeared", "errors-cleared", "errors-reduced", "warnings-appeared"] as Transition[]) assert.equal(mapTransition(t), null);
  assert.equal(describeTransition({ errors: 1, warnings: 0 }, { errors: 1, warnings: 5 }), null);
});

test("dispose cancels a pending evaluation", () => {
  const r = rig(); r.tr.notify(); r.tr.dispose(); r.clock.advance(5_000);
  assert.equal(r.reads(), 0);
});
