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
  it("does not include frame-ancestors (invalid in meta tags, enforced by srcdoc sandbox)", () => {
    expect(DEFAULT_CSP).not.toContain("frame-ancestors");
  });
  it("does not include self in font-src", () => {
    expect(DEFAULT_CSP).not.toContain("font-src 'self'");
    expect(DEFAULT_CSP).toContain("font-src data:");
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

  it("falls back to DEFAULT_CSP when resourceCsp is empty", () => {
    const html = "<head></head>";
    const result = injectCSP(html, { resourceCsp: {} });
    expect(result).toContain(DEFAULT_CSP);
  });

  it("prepends head when no html structure exists", () => {
    const html = "<div>Just content</div>";
    const result = injectCSP(html);
    expect(result).toContain("<head>");
    expect(result).toContain('<meta http-equiv="Content-Security-Policy"');
  });
});

describe("injectCSP with resourceCsp", () => {
  const html = "<head></head>";

  it("adds resourceDomains to script-src, style-src, img-src, font-src", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        resourceDomains: ["https://cdn.example.com"],
      },
    });
    expect(result).toContain(
      "script-src 'unsafe-inline' https://cdn.example.com",
    );
    expect(result).toContain(
      "style-src 'unsafe-inline' https://cdn.example.com",
    );
    expect(result).toContain("img-src * data: blob: https://cdn.example.com");
    expect(result).toContain("font-src data: https://cdn.example.com");
  });

  it("adds connectDomains to connect-src", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        connectDomains: ["https://api.example.com"],
      },
    });
    expect(result).toContain("connect-src https://api.example.com");
    expect(result).not.toContain("connect-src 'none'");
  });

  it("supports multiple connect domains", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        connectDomains: [
          "https://api.example.com",
          "https://ws.example.com:8080",
        ],
      },
    });
    expect(result).toContain(
      "connect-src https://api.example.com https://ws.example.com:8080",
    );
  });

  it("adds frameDomains to frame-src", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        frameDomains: ["https://embed.example.com"],
      },
    });
    expect(result).toContain("frame-src https://embed.example.com");
  });

  it("adds baseUriDomains to base-uri", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        baseUriDomains: ["https://base.example.com"],
      },
    });
    expect(result).toContain("base-uri https://base.example.com");
  });

  it("keeps connect-src none when only resourceDomains provided", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        resourceDomains: ["https://cdn.example.com"],
      },
    });
    expect(result).toContain("connect-src 'none'");
  });

  it("combines resourceDomains and connectDomains", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
      },
    });
    expect(result).toContain(
      "script-src 'unsafe-inline' https://cdn.example.com",
    );
    expect(result).toContain("connect-src https://api.example.com");
  });

  it("rejects domains without protocol", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        connectDomains: ["api.example.com", "https://valid.example.com"],
      },
    });
    expect(result).toContain("connect-src https://valid.example.com");
    expect(result).not.toContain("api.example.com");
  });

  it("rejects domains with paths", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        connectDomains: ["https://api.example.com/v1"],
      },
    });
    expect(result).toContain("connect-src 'none'");
  });

  it("rejects domains with semicolons (CSP injection attempt)", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        connectDomains: ["https://evil.com; script-src 'unsafe-eval'"],
      },
    });
    expect(result).toContain("connect-src 'none'");
    expect(result).not.toContain("unsafe-eval");
  });

  it("rejects wildcard domains", () => {
    const result = injectCSP(html, {
      resourceCsp: { connectDomains: ["*"] },
    });
    expect(result).toContain("connect-src 'none'");
  });

  it("never includes frame-ancestors (invalid in meta tags)", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://embed.example.com"],
      },
    });
    expect(result).not.toContain("frame-ancestors");
  });

  it("always keeps form-action none", () => {
    const result = injectCSP(html, {
      resourceCsp: {
        connectDomains: ["https://api.example.com"],
      },
    });
    expect(result).toContain("form-action 'none'");
  });
});
