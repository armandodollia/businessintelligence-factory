# Desktop App and Feedback Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A packaged BIF for macOS and Windows that a beta tester installs and runs with their own agent CLI, and a feedback bundle (one file) holding every analytic the retro, the lessons engine and the metrics view read.

**Architecture:** The feedback bundle is core code (`src/core/feedbackBundle/`) built from existing queries, served by one route and one page, with a reader script. The server gets a compiled build and learns to find its resources and data relative to the app. An Electron shell (`desktop/`) starts the server as a child process and shows it in a window; `electron-builder` makes the installers. Windows differences live behind small platform functions in `src/core/harness/`.

**Tech Stack:** Node 25, TypeScript ESM, node:sqlite, zod, Hono, React, vitest, esbuild, Electron, electron-builder.

**Spec:** `docs/superpowers/specs/2026-11-16-desktop-app-and-feedback-bundle-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- `src/core` never imports from `src/api`, `web` or `desktop`.
- `npm start`, `npm test`, `npm run dev` in a checkout behave exactly as today (same data folder, same configuration file, same port default).
- A standard bundle holds no research content, no business or node names, no configured user id, no machine paths, no secrets; neither level holds uploads, upload-derived text or internal stakeholder records. The existing redaction and export rules are reused, not rewritten.
- The application never sends a bundle anywhere. It writes it only where the tester chose.
- Every bundle section comes from an existing query function; nothing is re-derived.
- No data crosses business trees inside a section: rows are grouped per tree.
- The packaged app loads nothing from the tester's everyday browser profile; the agent CLI isolation rules hold unchanged.
- Tests never spawn a real agent CLI. No test needs network access.
- Nothing is called "working on Windows" on the strength of tests alone.
- Run `npm test`, `npm run typecheck` before each commit; `npm run build:web` when `web/` changed.

## Review Focus

1. The leak test of spec §7: marker strings in every text field, an upload, a site password, business names, the user id, a machine path in a failure message. None in a standard bundle; upload markers in neither level.
2. The completeness test of spec §3.3 really fails when a source is removed from the bundle (show it failing once).
3. A checkout started with `npm start` after this plan: same `./data`, same `./bif.config.json`, same port; an existing database opens without change.
4. The bundled server started from a directory that is not the repository finds prompts, the price table and the web app, and writes nothing outside the application folder.
5. Quitting the app stops the server, running agents and the research browser; a second launch focuses the first window and starts no second server.
6. Windows code paths are behind a platform switch and the POSIX paths are byte-identical in behaviour to today.

## File Structure

- `src/core/feedbackBundle/{sections,redact,bundle,sources}.ts`; `src/api/feedbackBundleRoutes.ts`; `web/src/views/SendFeedback.tsx`; `scripts/feedback-report.ts`.
- `src/core/runtime/paths.ts` (resources and data locations), `src/core/setup/doctor.ts` (the setup check), `scripts/build-server.ts`, `scripts/doctor.ts`.
- `desktop/` — `main.ts` (the shell), `preload.ts`, `electron-builder.yml`, `package.json` scripts `dist:mac`, `dist:win`; `.github/workflows/desktop.yml`.
- `src/core/harness/platform.ts` — stop a process tree, identify a leftover process, link the Codex login, start a command.
- `docs/beta-testers.md`.
- Tests: `test/core/feedbackBundle/*.test.ts`, `test/api/feedbackBundleRoutes.test.ts`, `test/web/sendFeedback.test.tsx`, `test/core/runtime/paths.test.ts`, `test/core/setup/doctor.test.ts`, `test/core/harness/platform.test.ts`, `test/desktop/*.test.ts`.

---

### Task 1: The feedback bundle, its page and the reader

**Files:** create `src/core/feedbackBundle/*`, `src/api/feedbackBundleRoutes.ts`, `web/src/views/SendFeedback.tsx` (and its place in the navigation), `scripts/feedback-report.ts`, tests; modify the route mounting and `package.json` (script `feedback:report`).

**Interfaces — Produces:**

```ts
// feedbackBundle/bundle.ts
export const BUNDLE_FORMAT = 1;
export type BundleLevel = 'standard' | 'with_texts';
export type BundleOptions = { level: BundleLevel; since?: string; until?: string; note?: string; appVersion: string; platform: { os: string; arch: string; node: string }; clis?: Array<{ name: string; version?: string }> };
export type BundlePreview = { id: string; sections: Array<{ name: string; rows: number; bytes: number }>; totalBytes: number };
export function buildBundle(deps: { store: Store; config: BifConfig }, opts: BundleOptions): { id: string; manifest: Record<string, unknown>; sections: Record<string, unknown> };
export function previewBundle(bundle: ReturnType<typeof buildBundle>): BundlePreview;
export function encodeBundle(bundle: ReturnType<typeof buildBundle>): Buffer;          // gzip of JSON
export function decodeBundle(file: Buffer): ReturnType<typeof buildBundle>;            // throws on an unknown format version
// feedbackBundle/sources.ts
export const RETRO_SOURCES: readonly string[];   // every source the retro digest, collectLessonSignals and metricsReport read, by name
export const SECTION_OF_SOURCE: Record<string, string>;  // which bundle section carries it
```

Rules: spec §3.

- [ ] Read how the retro digest (`src/core/learning/lessons/retro.ts` `retroDigest`), `collectLessonSignals` (`lessons/signals.ts`) and `metricsReport` (`src/core/metrics/report.ts`) get their inputs; list every source in `RETRO_SOURCES`. The completeness test asserts every source has a section and that each section calls the same query function (not a copy of its SQL).
- [ ] The sections of spec §3.3, per business tree, windowed by `since` / `until` where the source has a time.
- [ ] Redaction (`redact.ts`): names → ids, user id → `tester`, secrets (existing `redactSecrets`), configuration without secrets or machine paths, paths in failure messages cut to the last segment. One function applied to the whole bundle last, so a section cannot forget it; the leak test runs against the encoded file.
- [ ] `with_texts`: the texts section, using the existing training export (`exportTrainingData`) for decision lines so its exclusion rules apply as they are.
- [ ] Routes under `/api/feedback-bundle`: `POST /preview` (options → preview and the first rows of a section on request), `POST /` (options → the file, `application/gzip`, with a download file name). No route writes a file on the server's disk.
- [ ] The page "Send feedback": period, level (with one plain sentence each on what it includes), note, preview table, "Save". States what is never included.
- [ ] `scripts/feedback-report.ts` per spec §3.4, with a test on two bundles made from seeded stores.
- [ ] Tests: per section, completeness, the leak test at both levels, decode of an unknown format version, routes, page.

---

### Task 2: A server that can be packaged, and the setup check

**Files:** create `src/core/runtime/paths.ts`, `src/core/setup/doctor.ts`, `scripts/build-server.ts`, `scripts/doctor.ts`, tests; modify `src/api/main.ts`, `src/core/prompts/index.ts` and every other place that finds a file relative to the source tree (`grep -rn "import.meta.url" src`), `src/core/harness/browser.ts` (the shipped research browser), `package.json` (scripts `build:server`, `doctor`; `@playwright/mcp` as a pinned dependency), `src/api/routes.ts` and `web/src/views/Settings.tsx` (setup check, data folder).

Rules: spec §4.1 (server side), §4.2, §4.3, §4.4.

- [ ] `paths.ts`: one place that answers where resources are (prompts, price table, web app) and where data, configuration and logs go. Modes: checkout (today's answers, the default) and packaged (set by environment variables the shell passes: resources directory, application folder).
- [ ] `build:server`: bundle the server entry to JavaScript with esbuild into `dist/server/`, copying the resource files; `node dist/server/main.js` started from another directory serves the health route and the pages (test starts it as a child process on an ephemeral port with a temporary application folder).
- [ ] A free port when asked (`port: 0` already works in tests: make it usable by the shell and report the chosen port on standard output in one parseable line).
- [ ] The research browser: when the shipped `@playwright/mcp` is present, the default shared browser command runs it with the current Node runtime instead of `npx`; a configuration that sets its own command is respected.
- [ ] `doctor`: for each provider find the command (PATH, plus the usual install locations per platform), read its version (`--version`), and tell signed in or not without a model call (read each CLI's `--help` and documentation for a status command or the presence of its credentials; say in the report exactly what each check does and what it cannot tell); find Chrome. `suggestConfig(found)` returns the configuration of spec §4.3 with the beta cost caps. Route `GET /api/setup` and `POST /api/setup/apply` (writes the configuration only when none exists, or when asked explicitly); the Settings page shows the check and the data folder.
- [ ] Tests incl. Review Focus 3 and 4; `doctor` with fake commands on PATH.

---

### Task 3: The shell, the installers, the hosted build, the tester guide

**Files:** create `desktop/*`, `.github/workflows/desktop.yml`, `docs/beta-testers.md`, `test/desktop/*.test.ts`; modify `package.json` (dev dependencies `electron`, `electron-builder`; scripts `desktop:dev`, `dist:mac`, `dist:win`), `.gitignore`.

Rules: spec §4.1 (shell), §4.3 (first run), §4.5.

- [ ] Decide the Node runtime per spec §4.1: check the Node version inside the Electron release you pin and whether `node:sqlite` works there (`ELECTRON_RUN_AS_NODE`); if it does, use it; if not, the build downloads the official Node 25 binary for the target platform and architecture (checksum verified) into the app's resources. Report which and why.
- [ ] `desktop/main.ts`: single instance; start the server child with the packaged paths; wait for its port line; open the window on it; show the first-run setup screen until it passes; application menu with "Send feedback" (opens the page) and "Open data folder"; a save dialog for the bundle download; quit stops the server and waits for it; the server's output goes to the logs folder. The window loads only `http://127.0.0.1:<port>`, with context isolation on, Node integration off, and navigation to any other origin opened in the system browser.
- [ ] `electron-builder.yml`: macOS `dmg` for arm64 and x64, Windows `nsis` x64; unsigned unless the signing environment variables are present; the app name "Business Intelligence Factory".
- [ ] `.github/workflows/desktop.yml`: on a version tag and on manual start: macOS and Windows jobs that run the test suite, build the installer and upload it as a workflow file and to a draft release. No secret is required for an unsigned build.
- [ ] `docs/beta-testers.md`: for a non-developer: install on each platform (incl. opening an unsigned build), install and sign in to an agent CLI, first run, what to try, cost caps, where the data is, how to send feedback, how to remove the app and its data. State plainly that Windows has not had real agent runs.
- [ ] Tests: the shell's pure parts (port line parsing, environment for the child, the navigation rule). Build the macOS app on this machine (`npm run dist:mac`), launch it, check it answers on its port, wrote its data to the application folder, and stops its server on quit; put the commands and their output in the report. Do not run a real agent.

---

### Task 4: Windows in the harness

**Files:** create `src/core/harness/platform.ts`, `test/core/harness/platform.test.ts`; modify `src/core/harness/{supervisor,browser,procinfo}.ts`, the Codex adapter's login link, the OCR runner's kill, the `save_artifact` path rule and any other path comparison (`grep -rn "sep\b\|startsWith(.*dir" src/core`).

Rules: spec §5.

- [ ] `platform.ts`: `stopTree(pid, grace)`, `isOurProcess(pid, startedAt)`, `linkLogin(target, link)`, `commandFor(name)`; POSIX implementations are today's code moved, not changed.
- [ ] Windows implementations per spec §5, each with a unit test that runs on any platform by injecting the platform and the command runner.
- [ ] The hosted Windows job (Task 3) runs the whole suite: fix what fails there for path or process reasons; a test that cannot run on Windows is skipped with a stated reason, not deleted.
- [ ] Report what was verified on Windows (tests only) and what was not (real runs).
