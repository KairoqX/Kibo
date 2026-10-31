import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, sanitizeSettings, saveSettings, type StorageLike } from "./settings.ts";

const mem = (init: Record<string, string> = {}): StorageLike & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
};

test("defaults: dev + activity reactions and bubbles on; waking sleeping Kibo off", () => {
  const s = loadSettings(mem());
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.equal(s.devEvents, true); assert.equal(s.eventsWake, false);
});

test("new settings persist and load back", () => {
  const st = mem();
  const next = { ...DEFAULT_SETTINGS, devEvents: false, activityEvents: false, eventMessages: false, longTaskCelebrate: false, eventsWake: true, quiet: true };
  assert.equal(saveSettings(st, next), true);
  assert.deepEqual(loadSettings(st), next);
});

test("settings saved by Alpha 0.1 (no event keys) load with the new defaults and keep old values", () => {
  const old = JSON.stringify({ messages: false, quiet: true, sleepyAfter: 300, motion: "full", aware: false, petSize: "large" });
  const s = loadSettings(mem({ [SETTINGS_KEY]: old }));
  assert.equal(s.messages, false); assert.equal(s.petSize, "large"); assert.equal(s.sleepyAfter, 300);
  assert.equal(s.devEvents, true); assert.equal(s.eventsWake, false);
});

test("corrupt or wrongly-typed storage falls back safely", () => {
  assert.deepEqual(loadSettings(mem({ [SETTINGS_KEY]: "{oops" })), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
  const s = sanitizeSettings({ devEvents: "yes", sleepyAfter: -4, petSize: "huge", motion: 3 });
  assert.equal(s.devEvents, true); assert.equal(s.sleepyAfter, 120); assert.equal(s.petSize, "normal"); assert.equal(s.motion, "system");
});

test("unavailable storage does not throw", () => {
  const broken: StorageLike = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.deepEqual(loadSettings(broken), DEFAULT_SETTINGS);
  assert.equal(saveSettings(broken, DEFAULT_SETTINGS), false);
});
