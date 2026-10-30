(() => {
  "use strict";

  const API_URL = "https://api.github.com/repos/KairoqX/Kibo/releases";
  const RELEASES_URL = "https://github.com/KairoqX/Kibo/releases/latest";
  const downloadButton = document.getElementById("download-button");
  const downloadLabel = document.getElementById("download-label");
  const downloadStatus = document.getElementById("download-status");
  const year = document.getElementById("year");
  const trigger = document.getElementById("mascot-trigger");
  const svg = document.querySelector(".kibo");

  if (year) year.textContent = String(new Date().getFullYear());

  /*
   * Browser-only adaptation of the desktop KiboRig.
   * Source of truth: src/Kibo.tsx and src/kiboRig.ts in the separate Kibo app.
   * It keeps the source SVG geometry, idle motion, springs, blinks, idle gestures,
   * pointer look/hover, and wave choreography without importing React or Tauri.
   */
  if (svg && trigger) createKiboRig(svg, trigger);

  function createKiboRig(root, button) {
    const partNames = [
      "shadow", "body", "upper", "torso", "neck", "head", "antenna", "eyes",
      "eyeL", "eyeR", "arcHL", "arcHR", "arcSL", "arcSR", "brow", "cheekL", "cheekR",
      "mIdle", "mSmile", "mOpen", "mLine", "mWorry", "mSleep", "mYawn",
      "armL", "armR", "handL", "handR", "thumb", "footL", "footR", "halo"
    ];
    const el = Object.fromEntries(partNames.map((name) => [name, root.querySelector(`[data-p="${name}"]`)]));
    if (Object.values(el).some((node) => !node)) return;

    const springGroups = {
      body: [11, 0.72], upper: [9, 0.8], head: [9, 0.72], ant: [9, 0.32],
      arm: [11, 0.6], hand: [13, 0.4], foot: [13, 0.7]
    };
    const springGroup = {
      bodyY: "body", bodySX: "body", bodySY: "body", upperY: "upper", sway: "upper",
      headRot: "head", headX: "head", headY: "head", ant: "ant", armL: "arm", armR: "arm",
      handL: "hand", handR: "hand", fLX: "foot", fLY: "foot", fLR: "foot",
      fRX: "foot", fRY: "foot", fRR: "foot"
    };
    const springNames = Object.keys(springGroup);
    const smoothNames = ["breath", "lookX", "lookY", "eyeSX", "eyeSY", "cheek", "mIdle", "mSmile", "glow"];
    const target = Object.fromEntries([...springNames, ...smoothNames].map((name) => [name, 0]));
    target.mIdle = 1;
    const springs = Object.fromEntries(springNames.map((name) => {
      const [w, z] = springGroups[springGroup[name]];
      return [name, { x: 0, v: 0, w, z }];
    }));
    const filters = Object.fromEntries(smoothNames.map((name) => [name, 0]));
    filters.mIdle = 1;

    const TAU = Math.PI * 2;
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const sstep = (a, b, x) => {
      const t = clamp((x - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
    const osc = (t, period, phase = 0) => Math.sin((TAU * t) / period + phase);
    const bump = (x, a, b, c, d) => sstep(a, b, x) * (1 - sstep(c, d, x));
    const random = (a, b) => a + Math.random() * (b - a);
    const kf = (t, keys) => {
      if (t <= keys[0][0]) return keys[0][1];
      for (let i = 1; i < keys.length; i++) {
        const [t1, v1, ease] = keys[i];
        if (t <= t1) {
          const [t0, v0] = keys[i - 1];
          let u = (t - t0) / (t1 - t0);
          if (ease === "out") u = 1 - (1 - u) * (1 - u);
          else if (ease === "in") u *= u;
          else if (ease !== "lin") u = 0.5 - 0.5 * Math.cos(Math.PI * u);
          return v0 + (v1 - v0) * u;
        }
      }
      return keys[keys.length - 1][1];
    };
    const setTransform = (name, value) => el[name].setAttribute("transform", value);
    const setOpacity = (name, value) => el[name].setAttribute("opacity", String(Math.round(clamp(value, 0, 1) * 100) / 100));
    const around = (x, y, sx, sy) => `translate(${x} ${y}) scale(${sx} ${sy}) translate(${-x} ${-y})`;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => reduced.matches
      ? { amp: 0.65, speed: 0.6, big: 0, osc: 0.5, spring: 0.7 }
      : { amp: 1, speed: 1, big: 1, osc: 1, spring: 1 };
    let M = motion();
    let t = random(0, 20);
    let last = 0;
    let raf = 0;
    let running = false;
    let blinkAt = random(1.5, 3);
    let doubleBlink = false;
    let blinkV = 0;
    let waveAt = -100;
    let waveWeight = 0;
    let hover = 0;
    let targetHover = 0;
    let lookX = 0, lookY = 0, targetLookX = 0, targetLookY = 0, attention = 0, targetAttention = 0;
    const gesture = { kind: "", start: 0, duration: 1, direction: 1, next: random(3, 6) };

    function blink() {
      const u = t - blinkAt;
      if (u < 0) return 0;
      const one = (x) => x < 0 ? 0 : sstep(0, 0.07, x) * (1 - sstep(0.1, 0.2, x));
      const value = Math.max(one(u), doubleBlink ? one(u - 0.28) : 0);
      if (u > (doubleBlink ? 0.55 : 0.3)) {
        blinkAt = t + random(2.4, 6.2);
        doubleBlink = Math.random() < 0.18;
      }
      return value;
    }

    function idleGestures(out, weight) {
      if (!gesture.kind && t >= gesture.next && weight > 0.9) {
        const r = Math.random();
        gesture.kind = r < 0.5 ? "glance" : r < 0.72 ? "twitch" : r < 0.92 ? "fidget" : (M.big ? "hop" : "glance");
        gesture.start = t;
        gesture.direction = Math.random() < 0.5 ? -1 : 1;
        gesture.duration = gesture.kind === "glance" ? 2 : gesture.kind === "twitch" ? 1.2 : gesture.kind === "fidget" ? 1.6 : 0.9;
      }
      if (!gesture.kind) return;
      const u = t - gesture.start;
      if (u > gesture.duration) {
        gesture.kind = "";
        gesture.next = t + random(5, 11);
        return;
      }
      const a = M.amp * weight;
      switch (gesture.kind) {
        case "glance": {
          const eyes = bump(u, 0, 0.25, 1.3, 1.6);
          const head = bump(u, 0.2, 0.55, 1.4, 1.85);
          out.lookX += gesture.direction * 4.2 * eyes * weight;
          out.lookY -= 0.8 * eyes * weight;
          out.headRot += gesture.direction * 3.2 * head * a;
          out.headX += gesture.direction * 1.8 * head * a;
          out.sway += gesture.direction * 0.8 * head * a;
          break;
        }
        case "twitch":
          out.ant += 12 * Math.sin(TAU * 2.5 * u) * (1 - u / gesture.duration) * a;
          out.lookY -= 0.6 * bump(u, 0, 0.2, 0.6, 1) * weight;
          break;
        case "fidget": {
          const env = bump(u, 0, 0.25, 1.2, 1.6);
          const v = 9 * Math.sin(TAU * 1.6 * u) * env * a;
          if (gesture.direction > 0) { out.armR += v; out.handR += 0.6 * v; }
          else { out.armL += v; out.handL += 0.6 * v; }
          break;
        }
        case "hop": {
          const h = Math.sin(Math.PI * clamp(u / 0.9, 0, 1));
          out.bodyY -= 3.5 * h * weight;
          out.bodySY += 0.02 * h * weight;
          out.armL += 10 * h * weight;
          out.armR += 10 * h * weight;
          break;
        }
      }
    }

    function makeTargets(dt) {
      for (const name of springNames) target[name] = 0;
      for (const name of smoothNames) target[name] = 0;
      target.mIdle = 1;

      const waveElapsed = t - waveAt;
      const waveTarget = waveElapsed >= 0 && waveElapsed < 3.2 ? 1 : 0;
      const waveTau = waveTarget > waveWeight ? 0.3 : 0.45;
      waveWeight += (waveTarget - waveWeight) * (1 - Math.exp(-dt / waveTau));
      const idleWeight = 1 - waveWeight;
      const clock = t * M.speed;

      // Original KiboRig idle pose and incommensurate loops.
      target.armL += 4 * idleWeight;
      target.armR += 4 * idleWeight;
      target.bodyY += idleWeight * M.amp * (2.0 * osc(clock, 3.9) + 0.6 * osc(clock, 6.3, 1.1));
      target.breath += idleWeight * M.amp * osc(clock, 3.6, -1.2);
      target.glow += idleWeight * M.amp * 0.1 * osc(clock, 3);
      target.sway += idleWeight * M.amp * (1.5 * osc(clock, 5.2, 0.7) + 0.6 * osc(clock, 8.7));
      target.headRot += idleWeight * M.amp * (2.2 * osc(clock, 6.7, 0.3) + 0.9 * osc(clock, 3.1, 2));
      target.headX += idleWeight * M.amp * 1.0 * osc(clock, 7.3, 1);
      target.headY += idleWeight * M.amp * 0.7 * osc(clock, 4.3);
      target.ant += idleWeight * M.amp * (3.5 * osc(clock, 4.9, 0.5) + 1.8 * osc(clock, 2.7));
      target.armL += idleWeight * M.amp * 4 * osc(clock, 4.1);
      target.armR += idleWeight * M.amp * 4 * osc(clock, 4.6, 1.7);
      target.handL += idleWeight * M.amp * 5 * osc(clock, 3.3, 0.4);
      target.handR += idleWeight * M.amp * 5 * osc(clock, 3.7, 1.9);
      const ws = osc(clock, 9.1);
      target.fLY += idleWeight * M.amp * (-0.9 * Math.max(0, ws));
      target.fRY += idleWeight * M.amp * (-0.9 * Math.max(0, -ws));
      target.fLR += idleWeight * M.amp * 2.2 * ws;
      target.fRR += idleWeight * M.amp * 2.2 * ws;

      // Original wave choreography: shoulder swing, lagging hand, answering head/body.
      if (waveWeight > 0.002) {
        const u = Math.max(0, waveElapsed);
        const env = bump(u, 0.45, 0.8, 2.2, 2.55);
        const phase = osc(u - 0.5, 0.58);
        target.armR += waveWeight * (kf(u, [[0, 0], [0.38, 124, "out"], [2.55, 124], [3.15, 0]]) + 12 * M.osc * env * phase);
        target.handR += waveWeight * 10 * M.osc * env * osc(u - 0.5, 0.58, -0.9);
        target.armL += waveWeight * kf(u, [[0, 0], [0.4, -3], [2.6, -3], [3.15, 0]]);
        target.headRot += waveWeight * kf(u, [[0, 0], [0.4, 5], [2.5, 5], [3.15, 0]]);
        target.sway += waveWeight * kf(u, [[0, 0], [0.4, -1.8], [2.5, -1.8], [3.15, 0]]);
        target.headX += waveWeight * kf(u, [[0, 0], [0.4, -1.2], [2.5, -1.2], [3.15, 0]]);
        target.bodyY += waveWeight * M.big * -0.7 * env * (0.5 + 0.5 * osc(u - 0.5, 0.58, Math.PI / 2));
        target.fRY += waveWeight * kf(u, [[0, 0], [0.4, -1.2], [2.5, -1.2], [3.15, 0]]);
        target.mIdle -= waveWeight;
        target.mSmile += waveWeight;
        target.cheek += waveWeight * 0.5;
      }

      idleGestures(target, idleWeight);

      // Original pointer layer: the eyes lead, then head/torso follow; hover adds a small smile.
      const smooth = (current, next, tau) => current + (next - current) * (1 - Math.exp(-dt / tau));
      lookX = smooth(lookX, targetLookX, 0.12);
      lookY = smooth(lookY, targetLookY, 0.12);
      attention = smooth(attention, targetAttention, targetAttention > attention ? 0.35 : 1.1);
      hover = smooth(hover, targetHover, targetHover > hover ? 0.25 : 0.7);
      const a = attention * M.amp;
      if (a > 0.002) {
        target.lookX += lookX * 5 * a;
        target.lookY += lookY * 3.2 * a;
        target.headRot += lookX * 3.5 * a;
        target.headX += lookX * 1.6 * a;
        target.headY += lookY * 1.2 * a;
        target.sway += lookX * 0.9 * a;
      }
      if (hover > 0.002) {
        const smile = clamp(0.7 * hover, 0, 1);
        const take = clamp(target.mIdle, 0, 1) * smile;
        target.mIdle -= take;
        target.mSmile += take;
        target.cheek = Math.max(target.cheek, 0.7 * hover);
        target.headY -= 0.8 * hover * M.amp;
        target.bodyY -= 0.8 * hover * M.big;
        target.ant += 5 * hover * M.amp * osc(clock, 0.9);
        target.eyeSX += 0.04 * hover;
        target.eyeSY += 0.05 * hover;
        target.armL += 3 * hover;
        target.armR += 3 * hover;
      }

      const blinkValue = blink();
      const headVelocity = springs.headRot.v;
      target.ant += clamp(-0.14 * headVelocity - 0.22 * springs.headX.v - 0.08 * springs.sway.v, -20, 20);
      target.handL += clamp(-0.11 * springs.armL.v, -25, 25);
      target.handR += clamp(-0.11 * springs.armR.v, -25, 25);
      const drag = clamp(-0.035 * springs.bodyY.v, -4, 4) * (M.big ? 1 : 0.2);
      target.fLY += drag;
      target.fRY += drag;

      for (const name of springNames) {
        const spring = springs[name];
        const [baseW] = springGroups[springGroup[name]];
        spring.w = baseW * M.spring;
        const n = Math.max(1, Math.ceil(dt / (1 / 90)));
        const h = dt / n;
        for (let i = 0; i < n; i++) {
          spring.v += (spring.w * spring.w * (target[name] - spring.x) - 2 * spring.z * spring.w * spring.v) * h;
          spring.x += spring.v * h;
        }
      }

      for (const name of smoothNames) {
        let tau = name === "breath" || name === "glow" ? (name === "glow" ? 0.25 : 0.3) : name === "lookX" || name === "lookY" ? 0.09 : 0.16;
        filters[name] += (target[name] - filters[name]) * (1 - Math.exp(-dt / tau));
      }
      blinkV = blinkValue;
    }

    function render() {
      const S = springs, F = filters;
      const lift = -S.bodyY.x;
      setTransform("body", `translate(0 ${fmt(S.bodyY.x)}) ${around(100, 224, 1 + S.bodySX.x, 1 + S.bodySY.x)}`);
      setTransform("upper", `translate(0 ${fmt(-0.7 * F.breath)}) rotate(${fmt(S.sway.x)} 100 202)`);
      setTransform("torso", around(100, 202, 1 + 0.006 * F.breath, 1 + 0.014 * F.breath));
      setTransform("neck", `rotate(${fmt(0.4 * S.headRot.x)} 100 149)`);
      setTransform("head", `translate(${fmt(S.headX.x)} ${fmt(S.headY.x)}) rotate(${fmt(S.headRot.x)} 100 141)`);
      setTransform("antenna", `rotate(${fmt(S.ant.x)} 100 28)`);
      setTransform("armL", `rotate(${fmt(S.armL.x)} 63.5 158)`);
      setTransform("handL", `rotate(${fmt(S.handL.x)} 63.5 184)`);
      setTransform("armR", `rotate(${fmt(-S.armR.x)} 136.5 158)`);
      setTransform("handR", `rotate(${fmt(-S.handR.x)} 136.5 184)`);
      setTransform("footL", `translate(${fmt(S.fLX.x)} ${fmt(S.fLY.x)}) rotate(${fmt(S.fLR.x)} 86 214)`);
      setTransform("footR", `translate(${fmt(S.fRX.x)} ${fmt(S.fRY.x)}) rotate(${fmt(S.fRR.x)} 114 214)`);
      setTransform("shadow", around(100, 232, clamp(1 - lift * 0.018, 0.55, 1.1), 1));
      setOpacity("shadow", 0.2 - lift * 0.006);

      setTransform("eyes", `translate(${fmt(F.lookX)} ${fmt(F.lookY)})`);
      const sx = 1 + F.eyeSX;
      const sy = (1 + F.eyeSY) * (1 - 0.92 * blinkV);
      setTransform("eyeL", around(76, 81.2, sx, sy));
      setTransform("eyeR", around(124, 81.2, sx, sy));
      setOpacity("eyeL", 1);
      setOpacity("eyeR", 1);
      setOpacity("arcHL", 0);
      setOpacity("arcHR", 0);
      setOpacity("arcSL", 0);
      setOpacity("arcSR", 0);
      const cheek = 1 + 0.18 * clamp(F.cheek, 0, 1);
      setTransform("cheekL", around(58.7, 103.3, cheek, cheek));
      setTransform("cheekR", around(141.3, 103.3, cheek, cheek));
      setOpacity("mIdle", sstep(0.3, 1, F.mIdle));
      setOpacity("mSmile", sstep(0.3, 1, F.mSmile));
      setOpacity("mOpen", 0);
      setOpacity("mLine", 0);
      setOpacity("mWorry", 0);
      setOpacity("mSleep", 0);
      setOpacity("mYawn", 0);
      setOpacity("brow", 0);
      setOpacity("thumb", 0);
      const glow = clamp(0.22 + F.glow, 0.05, 0.7);
      setOpacity("halo", glow);
      setTransform("halo", around(100, 177, 1 + (glow - 0.22) * 1.4, 1 + (glow - 0.22) * 1.4));
    }

    function fmt(value) { return (Math.round(value * 100) / 100).toString(); }
    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      if (last === 0) { last = now; return; }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      t += dt;
      makeTargets(dt);
      render();
    }
    function start() {
      if (running || document.hidden) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }
    function resetLook() {
      targetLookX = 0;
      targetLookY = 0;
      targetAttention = 0;
      targetHover = 0;
    }

    button.addEventListener("pointerenter", () => { targetHover = 1; });
    button.addEventListener("pointermove", (event) => {
      const rect = root.getBoundingClientRect();
      targetLookX = clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1);
      targetLookY = clamp(((event.clientY - rect.top) / rect.height - 0.5) * 2, -1, 1);
      targetAttention = 1;
      targetHover = 1;
    }, { passive: true });
    button.addEventListener("pointerleave", resetLook, { passive: true });
    button.addEventListener("click", () => { waveAt = t; targetHover = 1; });
    button.addEventListener("blur", resetLook);
    document.addEventListener("visibilitychange", () => document.hidden ? stop() : start());
    const onMotionChange = () => { M = motion(); };
    if (typeof reduced.addEventListener === "function") reduced.addEventListener("change", onMotionChange);
    else if (typeof reduced.addListener === "function") reduced.addListener(onMotionChange);

    makeTargets(1 / 60);
    render();
    start();
  }

  if (!downloadButton || !downloadLabel || !downloadStatus) return;

  let downloadInProgress = false;
  downloadLabel.textContent = "Download for Windows";
  downloadButton.href = "#";
  downloadButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (downloadInProgress) return;
    void loadLatestInstaller();
  });

  function releaseTimestamp(release) {
    for (const value of [release?.published_at, release?.created_at]) {
      if (typeof value !== "string") continue;
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return null;
  }

  function selectNewestEligibleRelease(releases) {
    if (!Array.isArray(releases)) return null;
    const eligible = releases
      .map((release, index) => ({ release, index }))
      .filter(({ release }) => release && typeof release === "object" && !release.draft);
    eligible.sort((a, b) => {
      const aDate = releaseTimestamp(a.release);
      const bDate = releaseTimestamp(b.release);
      if (aDate === null && bDate === null) return a.index - b.index;
      if (aDate === null) return 1;
      if (bDate === null) return -1;
      return (bDate - aDate) || (a.index - b.index);
    });
    return eligible[0]?.release || null;
  }

  const excludedName = /(\.dmg$|\.deb$|\.rpm$|\.appimage$|\.tar\.(gz|xz)$|darwin|macos|linux|portable)/i;
  const architectureRank = (name) => {
    if (/(arm64|aarch64)/i.test(name)) return 1;
    if (/\bx86\b|i386|i686|win32/i.test(name)) return 2;
    if (/(x64|x86_64|amd64|win64)/i.test(name)) return 4;
    return 3;
  };

  function selectWindowsInstaller(assets) {
    if (!Array.isArray(assets)) return null;
    let candidates = assets.filter((asset) => {
      if (!asset || typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") return false;
      if (excludedName.test(asset.name) || !/\.(exe|msi)$/i.test(asset.name)) return false;
      try { return new URL(asset.browser_download_url).protocol === "https:"; }
      catch { return false; }
    });
    const generalWindowsAssets = candidates.filter((asset) => architectureRank(asset.name.toLowerCase()) >= 3);
    if (generalWindowsAssets.length) candidates = generalWindowsAssets;
    candidates.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExe = /\.exe$/i.test(aName) ? 1 : 0;
      const bExe = /\.exe$/i.test(bName) ? 1 : 0;
      if (aExe !== bExe) return bExe - aExe;
      const aScore = architectureRank(aName) + (/(setup|installer)/i.test(aName) ? 0.1 : 0);
      const bScore = architectureRank(bName) + (/(setup|installer)/i.test(bName) ? 0.1 : 0);
      return bScore - aScore;
    });
    return candidates[0] || null;
  }

  function useReleasesFallback(message) {
    downloadStatus.textContent = `${message} `;
    const fallbackLink = document.createElement("a");
    fallbackLink.className = "release-fallback";
    fallbackLink.href = RELEASES_URL;
    fallbackLink.textContent = "Browse GitHub Releases";
    downloadStatus.appendChild(fallbackLink);
  }

  async function loadLatestInstaller() {
    if (downloadInProgress) return;
    downloadInProgress = true;
    downloadButton.setAttribute("aria-busy", "true");
    downloadStatus.textContent = "Checking for the latest published Windows download…";
    let controller;
    let timeoutId;
    try {
      controller = new AbortController();
      timeoutId = window.setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${API_URL}?per_page=100`, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        if (response.status === 404) {
          useReleasesFallback("No published Kibo releases are available yet.");
        } else if (response.status === 403 || response.status === 429) {
          useReleasesFallback("GitHub is rate-limiting release checks. Please try again later.");
        } else {
          useReleasesFallback("We couldn’t check the latest release. Please try again shortly.");
        }
        return;
      }
      const releases = await response.json();
      const release = selectNewestEligibleRelease(releases);
      if (!release) {
        useReleasesFallback("No published Kibo releases are available yet.");
        return;
      }
      const installer = selectWindowsInstaller(release.assets);
      if (!installer) {
        useReleasesFallback("The newest published release doesn’t include a Windows installer yet.");
        return;
      }
      downloadLabel.textContent = "Download for Windows";
      const releaseKind = release.prerelease ? "Latest pre-release" : "Latest release";
      const version = typeof release.tag_name === "string" && release.tag_name.trim()
        ? `${releaseKind}: ${release.tag_name.trim()}. `
        : `${releaseKind}. `;
      downloadStatus.textContent = `${version}Starting your direct download…`;
      window.location.assign(installer.browser_download_url);
    } catch (error) {
      if (controller?.signal.aborted || error?.name === "AbortError") {
        useReleasesFallback("The GitHub release check timed out. Please try again.");
      } else {
        useReleasesFallback("We couldn’t reach GitHub. Check your connection and try again.");
      }
    } finally {
      downloadInProgress = false;
      downloadButton.removeAttribute("aria-busy");
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }

  // Release lookup begins only after an explicit Windows-button click.
})();
