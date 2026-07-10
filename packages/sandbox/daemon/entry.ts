/**
 * Dual-role entrypoint for the single daemon bundle. By default it boots the
 * sandbox daemon; with HARNESS_RUNNER_MODE=1 the SAME bundle boots the slim
 * harness-runner instead. The daemon spawns its own bundle in runner mode
 * (see harness-runner/supervisor.ts), so harness execution happens in a
 * subprocess while every deploy path keeps shipping exactly one artifact.
 */
import { HARNESS_RUNNER_MODE_ENV } from "./harness-runner/protocol";

if (process.env[HARNESS_RUNNER_MODE_ENV] === "1") {
  const { serveHarnessRunner } = await import("./harness-runner/serve");
  serveHarnessRunner();
} else {
  await import("./daemon-entry");
}
