/**
 * Single source of truth for "which sandbox daemon binary should this sandbox
 * run?" — the Go-daemon rollout gate. Mirrors how `resolve-provider.ts` resolves
 * the provider kind.
 *
 * Precedence (highest first):
 *
 *   1. **Caller override.** `SANDBOX_START`'s `input.daemonImpl`. The escape
 *      hatch both ways: opt one sandbox in, or pin one back to `ts` inside a
 *      flagged org.
 *   2. **Org flag** `sandbox_go_daemon`. Who gets Go *by default* — what puts a
 *      real user's sandboxes on Go without asking them to pass anything.
 *   3. **`ts`.** Deployed is not enabled.
 *
 * The third layer of control — `STUDIO_SANDBOX_GO_TEMPLATE_NAME`, the global
 * kill switch — is deliberately NOT read here. It is enforced in the runner
 * (`resolveClaimTemplate`), which is the only place that knows whether a Go
 * SandboxTemplate exists to point a claim at, and which persists the impl the
 * claim actually got. Duplicating the check here would let the two disagree.
 */

import type { OrgFlags } from "@decocms/shared/organization/schema";
import type { SandboxDaemonImpl } from "@decocms/sandbox/provider";

export function resolveDaemonImpl(args: {
  /** `SANDBOX_START`'s `daemonImpl` input, when the caller passed one. */
  explicit?: SandboxDaemonImpl;
  /** `organization_settings.flags`. Absent/unset reads as off. */
  flags?: OrgFlags | null;
}): SandboxDaemonImpl {
  if (args.explicit) return args.explicit;
  return args.flags?.sandbox_go_daemon ? "go" : "ts";
}
