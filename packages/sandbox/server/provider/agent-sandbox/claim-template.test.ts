import { describe, expect, it } from "bun:test";
import type { SandboxResource } from "./client";
import { readClaimDaemonImpl, resolveClaimTemplate } from "./runner";

const TS = "studio-sandbox-stg";
const GO = "studio-sandbox-stg-go";

const claimWithLabels = (labels: Record<string, string>): SandboxResource =>
  ({ metadata: { labels } }) as unknown as SandboxResource;

describe("resolveClaimTemplate", () => {
  it("defaults to the ts template", () => {
    expect(resolveClaimTemplate(undefined, TS, GO)).toEqual({
      impl: "ts",
      templateName: TS,
    });
    expect(resolveClaimTemplate("ts", TS, GO)).toEqual({
      impl: "ts",
      templateName: TS,
    });
  });

  it("routes a go request at the go template", () => {
    expect(resolveClaimTemplate("go", TS, GO)).toEqual({
      impl: "go",
      templateName: GO,
    });
  });

  it("collapses go back to ts when no go template is configured", () => {
    // The global kill switch. Pointing a claim at a template that does not
    // exist fails provisioning outright, so an unconfigured deploy must ignore
    // the request — and must report `ts`, since that is what the pod will run.
    expect(resolveClaimTemplate("go", TS, null)).toEqual({
      impl: "ts",
      templateName: TS,
    });
  });
});

describe("readClaimDaemonImpl", () => {
  const KEY = "studio.decocms.com/daemon-impl";

  it("recovers the impl a claim was provisioned with", () => {
    expect(readClaimDaemonImpl(claimWithLabels({ [KEY]: "go" }))).toBe("go");
    expect(readClaimDaemonImpl(claimWithLabels({ [KEY]: "ts" }))).toBe("ts");
  });

  it("reports null rather than guessing ts when the label is absent", () => {
    // Claims provisioned before the rollout gate existed. Defaulting to "ts"
    // here would be indistinguishable from a real TS sandbox on the dashboard.
    expect(readClaimDaemonImpl(claimWithLabels({}))).toBeNull();
    expect(readClaimDaemonImpl({} as SandboxResource)).toBeNull();
  });

  it("rejects an unrecognized label value", () => {
    // The label is writable by anything with claim access; an unbounded value
    // here would land straight in a metric attribute as new cardinality.
    expect(readClaimDaemonImpl(claimWithLabels({ [KEY]: "rust" }))).toBeNull();
    expect(readClaimDaemonImpl(claimWithLabels({ [KEY]: "" }))).toBeNull();
  });
});
