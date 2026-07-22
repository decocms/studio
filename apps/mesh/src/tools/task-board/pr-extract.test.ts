import { describe, expect, test } from "bun:test";
import { extractPrFromText, extractPrFromValue } from "./pr-extract";

describe("extractPrFromText", () => {
  test("gh pr create stdout (bare html URL)", () => {
    const out = "https://github.com/deco-sites/farmrio/pull/1006\n";
    expect(extractPrFromText(out)).toEqual({
      url: "https://github.com/deco-sites/farmrio/pull/1006",
      number: 1006,
      owner: "deco-sites",
      repo: "farmrio",
    });
  });

  test("gh pr create with surrounding chatter", () => {
    const out =
      "Creating pull request for feat/x into main\nremote: ...\nhttps://github.com/acme/site/pull/42";
    expect(extractPrFromText(out)?.number).toBe(42);
    expect(extractPrFromText(out)?.repo).toBe("site");
  });

  test("api URL form (REST response with only api url)", () => {
    const body = '{"url":"https://api.github.com/repos/acme/site/pulls/7"}';
    expect(extractPrFromText(body)).toEqual({
      url: "https://github.com/acme/site/pull/7",
      number: 7,
      owner: "acme",
      repo: "site",
    });
  });

  test("curl POST response with both html_url and api url → html wins", () => {
    const body = JSON.stringify({
      url: "https://api.github.com/repos/acme/site/pulls/9",
      html_url: "https://github.com/acme/site/pull/9",
      number: 9,
    });
    const pr = extractPrFromText(body)!;
    expect(pr.url).toBe("https://github.com/acme/site/pull/9");
    expect(pr.number).toBe(9);
  });

  test("markdown-wrapped URL with trailing paren", () => {
    const md = "Opened PR ([#3](https://github.com/acme/site/pull/3)).";
    expect(extractPrFromText(md)).toEqual({
      url: "https://github.com/acme/site/pull/3",
      number: 3,
      owner: "acme",
      repo: "site",
    });
  });

  test("owner/repo with dots, dashes, underscores", () => {
    const pr = extractPrFromText(
      "https://github.com/deco.cx/my_repo-2/pull/5",
    )!;
    expect(pr.owner).toBe("deco.cx");
    expect(pr.repo).toBe("my_repo-2");
    expect(pr.number).toBe(5);
  });

  test("http (not https) still matches", () => {
    expect(extractPrFromText("http://github.com/a/b/pull/1")?.number).toBe(1);
  });

  test("no PR URL → null", () => {
    expect(extractPrFromText("nothing here")).toBeNull();
    expect(extractPrFromText("https://github.com/acme/site")).toBeNull();
    expect(
      extractPrFromText("https://github.com/acme/site/issues/4"),
    ).toBeNull();
  });

  test("pull/0 is rejected", () => {
    expect(extractPrFromText("https://github.com/a/b/pull/0")).toBeNull();
  });

  test("finds the URL even when preceded by a large blob", () => {
    const noise = "x".repeat(50_000);
    const out = `${noise}\nhttps://github.com/acme/site/pull/88`;
    expect(extractPrFromText(out)?.number).toBe(88);
  });
});

describe("extractPrFromValue", () => {
  test("MCP structuredContent minimal { id, url }", () => {
    const result = {
      structuredContent: {
        id: 123,
        url: "https://github.com/acme/site/pull/11",
      },
    };
    expect(extractPrFromValue(result)?.number).toBe(11);
  });

  test("MCP content text carrying JSON string", () => {
    const result = {
      content: [
        {
          type: "text",
          text: '{"number":12,"html_url":"https://github.com/acme/site/pull/12"}',
        },
      ],
    };
    expect(extractPrFromValue(result)?.number).toBe(12);
  });

  test("bash daemon output object { stdout, exitCode }", () => {
    const output = {
      status: "ok",
      exitCode: 0,
      stdout: "https://github.com/acme/site/pull/13\n",
      stderr: "",
    };
    expect(extractPrFromValue(output)?.number).toBe(13);
  });

  test("plain string passes through", () => {
    expect(
      extractPrFromValue("https://github.com/acme/site/pull/14")?.number,
    ).toBe(14);
  });

  test("null / undefined / no-match → null", () => {
    expect(extractPrFromValue(null)).toBeNull();
    expect(extractPrFromValue(undefined)).toBeNull();
    expect(extractPrFromValue({ foo: "bar" })).toBeNull();
  });
});
