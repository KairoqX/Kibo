# Kibo – your tiny coding companion

A floating, transparent desktop robot built with **Tauri 2 + Rust + React + TypeScript + Vite**.
Kibo watches *activity signals* (timing and counts only, never what you type) and reacts.

## Run it (Windows)

Prerequisites: Node 20+, Rust (MSVC toolchain + "Desktop development with C++" build tools), WebView2 (preinstalled on Windows 10/11).

```powershell
npm install
npm run tauri dev        # development
npm run tauri build      # NSIS installer in src-tauri/target/release/bundle/
```

## The character

Flat 2D SVG, built from separate geometric parts (`src/Kibo.tsx`): a large head built from the approved icon's proportions (**aspect 1.20, corner radius 0.40 × height, shell 9.7% at the sides and 18% top/bottom**) around a wide navy screen, with side pieces, antenna, cyan eyes, pink cheeks and a curved smile; a rounded **neck that is tucked behind the head shell so it grows out from underneath it**; a small rounded-square torso with a cyan core; capsule arms hugging the torso's upper sides with small detached hands; and **two small shoe-like feet just below the torso — intentionally no legs**.
Gaps are small and deliberate (neck→torso 3 px, arm↔torso 3 px, arm→hand 3 px, torso→feet 4 px) so the pieces read as one compact chibi robot while still animating independently.
Palette: `#E8F0FF` `#C6D2EB` `#0F172A` `#4DD0E1` `#FF8FB1`. No gradients, filters or bitmaps.

### Animation system (`src/kiboRig.ts`)

The scene is one SVG with independently animated groups (`data-p="…"`): body → feet, and an `upper` group (sway/breathing) holding neck, torso, `armL > handL`, `armR > handR`, and `head > antenna, eyes, cheeks, mouths`. A small procedural **rig** moves them by writing `transform`/`opacity` attributes straight to the DOM (no React re-render per frame, no animation dependency):

* **State weights, not state swaps.** Every state has a smoothed weight (they always sum to 1). Poses, loops and one-shot choreographies are blended by those weights, so changing state never restarts or snaps anything.
* **Springs.** Blended targets drive spring-damped channels (slightly under-damped for arms/hands/antenna → soft overshoot and follow-through).
* **Secondary motion from physics.** Antenna whip comes from head/torso velocity, hand flick from arm velocity, and feet trail the body in jumps.
* **Organic idle.** Float, breathing, sway, head tilt, antenna, arms, hands and feet all run on incommensurate periods, plus occasional glances (eyes lead the head), antenna twitches, arm fidgets, tiny hops, and natural single/double blinks.
* **Face never swaps.** Eyes squash and cross-fade sequentially (open → arc); mouths cross-fade; eyelids close gradually for sleep.
* **Performance.** Slow ambient states render at 30 fps, the rest at display rate; DOM writes are skipped when values did not change; the loop stops when the window is hidden. Particles/Zs are CSS-animated vector shapes (no text).
* **Tuning.** Spring constants, blend times, and every state's pose/loop/choreography are at the top of `kiboRig.ts`.

**Reduced motion.** If the OS reports `prefers-reduced-motion` (on Windows: *Settings → Accessibility → Visual effects → Animation effects* off), Kibo switches to a gentle profile: small and slow, no jumping/squashing, no particles. The previous build froze completely in this mode, which looked like "a static image that blinks". The dashboard's **Animation** setting can override this with *Always full*.

