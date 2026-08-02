import { describe, expect, test } from "bun:test";
import {
  detectSecret,
  heuristicSecretName,
  maskSecret,
  secretRef,
} from "./secret-detect";

describe("detectSecret", () => {
  test("finds an OpenAI key and names it", () => {
    const d = detectSecret("here is sk-abcdEFGH1234567890wxyzABCD ok");
    expect(d).not.toBeNull();
    expect(d!.value).toBe("sk-abcdEFGH1234567890wxyzABCD");
    expect(d!.suggestedName).toBe("openai_api_key");
  });

  test("anthropic beats the generic openai sk- pattern", () => {
    const d = detectSecret("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(d!.suggestedName).toBe("anthropic_api_key");
  });

  test("finds a GitHub PAT", () => {
    const d = detectSecret("token github_pat_11ABCDE0000aaaaAAAA1111bbbb");
    expect(d!.suggestedName).toBe("github_token");
  });

  test("labeled assignment captures just the value", () => {
    const d = detectSecret('API_KEY="abcdef0123456789ABCDEF"');
    expect(d).not.toBeNull();
    expect(d!.value).toBe("abcdef0123456789ABCDEF");
  });

  test("returns null for ordinary prose", () => {
    expect(detectSecret("just a normal sentence with words")).toBeNull();
  });

  test("reports correct offsets", () => {
    const text = "use sk-abcdEFGH1234567890wxyzABCD now";
    const d = detectSecret(text)!;
    expect(text.slice(d.start, d.end)).toBe(d.value);
  });
});

describe("helpers", () => {
  test("heuristicSecretName by prefix", () => {
    expect(heuristicSecretName("ghp_xxx")).toBe("github_token");
    expect(heuristicSecretName("AKIAxxxx")).toBe("aws_access_key_id");
    expect(heuristicSecretName("random")).toBe("api_token");
  });

  test("secretRef + maskSecret", () => {
    expect(secretRef("openai_api_key")).toBe("{{secret:openai_api_key}}");
    expect(maskSecret("sk-abcdEFGH1234567890")).toMatch(/^sk-a•+$/);
  });
});
