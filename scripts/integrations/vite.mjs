/**
 * Kibo plugin for Vite (opt-in, project-level). Uses Vite/Rollup's official build hooks:
 *   buildStart -> build_started,  buildEnd(error) / renderError -> build_failed,  closeBundle -> build_succeeded.
 *
 *   // vite.config.ts
 *   import kibo from "./scripts/integrations/vite.mjs";
 *   export default defineConfig({ plugins: [react(), kibo()] });
 *
 * What it can and cannot see:
 *   * Only the Vite/Rollup bundling step of `vite build`. Not `vite` (dev server), not watch mode, not `tsc` or anything else
 *     in your build script: for `"build": "tsc && vite build"` a type error never reaches Vite and is invisible to this plugin.
 *     Use the kibo-npm wrapper (scripts/kibo-npm.mjs) when you want the outcome of the whole npm script.
 *   * It cannot see the process exit code. It reports success when Rollup finished without an error.
 *   * If a Kibo reporter (kibo-npm wrapper, `kibo-report run`) already wraps the build, this plugin stays silent.
 * Privacy: sends only the event type, a duration and the label "vite". Does not read configs, sources or logs.
 */
import { report } from "../kibo-report.mjs";
import { createMultiBuildReporter, reportingMode } from "./core.mjs";

const safeReport = async (event, opts) => { try { return await report(event, opts); } catch { return { ok: false, reason: "error" }; } };

/** Rollup/Vite hooks around a reporter. Exported separately so it can be tested without running Vite. */
export function createHooks({ env = process.env, mode = reportingMode(env), ...deps } = {}) {
  const reporter = createMultiBuildReporter({ send: safeReport, source: "vite", mode, ...deps });
  return {
    buildStart: () => reporter.begin(),
    buildEnd: (error) => (error ? reporter.fail() : undefined),
    renderError: () => reporter.fail(),
    closeBundle: () => reporter.end(),
  };
}

/** @param {{ graceMs?: number }} [options] */
export default function kibo(options = {}) {
  let enabled = true;
  const hooks = createHooks({ graceMs: options.graceMs });
  return {
    name: "kibo-report",
    apply: "build",                                    // never the dev server
    configResolved(config) { enabled = !config.build.watch; },   // watch mode rebuilds forever: no start/finish pair to report
    buildStart() { return enabled ? hooks.buildStart() : undefined; },
    buildEnd(error) { return enabled ? hooks.buildEnd(error) : undefined; },
    renderError() { return enabled ? hooks.renderError() : undefined; },
    closeBundle() { return enabled ? hooks.closeBundle() : undefined; },
  };
}
