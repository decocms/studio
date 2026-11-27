import { describe, expect, it } from "bun:test";
import { vtexRejection } from "./vtex-rejection";

describe("vtexRejection", () => {
  it("reads a 401 as wrong credentials", () => {
    expect(vtexRejection("VTEX 401 Unauthorized")).toEqual({
      kind: "credentials",
    });
  });

  it("names the OMS role when the orders read is forbidden", () => {
    expect(vtexRejection("VTEX 403 GET /api/oms/pvt/orders?page=1")).toEqual({
      kind: "permission",
      missing: ["oms"],
    });
  });

  it("names the hook role when the hook setup is forbidden", () => {
    expect(vtexRejection("VTEX 403 POST /api/orders/hook/config")).toEqual({
      kind: "permission",
      missing: ["hook"],
    });
  });

  it("lists every role when the 403 names no request", () => {
    expect(vtexRejection("VTEX 403 Forbidden")).toEqual({
      kind: "permission",
      missing: ["oms", "hook"],
    });
    expect(vtexRejection("VTEX 403 GET /api/unknown")).toEqual({
      kind: "permission",
      missing: ["oms", "hook"],
    });
  });

  it("ignores errors that aren't VTEX refusing the key", () => {
    expect(vtexRejection("")).toBeNull();
    expect(vtexRejection("VTEX 500 Internal")).toBeNull();
    expect(vtexRejection("VTEX 4031 nope")).toBeNull();
    expect(vtexRejection("fetch failed")).toBeNull();
  });
});
