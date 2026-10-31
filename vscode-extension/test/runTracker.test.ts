import { test } from "node:test";
import * as assert from "node:assert/strict";
import { RunTracker } from "../src/runTracker";
import { FakeClock } from "./helpers";

function setup(enabled = () => true) {
  const clock = new FakeClock(); const sent: Array<[string, object]> = [];
  const t = new RunTracker({ source: "vscode", send: (e, m) => { sent.push([e, m]); }, enabled, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, graceMs: 400 });
  return { clock, sent, t };
}

test("one run: started, then succeeded with the measured duration after the grace period", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); clock.advance(5_000); t.end("a", "success");
  assert.deepEqual(sent, [["build_started", { source: "vscode" }]]);
  clock.advance(400);
  assert.deepEqual(sent[1], ["build_succeeded", { durationMs: 5_000, source: "vscode" }]);
  assert.equal(sent.length, 2);
});

test("failure is reported immediately, once", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); clock.advance(1_200); t.end("a", "failure");
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_failed"]);
  assert.deepEqual(sent[1][1], { durationMs: 1_200, source: "vscode" });
  clock.advance(10_000);
  assert.equal(sent.length, 2);
});

test("cancelled run reports no result at all", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); clock.advance(300); t.end("a", "cancelled"); clock.advance(5_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started"]);
});

test("compound build: sequential tasks inside the grace window are ONE build", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); clock.advance(1_000); t.end("a", "success");
  clock.advance(100); t.begin("b"); clock.advance(2_000); t.end("b", "success");
  clock.advance(1_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_succeeded"]);
  assert.equal((sent[1][1] as { durationMs: number }).durationMs, 3_100);   // measured to the last task's end, not including the grace wait
});

test("parallel tasks: success only after all finished; a failure wins immediately and later ends add nothing", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); t.begin("b"); t.begin("c");
  t.end("a", "success"); clock.advance(1_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started"]);
  t.end("b", "failure");
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_failed"]);
  t.end("c", "success"); clock.advance(5_000);
  assert.equal(sent.length, 2);
});

test("hundreds of runs in one batch still produce one start and one result", () => {
  const { clock, sent, t } = setup();
  for (let i = 0; i < 300; i++) t.begin(`k${i}`);
  for (let i = 0; i < 300; i++) t.end(`k${i}`, i === 137 ? "failure" : "success");
  clock.advance(5_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_failed"]);
});

test("a new batch after a finished one starts fresh", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); t.end("a", "success"); clock.advance(500);
  t.begin("b"); t.end("b", "failure");
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_succeeded", "build_started", "build_failed"]);
});

test("unknown or repeated end events are ignored (never a result without a start, never two results)", () => {
  const { clock, sent, t } = setup();
  t.end("ghost", "failure"); t.end("ghost", "success");
  t.begin("a"); t.end("a", "failure"); t.end("a", "failure"); t.end("a", "success"); clock.advance(2_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_failed"]);
});

test("disabled reporting: nothing is sent, and disabling mid-run suppresses nothing it should not", () => {
  let on = false;
  const { clock, sent, t } = setup(() => on);
  t.begin("a"); t.end("a", "failure"); clock.advance(2_000);
  assert.equal(sent.length, 0);
  on = true; t.begin("b"); on = false; t.end("b", "failure");     // began while enabled: still reported
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_failed"]);
  on = false; sent.length = 0;
  on = true; t.begin("c"); on = true; t.end("c", "success");
  on = false; t.begin("d"); on = true; t.end("d", "failure");     // began while disabled: ignored for life
  clock.advance(2_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started", "build_succeeded"]);
});

test("a throwing or rejecting sender never escapes", async () => {
  const clock = new FakeClock();
  const t = new RunTracker({ source: "vscode", enabled: () => true, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    send: () => { throw new Error("boom"); } });
  assert.doesNotThrow(() => { t.begin("a"); t.end("a", "failure"); });
  const t2 = new RunTracker({ source: "vscode", enabled: () => true, send: () => Promise.reject(new Error("x")) });
  assert.doesNotThrow(() => { t2.begin("a"); });
  await new Promise((r) => setImmediate(r));
});

test("dispose cancels the pending success", () => {
  const { clock, sent, t } = setup();
  t.begin("a"); t.end("a", "success"); t.dispose(); clock.advance(5_000);
  assert.deepEqual(sent.map((s) => s[0]), ["build_started"]);
  assert.equal(clock.pending(), 0);
});
