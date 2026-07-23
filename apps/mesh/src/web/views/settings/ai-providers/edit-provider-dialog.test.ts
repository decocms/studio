import { describe, expect, test } from "bun:test";
import { needsApiKeyForBaseUrlChange } from "./edit-provider-dialog";

describe("needsApiKeyForBaseUrlChange", () => {
  test("requires a fresh API key when the base URL changes without one", () => {
    expect(
      needsApiKeyForBaseUrlChange({
        isOpenAICompatible: true,
        baseUrl: "https://new.example.com/v1",
        currentBaseUrl: "https://old.example.com/v1",
        apiKey: undefined,
      }),
    ).toBe(true);
  });

  test("allows the base URL change when a fresh API key is provided", () => {
    expect(
      needsApiKeyForBaseUrlChange({
        isOpenAICompatible: true,
        baseUrl: "https://new.example.com/v1",
        currentBaseUrl: "https://old.example.com/v1",
        apiKey: "sk-new",
      }),
    ).toBe(false);
  });

  test("allows saving when the base URL is unchanged", () => {
    expect(
      needsApiKeyForBaseUrlChange({
        isOpenAICompatible: true,
        baseUrl: "https://old.example.com/v1",
        currentBaseUrl: "https://old.example.com/v1",
        apiKey: undefined,
      }),
    ).toBe(false);
  });

  test("does not apply to non openai-compatible providers", () => {
    expect(
      needsApiKeyForBaseUrlChange({
        isOpenAICompatible: false,
        baseUrl: "https://new.example.com/v1",
        currentBaseUrl: "https://old.example.com/v1",
        apiKey: undefined,
      }),
    ).toBe(false);
  });
});
