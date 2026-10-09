import { describe, expect, test } from "bun:test";
import { productionUrlFromDomain } from "@decocms/shared/deco-site-production-url";
import { resolveLocalSubmit } from "./local-url-submit";

const answers = async () => ({});
const nothingAnswers = async () => {
  throw new TypeError("Failed to fetch");
};

describe("the Local option's submit", () => {
  // Main saved every one of these as the tunnel URL.
  const v7Local = [
    "http://localhost:8000",
    "https://localhost:8000",
    "http://127.0.0.1:8000/",
    "localhost:3000",
    "8000",
  ];

  for (const input of v7Local) {
    test(`${input}: saved as a v7 tunnel when no deco serve answers`, async () => {
      expect(await resolveLocalSubmit(input, nothingAnswers)).toEqual({
        kind: "tunnel",
        url: productionUrlFromDomain(input),
      });
    });
  }

  test("a public tunnel URL is never probed", async () => {
    let probed = false;
    const outcome = await resolveLocalSubmit(
      " https://abc.ngrok.app ",
      async () => {
        probed = true;
      },
    );
    expect(probed).toBe(false);
    expect(outcome).toEqual({
      kind: "tunnel",
      url: productionUrlFromDomain("https://abc.ngrok.app"),
    });
  });

  test("a deco serve that answers is connected", async () => {
    expect(await resolveLocalSubmit("localhost:4545", answers)).toEqual({
      kind: "serve",
      connection: { endpoint: "http://localhost:4545/rpc" },
    });
  });

  test("a Site editor link whose deco serve is down reports it", async () => {
    const link = `http://localhost:4000/site-editor#endpoint=${encodeURIComponent("http://localhost:4545/rpc")}`;
    const outcome = await resolveLocalSubmit(link, nothingAnswers);
    expect(outcome.kind).toBe("serve-error");
  });
});
