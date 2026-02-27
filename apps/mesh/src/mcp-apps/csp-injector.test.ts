import { describe, expect, it } from "bun:test";
import { DEFAULT_CSP, injectCSP } from "./csp-injector.ts";

describe("DEFAULT_CSP", () => {
  it("blocks external connections", () => {
    expect(DEFAULT_CSP).toContain("connect-src 'none'");
  });
  it("blocks default sources", () => {
    expect(DEFAULT_CSP).toContain("default-src 'none'");
  });
  it("allows inline scripts", () => {
    expect(DEFAULT_CSP).toContain("script-src 'unsafe-inline'");
  });
  it("allows inline styles", () => {
    expect(DEFAULT_CSP).toContain("style-src 'unsafe-inline'");
  });
  it("prevents framing", () => {
    expect(DEFAULT_CSP).toContain("frame-ancestors 'none'");
  });
});

describe("injectCSP", () => {
  it("inserts meta tag into existing <head>", () => {
    const html = "<html><head><title>Test</title></head><body></body></html>";
    const result = injectCSP(html);
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(result).toContain(DEFAULT_CSP);
    expect(result.indexOf("<meta")).toBeGreaterThan(html.indexOf("<head>"));
  });

  it("creates <head> if missing", () => {
    const html = "<html><body>Hello</body></html>";
    const result = injectCSP(html);
    expect(result).toContain("<head>");
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  it("works with <!DOCTYPE html>", () => {
    const html = "<!DOCTYPE html><html><body></body></html>";
    const result = injectCSP(html);
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(result.indexOf("<!DOCTYPE")).toBe(0);
  });

  it("handles uppercase <HEAD>", () => {
    const html = "<HTML><HEAD></HEAD><BODY></BODY></HTML>";
    const result = injectCSP(html);
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  it("uses custom CSP when provided", () => {
    const customCSP = "default-src 'self'";
    const html = "<html><head></head><body></body></html>";
    const result = injectCSP(html, { csp: customCSP });
    expect(result).toContain(customCSP);
    expect(result).not.toContain(DEFAULT_CSP);
  });

  it("sets connect-src * when allowExternalConnections and no hosts", () => {
    const html = "<head></head>";
    const result = injectCSP(html, { allowExternalConnections: true });
    expect(result).toContain("connect-src *");
  });

  it("uses allowedHosts in connect-src", () => {
    const html = "<head></head>";
    const result = injectCSP(html, {
      allowExternalConnections: true,
      allowedHosts: ["api.example.com", "cdn.example.com"],
    });
    expect(result).toContain("connect-src api.example.com cdn.example.com");
  });

  it("treats empty allowedHosts as wildcard", () => {
    const html = "<head></head>";
    const result = injectCSP(html, {
      allowExternalConnections: true,
      allowedHosts: [],
    });
    expect(result).toContain("connect-src *");
  });

  it("keeps connect-src none when allowExternalConnections is false", () => {
    const html = "<head></head>";
    const result = injectCSP(html, { allowExternalConnections: false });
    expect(result).toContain("connect-src 'none'");
  });

  it("prepends head when no html structure exists", () => {
    const html = "<div>Just content</div>";
    const result = injectCSP(html);
    expect(result).toContain("<head>");
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
  });
});
