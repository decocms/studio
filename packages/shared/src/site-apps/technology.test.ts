import { describe, expect, it } from "bun:test";
import {
  decocmsVersionRange,
  detectSiteTechnology,
  siteTechnologyFromFramework,
  siteTechnologyFromPackageManager,
} from "./technology";

describe("siteTechnologyFromPackageManager", () => {
  it("maps deno to deno and every node manager to tanstack", () => {
    expect(siteTechnologyFromPackageManager("deno")).toBe("deno");
    for (const pm of ["bun", "npm", "pnpm", "yarn"]) {
      expect(siteTechnologyFromPackageManager(pm)).toBe("tanstack");
    }
  });

  it("is null when unset or unknown, rather than guessing a format", () => {
    expect(siteTechnologyFromPackageManager(null)).toBeNull();
    expect(siteTechnologyFromPackageManager(undefined)).toBeNull();
    expect(siteTechnologyFromPackageManager("cargo")).toBeNull();
  });
});

describe("detectSiteTechnology", () => {
  it("prefers deno.json — a repo carrying both is a Deno site with tooling", () => {
    expect(detectSiteTechnology({ denoJson: "{}", packageJson: "{}" })).toEqual(
      { technology: "deno", decocmsVersion: null },
    );
  });

  it("reads the @decocms range off a tanstack package.json", () => {
    expect(
      detectSiteTechnology({
        denoJson: null,
        packageJson: '{"dependencies":{"@decocms/blocks":"^7.77.1"}}',
      }),
    ).toEqual({ technology: "tanstack", decocmsVersion: "^7.77.1" });
  });

  it("reports a node repo with no @decocms dependency, so the caller can refuse", () => {
    expect(
      detectSiteTechnology({
        denoJson: null,
        packageJson: '{"dependencies":{"react":"^19.0.0"}}',
      }),
    ).toEqual({ technology: "tanstack", decocmsVersion: null });
  });

  it("is null when neither manifest is present", () => {
    expect(
      detectSiteTechnology({ denoJson: null, packageJson: null }),
    ).toBeNull();
  });
});

describe("decocmsVersionRange", () => {
  it("prefers @decocms/blocks over any other @decocms package", () => {
    expect(
      decocmsVersionRange(
        '{"dependencies":{"@decocms/apps-vtex":"7.70.0","@decocms/blocks":"^7.77.1"}}',
      ),
    ).toBe("^7.77.1");
  });

  it("falls back to the first @decocms package by name, including devDependencies", () => {
    expect(
      decocmsVersionRange(
        '{"devDependencies":{"@decocms/tanstack":"^7.77.1"},"dependencies":{"@decocms/apps-wake":"7.70.0"}}',
      ),
    ).toBe("^7.77.1");
    expect(
      decocmsVersionRange('{"dependencies":{"@decocms/apps-wake":"7.70.0"}}'),
    ).toBe("7.70.0");
  });

  it("is null for unparseable or @decocms-free manifests", () => {
    expect(decocmsVersionRange("not json")).toBeNull();
    expect(decocmsVersionRange('{"dependencies":{"react":"^19"}}')).toBeNull();
  });
});

describe("siteTechnologyFromFramework", () => {
  it("maps the frameworks that report one", () => {
    expect(siteTechnologyFromFramework("tanstack-start")).toBe("tanstack");
  });

  it("reads an absent framework as Deno, which predates the field", () => {
    // Confirmed on live Fresh sites: `/live/_meta` carries no `framework`.
    expect(siteTechnologyFromFramework(undefined)).toBe("deno");
    expect(siteTechnologyFromFramework(null)).toBe("deno");
    expect(siteTechnologyFromFramework("")).toBe("deno");
  });

  it("refuses to guess a framework it does not know", () => {
    expect(siteTechnologyFromFramework("nextjs")).toBeNull();
    expect(siteTechnologyFromFramework("eitri")).toBeNull();
  });
});
