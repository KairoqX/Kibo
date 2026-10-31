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

* **Floating window** (`src-tauri/tauri.conf.json`): 260×322, frameless, `transparent`, `alwaysOnTop`, `shadow: false`, **`focusable: false`** (clicking or dragging Kibo does not take keyboard focus from your editor). The page, `html`, `body` and `#root` backgrounds are transparent, so nothing is drawn behind Kibo except the character and its speech bubble.
* **Click-through.** The window ignores the mouse (`setIgnoreCursorEvents`) except where Kibo is actually painted (and the hover buttons while shown), so the transparent area around Kibo no longer blocks other apps. Because a click-through window gets no mouse events, `src/petInteraction.ts` samples the pointer position with Tauri's `cursorPosition()`: ~30×/s while the pointer is within ~420 px of Kibo, ~10×/s when it just moved far away, ~4×/s when it is still, and **not at all while Kibo is hidden**. If anything about this fails, the window fails *open* (normally clickable). Turn the whole feature off with **Dashboard → Desktop Kibo → Follow my pointer**.
* **Interactions** (all additive layers on top of the existing rig, so they blend with idle / typing / sleep, never swap poses):

| Gesture | What happens |
|---|---|
| Pointer comes near | Eyes lead, head follows softly; attention fades with distance and when the pointer stops moving for 5 s |
| Hover over Kibo | Soft smile, blush, perked antenna, hover buttons appear (stay ~0.7 s after you leave); at most an occasional "Hey!" (≤ once / 90 s) |
| Click the head | Head pat: head presses down and nuzzles, ^ ^ eyes, antenna wiggle (3 pats in 6 s → the existing *Happy* state + "Let's code!") |
| Click the body | Poke: small recoil away from the click, arms flinch, shy smile |
| 4 clicks in 2.4 s | Playful giggle wiggle, then a 5.5 s cooldown in which clicks only give a tiny acknowledgement |
| Click while asleep / on break | Wakes up and waves (blends through the normal state weights) |
| Drag | Native OS window drag (smooth). Kibo is "held": arms lift, eyes widen, leans against the motion, feet swing. On release: soft landing squash, then it settles. Released near/over a screen edge, it glides back into the nearest monitor's work area |

  Bubbles from interactions are rate-limited (shared slot with the cheer messages, ≥ 8 s apart, per-category cooldowns, Quiet mode ×3).
* **Hide / restore.** Hover button "—", Dashboard → *Show / hide desktop Kibo*, or the **tray menu**: *Show Kibo*, *Hide Kibo*, *Bring Kibo back on screen* (moves it to the bottom-right of the primary monitor), *Quit Kibo*. (No global hotkey: that would need an extra plugin.)
* **Size.** Dashboard → *Kibo size* (Small 0.8× / Normal / Large 1.25×). The window is resized (logical px, DPI-aware) and the SVG is laid out at the new size rather than transform-scaled, so it stays crisp. Window `minWidth/minHeight` were lowered to 200×240 to allow this.
* **Dashboard** is a separate, normal window and is unaffected by the pet's click-through.
* **Reduced motion** is respected: reactions use the gentle profile (no hops/squash), look-at is damped.

### Platform notes / limitations
* Transparency, always-on-top and click-through are Windows 10/11 (WebView2) behaviours; other OSes untested.
* The pet window is non-focusable, so it no longer receives key presses. Typing-state detection from key presses therefore only works in the Dashboard window until a system-wide activity engine is wired up (the dashboard still says "Activity engine not connected yet").
* Pointer position is read locally only to aim Kibo's eyes and decide click-through. It is not stored, logged or sent anywhere.

### Feeding real activity from Rust later
All windows listen for the `kibo:activity` event, so a future global-activity engine only needs:

```rust
use tauri::Emitter;
app.emit("kibo:activity", serde_json::json!({ "state": "typing" }))?;               // counts as a key press
app.emit("kibo:activity", serde_json::json!({ "state": "error", "ms": 6000 }))?;     // one-off reaction
```
(`state` ∈ idle, typing, coding, happy, achievement, wave, break, sleep, encourage, error. `serde_json` is not a dependency yet; add it if you use this.)

