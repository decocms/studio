import { describe, expect, it } from "bun:test";
import { ideDeepLink } from "./ide-deep-link";

describe("ideDeepLink", () => {
  it("builds a valid link for a Windows path with a drive letter", () => {
    const link = ideDeepLink(
      "vscode",
      "C:\\Users\\tibau\\deco\\sandboxes\\chi-sculptoris-38aa1db232fea119\\repo",
    );
    expect(link).toBe(
      "vscode://file/C:/Users/tibau/deco/sandboxes/chi-sculptoris-38aa1db232fea119/repo?windowId=_blank",
    );
    // The URL constructor must accept it (window.open rejects invalid URLs).
    expect(() => new URL(link)).not.toThrow();
  });

  it("builds a valid link for a POSIX path", () => {
    expect(ideDeepLink("cursor", "/home/me/repo")).toBe(
      "cursor://file/home/me/repo?windowId=_blank",
    );
  });

  it("escapes spaces and special characters", () => {
    const link = ideDeepLink("vscode", "C:\\My Projects\\repo");
    expect(link).toBe("vscode://file/C:/My%20Projects/repo?windowId=_blank");
    expect(() => new URL(link)).not.toThrow();
  });

  it("does not double the leading slash on POSIX paths", () => {
    expect(ideDeepLink("vscode", "/repo")).toBe(
      "vscode://file/repo?windowId=_blank",
    );
  });

  it("escapes `#` in a path so it does not become a URL fragment", () => {
    // Windows usernames may legally contain `#`; `encodeURI` would leave it,
    // truncating the path and dropping the `?windowId=_blank` query.
    const link = ideDeepLink("vscode", "C:\\Users\\John#Doe\\repo");
    expect(link).toBe("vscode://file/C:/Users/John%23Doe/repo?windowId=_blank");
    const url = new URL(link);
    expect(url.hash).toBe("");
    expect(url.search).toBe("?windowId=_blank");
  });

  it("escapes a literal `%` so it is not a malformed escape", () => {
    expect(ideDeepLink("cursor", "/home/me/50%off/repo")).toBe(
      "cursor://file/home/me/50%25off/repo?windowId=_blank",
    );
  });
});
