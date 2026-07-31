import { describe, expect, it } from "bun:test";
import { resolveClaimTemplate } from "./runner";

const TS = "studio-sandbox-stg";
const GO = "studio-sandbox-stg-go";

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