| State | What you see | Triggered by |
|---|---|---|
| Idle | float, breathing, torso sway, head tilt, antenna, arm/hand/foot drift, glances, blinks | default |
| Typing | small rhythmic bounce, alternating arm taps with hand flicks, focused head tilt, wide eyes | key presses inside Kibo's windows |
| Coding | calm alternating arm work, eyes scanning, glowing core | ~8 s of sustained typing |
| Happy | dip → lift → bounce → settle, both arms rise, ^ ^ eyes | every 100 keys, or dashboard preview |
| Celebration (`achievement`) | anticipation squat, big jump + small hop, arms up and fluttering, feet trail, squash on landing, stars + confetti | every 300 keys / 15 active minutes |
| Wave | right arm rotates at the shoulder, hand lags behind, head/torso answer | click Kibo |
| Break | droopy head, yawn + stretch loop, coffee cup | inactivity ≥ "sleepy after" |
| Sleep | closed eyes, settles down, drooping antenna, floating z's | inactivity ≥ 2× "sleepy after" |
| Encouragement | thumbs-up, soft wave, wink, speech bubble | a random cheer every 4–7 min |
| Supportive | worried brows, open hands, gentle tilt, never harsh | `error` event / dashboard preview |

Messages are paced: at most one every 25 s (90 s in Quiet mode), never the same one twice in a row, hidden after 4 s, and can be switched off.

## Windows & behavior

* **Floating window** (`src-tauri/tauri.conf.json`): 260×322, frameless, `transparent`, `alwaysOnTop`, `shadow: false`. The page, `html`, `body` and `#root` backgrounds are all transparent, so nothing is drawn behind Kibo except the character and its speech bubble.
* **Move** Kibo by dragging the character (or the bubble area). A plain click makes Kibo wave back.
* **Hover** to reveal two small buttons: open dashboard, hide Kibo.
* **Tray icon** (`Show Kibo` / `Quit Kibo`) restores Kibo after hiding, so the window can never be lost.
* **Dashboard** keeps its original layout and adds: live Kibo preview, 10 mood buttons (they also drive the desktop Kibo), *Encouragement messages* toggle, *Get sleepy after* timer, and *Show / hide desktop Kibo*. Settings are stored locally and shared between windows.

### Platform notes / limitations
* Transparent pixels of the window still catch mouse clicks (full click-through would need `setIgnoreCursorEvents`).
* Transparency/always-on-top are Windows 10/11 (WebView2) behavior; other OSes are untested.
* **Activity detection currently sees only key presses inside Kibo's own windows** (counts/timing only; key identities are never read or stored). System-wide detection is not wired up yet; the dashboard still says "Activity engine not connected yet".

### Feeding real activity from Rust later
All windows listen for the `kibo:activity` event, so a future global-activity engine only needs:

```rust
use tauri::Emitter;
app.emit("kibo:activity", serde_json::json!({ "state": "typing" }))?;               // counts as a key press
app.emit("kibo:activity", serde_json::json!({ "state": "error", "ms": 6000 }))?;     // one-off reaction
```
(`state` ∈ idle, typing, coding, happy, achievement, wave, break, sleep, encourage, error. `serde_json` is not a dependency yet; add it if you use this.)

## What changed in the animation update
`src/kiboRig.ts` (new animation engine), `src/Kibo.tsx` (same geometry; now hand/neck/upper groups, `data-p` hooks, cross-fading face, fading effect layers; `<text>` Zs replaced by vector paths), `src/kibo.css` (keyframe motion layer removed; effects, fades, reduced-motion), `src/useKibo.ts` (`happy` + `wave` states, replay pulse, every-100-keys cheer, `motion` setting), `src/App.tsx` (click → wave, bubble fades out, Animation setting, replay).

## What changed vs. the earlier version
`src/Kibo.tsx` (new character), `src/kibo.css` (animations + transparent layout), `src/useKibo.ts` (state machine, messages, settings, events), `src/App.tsx` (pet + dashboard integration), `src/styles.css` (old DOM-robot CSS removed, opaque `:root` background removed), `src-tauri/tauri.conf.json` (window size + icons), `src-tauri/capabilities/default.json` (drag/focus/visibility permissions), `src-tauri/Cargo.toml` (`tray-icon` feature), `src-tauri/src/lib.rs` (tray), `src-tauri/icons/*` (generated app icons).
