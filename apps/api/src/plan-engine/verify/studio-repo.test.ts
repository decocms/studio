import { describe, expect, test } from "bun:test";
import { parseRepoUrl, providerOfHost } from "./studio-repo.ts";

describe("repository identity helpers", () => {
  test("provider by host, GitHub by default", () => {
    expect(providerOfHost("github.com")).toBe("github");
    expect(providerOfHost("gitlab.com")).toBe("gitlab");
    expect(providerOfHost("gitlab.empresa.example")).toBe("gitlab");
    expect(providerOfHost("bitbucket.org")).toBe("bitbucket");
    expect(providerOfHost("git.empresa.example")).toBe("github");
  });

  test("parseRepoUrl", () => {
    expect(parseRepoUrl("https://github.com/acme/loja.git")).toEqual({
      host: "github.com",
      path: "acme/loja",
    });
    expect(parseRepoUrl("https://gitlab.com/grupo/sub/projeto/")).toEqual({
      host: "gitlab.com",
      path: "grupo/sub/projeto",
    });
    expect(parseRepoUrl("https://github.com/so-owner")).toBeNull();
    expect(parseRepoUrl("não é url")).toBeNull();
  });
});
