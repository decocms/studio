import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { getSettings, setGlobalSettings } from "../settings";
import {
  AnalyticsRegistrationError,
  registerAnalyticsSite,
  siteDomains,
  typedHost,
} from "./registration";

const original = getSettings();
beforeAll(() =>
  setGlobalSettings({
    ...original,
    controlplaneRestUrl: "https://cp.test/api/v1",
    controlplaneServiceToken: "test-token",
  }),
);
afterAll(() => setGlobalSettings(original));

test("siteDomains covers the apex and www whichever one is given", () => {
  expect(siteDomains("loja.example.com")).toEqual([
    "loja.example.com",
    "www.loja.example.com",
  ]);
  expect(siteDomains("WWW.Loja.example.com")).toEqual([
    "loja.example.com",
    "www.loja.example.com",
  ]);
});

test("typedHost reads a typed domain, with or without a scheme or path", () => {
  expect(typedHost("www.Loja.com.br")).toBe("www.loja.com.br");
  expect(typedHost(" https://loja.com/produtos?x=1 ")).toBe("loja.com");
  expect(typedHost("loja")).toBeNull();
  expect(typedHost("not a domain")).toBeNull();
  expect(typedHost("ftp://loja.com")).toBeNull();
  expect(typedHost("")).toBeNull();
  expect(typedHost(undefined)).toBeNull();
});

test("a control-plane refusal carries its code and reads by its message", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: "on_cdn", message: "the collector answers on this host" },
      { status: 422 },
    ),
  );
  try {
    const err = await registerAnalyticsSite("loja", {
      key: true,
      domains: ["loja.example.com"],
      modules: ["core"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsRegistrationError);
    expect((err as AnalyticsRegistrationError).code).toBe("on_cdn");
    expect((err as Error).message).toBe("the collector answers on this host");
  } finally {
    fetchSpy.mockRestore();
  }
});
