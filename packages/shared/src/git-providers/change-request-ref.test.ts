import { describe, expect, test } from "bun:test";
import {
  changeRequestUrl,
  findChangeRequestUrl,
  parseChangeRequestUrl,
} from "./change-request-ref";

describe("changeRequestUrl", () => {
  test("each provider's own browser path", () => {
    expect(
      changeRequestUrl(
        { provider: "github", host: "github.com", path: "acme/site" },
        7,
      ),
    ).toBe("https://github.com/acme/site/pull/7");
    expect(
      changeRequestUrl(
        { provider: "gitlab", host: "gitlab.com", path: "group/sub/site" },
        7,
      ),
    ).toBe("https://gitlab.com/group/sub/site/-/merge_requests/7");
  });
});

describe("parseChangeRequestUrl", () => {
  test("a GitHub pull request", () => {
    expect(
      parseChangeRequestUrl("https://github.com/acme/site/pull/1006"),
    ).toEqual({
      repo: { provider: "github", host: "github.com", path: "acme/site" },
      number: 1006,
      url: "https://github.com/acme/site/pull/1006",
    });
  });

  /** The reason the number field is shared: GitLab's iid is per project too. */
  test("a GitLab merge request nested in subgroups", () => {
    expect(
      parseChangeRequestUrl(
        "https://gitlab.com/group/sub/store/-/merge_requests/42",
      ),
    ).toEqual({
      repo: {
        provider: "gitlab",
        host: "gitlab.com",
        path: "group/sub/store",
      },
      number: 42,
      url: "https://gitlab.com/group/sub/store/-/merge_requests/42",
    });
  });

  test("a self-hosted GitLab host", () => {
    const ref = parseChangeRequestUrl(
      "https://gitlab.acme.dev/team/store/-/merge_requests/3",
    );
    expect(ref?.repo).toEqual({
      provider: "gitlab",
      host: "gitlab.acme.dev",
      path: "team/store",
    });
    expect(ref?.number).toBe(3);
  });

  test("the API forms map back to the browser URL", () => {
    expect(
      parseChangeRequestUrl("https://api.github.com/repos/acme/site/pulls/7")
        ?.url,
    ).toBe("https://github.com/acme/site/pull/7");
    expect(
      parseChangeRequestUrl(
        "https://gitlab.com/api/v4/projects/group%2Fstore/merge_requests/9",
      )?.url,
    ).toBe("https://gitlab.com/group/store/-/merge_requests/9");
  });

  /** A numeric project id names no path, so it cannot identify a repository. */
  test("a GitLab API URL addressing a project by id is not enough", () => {
    expect(
      parseChangeRequestUrl(
        "https://gitlab.com/api/v4/projects/12345/merge_requests/9",
      ),
    ).toBeNull();
  });

  test("not a change request URL", () => {
    expect(parseChangeRequestUrl("https://github.com/acme/site")).toBeNull();
    expect(
      parseChangeRequestUrl("https://github.com/acme/site/issues/4"),
    ).toBeNull();
    expect(parseChangeRequestUrl("nothing here")).toBeNull();
    expect(parseChangeRequestUrl("")).toBeNull();
  });

  test("number zero is rejected", () => {
    expect(parseChangeRequestUrl("https://github.com/a/b/pull/0")).toBeNull();
    expect(
      parseChangeRequestUrl("https://gitlab.com/a/b/-/merge_requests/0"),
    ).toBeNull();
  });
});

describe("findChangeRequestUrl", () => {
  test("gh pr create stdout", () => {
    expect(
      findChangeRequestUrl(
        "https://github.com/deco-sites/example-store/pull/1006\n",
      ),
    ).toEqual({
      repo: {
        provider: "github",
        host: "github.com",
        path: "deco-sites/example-store",
      },
      number: 1006,
      url: "https://github.com/deco-sites/example-store/pull/1006",
    });
  });

  test("glab mr create stdout", () => {
    const out =
      "Creating merge request for feat/x into main in group/store\n\n" +
      "!12 feat: x\n https://gitlab.com/group/store/-/merge_requests/12\n";
    expect(findChangeRequestUrl(out)?.number).toBe(12);
    expect(findChangeRequestUrl(out)?.repo.provider).toBe("gitlab");
  });

  test("surrounding chatter and markdown wrapping", () => {
    expect(
      findChangeRequestUrl(
        "Creating pull request\nremote: ...\nhttps://github.com/acme/site/pull/42",
      )?.number,
    ).toBe(42);
    expect(
      findChangeRequestUrl(
        "Opened PR ([#3](https://github.com/acme/site/pull/3)).",
      )?.url,
    ).toBe("https://github.com/acme/site/pull/3");
  });

  test("a body carrying both the browser and the API URL prefers the browser one", () => {
    const body = JSON.stringify({
      url: "https://api.github.com/repos/acme/site/pulls/9",
      html_url: "https://github.com/acme/site/pull/9",
      number: 9,
    });
    expect(findChangeRequestUrl(body)?.url).toBe(
      "https://github.com/acme/site/pull/9",
    );
  });

  test("a response body carrying only the API URL", () => {
    expect(
      findChangeRequestUrl(
        '{"url":"https://api.github.com/repos/acme/site/pulls/7"}',
      )?.number,
    ).toBe(7);
    expect(
      findChangeRequestUrl(
        '{"web_url":"https://gitlab.com/group/store/-/merge_requests/7"}',
      )?.number,
    ).toBe(7);
  });

  test("owner and name with dots, dashes and underscores", () => {
    const ref = findChangeRequestUrl(
      "https://github.com/deco.cx/my_repo-2/pull/5",
    );
    expect(ref?.repo.path).toBe("deco.cx/my_repo-2");
    expect(ref?.number).toBe(5);
  });

  test("http, not https, still matches", () => {
    expect(findChangeRequestUrl("http://github.com/a/b/pull/1")?.number).toBe(
      1,
    );
  });

  test("finds the URL even when preceded by a large blob", () => {
    const noise = "x".repeat(50_000);
    expect(
      findChangeRequestUrl(`${noise}\nhttps://github.com/acme/site/pull/88`)
        ?.number,
    ).toBe(88);
  });

  /** The scan is capped, so a URL buried past it is deliberately not found. */
  test("a URL past the scan cap is not found", () => {
    const noise = "x".repeat(200_001);
    expect(
      findChangeRequestUrl(`${noise}https://github.com/acme/site/pull/88`),
    ).toBeNull();
  });

  test("nothing to find", () => {
    expect(findChangeRequestUrl("nothing here")).toBeNull();
    expect(findChangeRequestUrl("https://github.com/acme/site")).toBeNull();
  });
});
