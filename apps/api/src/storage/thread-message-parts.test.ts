import { describe, it, expect } from "bun:test";
import { serializePayload } from "./thread-message-parts";

describe("serializePayload", () => {
  it("passes small payloads through as-is", () => {
    const payload = { type: "text", text: "hello" };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  it("stores large-but-legitimate payloads in full (no data loss)", () => {
    const big = { type: "tool-result", output: "x".repeat(2_000_000) };
    expect(serializePayload(big)).toBe(JSON.stringify(big));
  });

  it("circuit-breaks a single oversized string without stringifying it", () => {
    const pathological = {
      type: "tool-result",
      output: "x".repeat(60_000_000),
    };
    const out = JSON.parse(serializePayload(pathological));
    expect(out.truncated).toBe(true);
  });

  it("circuit-breaks many small strings that sum past the cap", () => {
    const chunks = Array.from({ length: 1000 }, () => "x".repeat(60_000));
    const pathological = { type: "tool-result", output: chunks }; // 60MB total
    const out = JSON.parse(serializePayload(pathological));
    expect(out.truncated).toBe(true);
  });

  // Postgres jsonb rejects U+0000 with SQLSTATE 22P05, which would strand the
  // whole run in_progress. A tool result that inlined raw binary (e.g. a PNG)
  // is the real-world trigger.
  it("strips NUL bytes so the payload is storable in jsonb", () => {
    const payload = { type: "text", text: "before\u0000after" };
    const serialized = serializePayload(payload);
    expect(serialized).not.toContain("\\u0000");
    expect(JSON.parse(serialized).text).toBe("beforeafter");
  });

  it("strips NUL bytes nested deep in the payload tree", () => {
    const payload = { a: { b: [{ c: "x\u0000y" }] } };
    const out = JSON.parse(serializePayload(payload));
    expect(out.a.b[0].c).toBe("xy");
  });

  // Postgres jsonb also rejects unpaired UTF-16 surrogates as an unsupported
  // Unicode escape sequence; replace them with the Unicode replacement char.
  it("replaces lone surrogates with U+FFFD", () => {
    const payload = { text: `lead\uD800 trail\uDC00 pair\u{1F600}` };
    const out = JSON.parse(serializePayload(payload));
    expect(out.text).toBe("lead\uFFFD trail\uFFFD pair\u{1F600}");
  });

  it("leaves a well-formed emoji (surrogate pair) intact", () => {
    const payload = { text: "hi \u{1F600}" };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  // Every token below is synthetic. The real leak was a run doing nothing more
  // than `git remote -v`, whose output landed in a tool-result payload.
  it("redacts the credential in a clone URL's userinfo", () => {
    const payload = {
      type: "tool-result",
      output:
        "origin\thttps://x-access-token:ghs_0000AAAAbbbbCCCCddddEEEEffffGGGG@github.com/acme/site.git (fetch)",
    };
    const out = JSON.parse(serializePayload(payload));
    expect(out.output).not.toContain("ghs_");
    expect(out.output).toBe(
      "origin\thttps://***@github.com/acme/site.git (fetch)",
    );
  });

  it("redacts a bare GitHub token with no URL around it", () => {
    const payload = {
      env: "GITHUB_TOKEN=github_pat_0000AAAAbbbbCCCCddddEEEEffffGGGGhhhh",
    };
    const out = JSON.parse(serializePayload(payload));
    expect(out.env).toBe("GITHUB_TOKEN=github_pat_***");
  });

  it("redacts credentials nested deep in the payload tree", () => {
    const payload = {
      a: {
        b: [
          {
            cmd: "git push https://u:ghp_0000AAAAbbbbCCCCddddEEEEffffGGGG@github.com/acme/site",
          },
        ],
      },
    };
    const out = JSON.parse(serializePayload(payload));
    expect(out.a.b[0].cmd).not.toContain("ghp_0000");
  });

  it("leaves a credential-less URL alone, even one containing an @", () => {
    const payload = {
      text: "see https://github.com/acme/site and mail a@b.com",
    };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  it("leaves an ordinary identifier that merely starts like a token alone", () => {
    const payload = { text: "ghs_count and gho_total are counters" };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  it("leaves an ssh remote alone — `git@host` is not a credential", () => {
    const payload = { text: "origin\tgit@github.com:acme/site.git (push)" };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  // The credential regexes must stay LINEAR. An unbounded scheme or userinfo
  // quantifier backtracks at every offset of a scheme-shaped string, and the
  // 2MB payload above is enough to hang the projector for minutes. This asserts
  // the property directly so a future "simplification" of the bounds is caught
  // here rather than in prod.
  it("redacts in linear time on a large scheme-shaped payload", () => {
    const payload = { output: "abcdef".repeat(400_000) }; // 2.4MB, all scheme chars
    const started = Date.now();
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it("drops the bytes of an inline base64 image block", () => {
    const payload = {
      type: "tool-Read",
      state: "output-available",
      output: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo".repeat(5000),
          },
        },
      ],
    };
    const out = JSON.parse(serializePayload(payload));
    expect(out.output[0]).toEqual({ type: "text", text: "[image omitted]" });
  });

  it("keeps an image block that only references storage", () => {
    const payload = {
      output: [{ type: "image", url: "studio-storage://org/thread/shot.png" }],
    };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  it("redacts a base64 data URL embedded in text", () => {
    const payload = {
      output: `<img src="data:image/png;base64,${"A".repeat(400)}">`,
    };
    const out = JSON.parse(serializePayload(payload));
    expect(out.output).toBe('<img src="[base64 data omitted]">');
  });
});
