/**
 * Manually-maintained DBOS application version. Pins recovery compatibility so
 * deploys stop stranding in-flight workflows. DBOS's default is an MD5 of every
 * registered workflow's source, which churns on every bundled deploy — a new
 * hash means in-flight workflows of the old version have no executor able to
 * recover them, so they strand (the thread-gate "accepted and queued" wedge).
 * See docs/superpowers/specs/2026-06-25-dbos-app-version-pinning-design.md.
 *
 * NOTE: under DBOS Cloud (process.env.DBOS__CLOUD === "true") the SDK ignores
 * applicationVersion and uses its own env-supplied version instead. This repo
 * self-hosts and sets neither DBOS__CLOUD nor DBOS__APPVERSION, so the pin
 * takes full effect — but be aware of this if the deploy target ever changes.
 *
 * GLOBAL: one value for ALL registered workflows in the process. Fed to
 * DBOS.setConfig({ applicationVersion }) via buildDbosConfig().
 *
 * BUMP this (e.g. "1" -> "2") ONLY when a registered workflow changes such that
 * an in-flight instance becomes unrecoverable against the new code:
 *   - add / remove / reorder a step (DBOS.runStep / a registered step) in a workflow
 *   - change the recorded input/output contract of an existing step
 *   - change control flow so the step SEQUENCE differs on replay
 *   - an AI-SDK / library upgrade that alters any of the above
 *
 * Do NOT bump for recovery-compatible changes:
 *   - editing logic INSIDE a step (its recorded output is replayed, not re-run)
 *   - non-workflow code, comments, formatting, renames that don't change step order
 *
 * Bumping deliberately strands whatever is mid-flight on the prior version (a
 * one-time cost) — correct, because those instances ARE incompatible.
 */
export const DBOS_WORKFLOW_VERSION = "1";
