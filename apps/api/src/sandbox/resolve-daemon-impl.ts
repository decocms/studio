/**
 * Single source of truth for "which sandbox daemon binary should this sandbox
 * run?" — the Go-daemon rollout gate. Mirrors how `resolve-provider.ts` resolves
 * the provider kind.
 *
 * Precedence (highest first):
 *
 *   1. **Caller override.** `SANDBOX_START`'s `input.daemonImpl`. The escape
 *      hatch both ways: pin one sandbox back to `ts`, or force `go` inside an
 *      org that opted out.
 *   2. **Org flag** `sandbox_go_daemon`, when explicitly `false`. The per-org
 *      opt-out — the flag no longer opts *in*, because Go is the default.
 *   3. **`go`.** Everyone, unless something above says otherwise.
 *
 * The third layer of control — `STUDIO_SANDBOX_GO_TEMPLATE_NAME`, the global
 * kill switch — is deliberately NOT read here. It is enforced in the runner
 * (`resolveClaimTemplate`), which is the only place that knows whether a Go
 * SandboxTemplate exists to point a claim at, and which persists the impl the
 * claim actually got. Duplicating the check here would let the two disagree.
 * That kill switch is what makes a `go` default safe to ship: unsetting the env
 * var collapses the whole fleet back to `ts` on the next claim, no code deploy.
 */

import type { OrgFlags } from "@decocms/shared/organization/schema";
import type { SandboxDaemonImpl } from "@decocms/sandbox/provider";

export function resolveDaemonImpl(args: {
  /** `SANDBOX_START`'s `daemonImpl` input, when the caller passed one. */
  explicit?: SandboxDaemonImpl;
  /**
   * `organization_settings.flags`. Only an explicit `false` opts out — absent
   * and unset both read as "go", which is what makes this the default.
   */
  flags?: OrgFlags | null;
}): SandboxDaemonImpl {
  if (args.explicit) return args.explicit;
  return args.flags?.sandbox_go_daemon === false ? "ts" : "go";
}