## Reactive companion (Alpha 0.2)
Kibo can react to builds and long tasks you report with a small command (`node scripts/kibo-report.mjs build-succeeded`, or `... run -- npm run build`). It is optional, local-only (loopback + token), never reads terminal output or source code, and can be turned off per category in the dashboard. Details, privacy/security notes, manual tests and limitations: [EVENTS.md](EVENTS.md).

**Automatic build reporting (opt-in, per project).** Nothing is detected unless you configure it, and Kibo installs no global hook ([why](EVENTS.md#why-there-is-no-global-auto-detect)). Setup is one short command per project:

```powershell
# Once per machine, optional: puts `kibo` on your PATH. It adds commands only (kibo, kibo-setup, kibo-report);
# no project, npm config or shell profile is changed.
cd C:\Projects\Kibo
npm link                  # undo: npm unlink -g kibo

# In each project you want reported:
cd C:\path\to\your\project
kibo status               # set up? is Kibo running? is the kill switch on?
kibo enable               # shows the exact package.json change, then asks [y/N] before writing
kibo disable              # restores the original scripts exactly
kibo scan C:\Projects     # read-only: which projects below this folder have reporting ON
```

No `npm link`? Run `node C:\Projects\Kibo\scripts\kibo-setup.mjs <command>` instead (inside this repo: `npm run kibo -- <command>`). In scripts and CI nothing is
written without `--apply`. `KIBO_REPORT_DISABLE=1` turns all reporting off without touching any file.

npm's own `prebuild`/`postbuild` hooks can only report start and success (npm never runs `postbuild` after a failure), so the default is a
small wrapper script. A Vite plugin is available too; Cargo has no automatic hook (use `kibo-report run`). Setup, what is and is not
detected, privacy and troubleshooting: [EVENTS.md](EVENTS.md#automatic-build-reporting-opt-in).

## What changed in the interaction + readability update
* `src/kiboRig.ts`: interaction layer (`setLook`, `setHover`, `setDrag`, `dragVelocity`, `react('pat'|'poke'|'giggle'|'land')`); runs at display rate while a reaction is playing.
* `src/petInteraction.ts` (new): click-through, cursor awareness, click policy, drag/release, edge clamping, size presets.
* `src/App.tsx`, `src/useKibo.ts`, `src/Kibo.tsx`, `src/kibo.css`: wiring, `speak`/`touch`, settings `aware` + `petSize`, hit-testing CSS, hover buttons beside Kibo.
* `src/styles.css`, `src/icons.tsx` (new): dashboard rebuilt for readability. Causes found: 8–11 px text with wide letter-spacing in ALL CAPS, a runtime `@import` of Google Fonts (network dependency and fallback-font blur), Unicode/emoji glyphs standing in for icons, `transform: scale(1.04)` on the hero robot, and no opaque page background behind the dashboard text. Now: system UI font stack (Segoe UI Variable / Segoe UI), 15 px body, ≥ 13 px everywhere, rem units, vector icons, no transforms on layout, opaque page background so ClearType can be used.
* `src-tauri`: `lib.rs` (tray: show/hide/reset), `capabilities/default.json` (window permissions), `tauri.conf.json` (`focusable:false`, smaller min size).

## What changed in the animation update
`src/kiboRig.ts` (new animation engine), `src/Kibo.tsx` (same geometry; now hand/neck/upper groups, `data-p` hooks, cross-fading face, fading effect layers; `<text>` Zs replaced by vector paths), `src/kibo.css` (keyframe motion layer removed; effects, fades, reduced-motion), `src/useKibo.ts` (`happy` + `wave` states, replay pulse, every-100-keys cheer, `motion` setting), `src/App.tsx` (click → wave, bubble fades out, Animation setting, replay).

## What changed vs. the earlier version
`src/Kibo.tsx` (new character), `src/kibo.css` (animations + transparent layout), `src/useKibo.ts` (state machine, messages, settings, events), `src/App.tsx` (pet + dashboard integration), `src/styles.css` (old DOM-robot CSS removed, opaque `:root` background removed), `src-tauri/tauri.conf.json` (window size + icons), `src-tauri/capabilities/default.json` (drag/focus/visibility permissions), `src-tauri/Cargo.toml` (`tray-icon` feature), `src-tauri/src/lib.rs` (tray), `src-tauri/icons/*` (generated app icons).
