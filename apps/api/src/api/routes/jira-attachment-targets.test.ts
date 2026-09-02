import { describe, expect, it } from "bun:test";
import {
  attachmentContentUrl,
  isAtlassianHost,
  isAtlassianUrl,
  parseAttachmentId,
  resolveCloudId,
  safeContentDisposition,
} from "./jira-attachment-targets";

describe("parseAttachmentId", () => {
  it("accepts a numeric id", () => {
    expect(parseAttachmentId("41356")).toBe("41356");
  });

  it("rejects everything that could steer the upstream path", () => {
    for (const bad of [
      undefined,
      "",
      "../../secret",
      "41356/../../x",
      "41356?x=1",
      "https://evil.test/x",
      "41356 ",
      "abc",
      "-1",
      "4e3",
      "1".repeat(21),
    ]) {
      expect(parseAttachmentId(bad)).toBeNull();
    }
  });
});

describe("isAtlassianHost", () => {
  it("accepts Atlassian hosts and their subdomains", () => {
    for (const host of [
      "atlassian.com",
      "atlassian.net",
      "api.atlassian.com",
      "api.media.atlassian.com",
      "osklenbr.atlassian.net",
      "API.Atlassian.COM",
    ]) {
      expect(isAtlassianHost(host)).toBe(true);
    }
  });

  it("rejects look-alikes that a suffix match without a dot boundary would pass", () => {
    for (const host of [
      "atlassian.com.evil.test",
      "notatlassian.com",
      "evilatlassian.net",
      "atlassian.co",
      "",
    ]) {
      expect(isAtlassianHost(host)).toBe(false);
    }
  });
});

describe("isAtlassianUrl", () => {
  it("is false for a null, empty, or unparseable url", () => {
    expect(isAtlassianUrl(null)).toBe(false);
    expect(isAtlassianUrl(undefined)).toBe(false);
    expect(isAtlassianUrl("")).toBe(false);
    expect(isAtlassianUrl("not a url")).toBe(false);
  });

  it("is true for the MCP connection url and a media redirect", () => {
    expect(isAtlassianUrl("https://mcp.atlassian.com/v1/mcp/authv2")).toBe(
      true,
    );
    expect(
      isAtlassianUrl("https://api.media.atlassian.com/file/abc/binary?token=x"),
    ).toBe(true);
  });

  it("is false for a non-Atlassian connection — the credential-leak guard", () => {
    expect(isAtlassianUrl("https://mcp.notion.com/mcp")).toBe(false);
    expect(isAtlassianUrl("https://evil.test/?x=atlassian.com")).toBe(false);
  });

  it("is false for a non-http scheme", () => {
    expect(isAtlassianUrl("file:///etc/passwd")).toBe(false);
    expect(isAtlassianUrl("ftp://api.atlassian.com/x")).toBe(false);
  });
});

describe("resolveCloudId", () => {
  const one = [{ id: "cd4e853c-d029-41c2-907e-bef24605b986" }];
  const two = [...one, { id: "11111111-2222-3333-4444-555555555555" }];

  it("uses the only site when none was requested", () => {
    expect(resolveCloudId(null, one)).toEqual({
      ok: true,
      cloudId: "cd4e853c-d029-41c2-907e-bef24605b986",
    });
  });

  it("accepts a requested site the token can see", () => {
    expect(resolveCloudId(two[1]!.id, two)).toEqual({
      ok: true,
      cloudId: two[1]!.id,
    });
  });

  it("refuses a site the token cannot see", () => {
    const out = resolveCloudId("99999999-0000-0000-0000-000000000000", two);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });

  it("refuses to guess between several sites", () => {
    const out = resolveCloudId(null, two);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(400);
      // The caller has to be able to act on the error.
      expect(out.error).toContain(two[0]!.id);
      expect(out.error).toContain(two[1]!.id);
    }
  });

  it("refuses when the token reaches nothing", () => {
    const out = resolveCloudId(null, []);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(403);
  });

  it("ignores blank ids rather than selecting one", () => {
    const out = resolveCloudId(null, [{ id: "" }]);
    expect(out.ok).toBe(false);
  });
});

describe("attachmentContentUrl", () => {
  it("builds the cloud REST url", () => {
    expect(attachmentContentUrl("cloud-1", "41356")).toBe(
      "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/attachment/content/41356",
    );
  });

  it("encodes the cloudId so a hostile value cannot open a new path segment", () => {
    expect(attachmentContentUrl("a/../b", "1")).toBe(
      "https://api.atlassian.com/ex/jira/a%2F..%2Fb/rest/api/3/attachment/content/1",
    );
  });
});

describe("safeContentDisposition", () => {
  it("keeps a plain upstream filename", () => {
    expect(
      safeContentDisposition('attachment; filename="antes-desktop.png"', "9"),
    ).toBe('attachment; filename="antes-desktop.png"');
  });

  it("falls back to the attachment id when there is no filename", () => {
    expect(safeContentDisposition(null, "41356")).toBe(
      'attachment; filename="attachment-41356"',
    );
  });

  it("drops a filename carrying a path, a quote, or a newline", () => {
    for (const hostile of [
      'attachment; filename="../../etc/passwd"',
      'attachment; filename="a\\"; rm -rf /"',
      'attachment; filename="a\nb.png"',
    ]) {
      expect(safeContentDisposition(hostile, "7")).toBe(
        'attachment; filename="attachment-7"',
      );
    }
  });
});
