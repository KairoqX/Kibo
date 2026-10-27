export type KiboMood =
  | "idle"
  | "typing"
  | "active"
  | "achievement"
  | "break"
  | "sleep"
  | "wave"
  | "encouragement"
  | "error";

export interface KiboState {
  tracking: boolean;
  quietMode: boolean;
  encouragementEnabled: boolean;
  inactivityMinutes: number;
  mood: KiboMood;
  message: string;
  messageUntil: number;
  lastInteractionAt: number;
  sessionElapsedSeconds: number;
  sessionStartedAt: number;
}

const STORAGE_KEY = "kibo.desktop.state.v1";
const UPDATE_EVENT = "kibo-state-updated";

export const DEFAULT_STATE: KiboState = {
  tracking: false,
  quietMode: false,
  encouragementEnabled: true,
  inactivityMinutes: 5,
  mood: "idle",
  message: "A little buddy, right by your side.",
  messageUntil: 0,
  lastInteractionAt: Date.now(),
  sessionElapsedSeconds: 0,
  sessionStartedAt: 0,
};

const validMoods: KiboMood[] = [
  "idle", "typing", "active", "achievement", "break", "sleep", "wave", "encouragement", "error",
];

export function readKiboState(): KiboState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_STATE;
    const value = JSON.parse(stored) as Partial<KiboState>;
    return {
      ...DEFAULT_STATE,
      ...value,
      mood: validMoods.includes(value.mood as KiboMood) ? value.mood as KiboMood : "idle",
      inactivityMinutes: [1, 5, 10, 20, 30].includes(Number(value.inactivityMinutes))
        ? Number(value.inactivityMinutes)
        : DEFAULT_STATE.inactivityMinutes,
      sessionElapsedSeconds: Math.max(0, Number(value.sessionElapsedSeconds) || 0),
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeKiboState(state: KiboState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The companion still works for this window if browser storage is unavailable.
  }
  window.dispatchEvent(new Event(UPDATE_EVENT));
}

export function subscribeToKiboState(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(UPDATE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(UPDATE_EVENT, onChange);
  };
}
