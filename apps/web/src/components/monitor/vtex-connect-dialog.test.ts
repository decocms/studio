import { describe, expect, it } from "bun:test";
import { missingVtexResources } from "./vtex-connect-dialog";

describe("missingVtexResources", () => {
  it("names the resources a VTEX 403 lists", () => {
    const message =
      'VTEX 403: {"title":"Forbidden","status":403,"reason":"User does not have access to the resources [FeedHookV3Admin, OMSViewer]"}';
    expect(missingVtexResources(message)).toBe("FeedHookV3Admin, OMSViewer");
  });

  it("leaves other refusals to the key check", () => {
    expect(missingVtexResources('VTEX 401: {"error":"Unauthorized"}')).toBe(
      undefined,
    );
    expect(missingVtexResources('VTEX 403: {"title":"Forbidden"}')).toBe(
      undefined,
    );
  });
});
