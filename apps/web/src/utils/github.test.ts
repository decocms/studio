import { describe, expect, it } from "bun:test";
import {
  addExternalLinkAttributes,
  extractGitHubRepo,
  getGitHubAvatarUrl,
  removeGitHubAnchorIcons,
  sanitizeReadmeHtml,
} from "./github";

describe("github utilities", () => {
  describe("extractGitHubRepo", () => {
    it("should extract owner and repo from HTTPS URL", () => {
      const result = extractGitHubRepo("https://github.com/owner/repo");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("should extract owner and repo from HTTPS URL with .git suffix", () => {
      const result = extractGitHubRepo("https://github.com/owner/repo.git");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("should extract owner and repo from SSH URL", () => {
      const result = extractGitHubRepo("git@github.com:owner/repo.git");
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("should handle URL object with url property", () => {
      const result = extractGitHubRepo({
        url: "https://github.com/owner/repo",
      });
      expect(result).toEqual({ owner: "owner", repo: "repo" });
    });

    it("should return null for undefined input", () => {
      expect(extractGitHubRepo(undefined)).toBeNull();
    });

    it("should return null for non-GitHub URL", () => {
      expect(extractGitHubRepo("https://gitlab.com/owner/repo")).toBeNull();
    });

    it("should return null for empty object", () => {
      expect(extractGitHubRepo({})).toBeNull();
    });
  });

  describe("getGitHubAvatarUrl", () => {
    it("should return proxied avatar URL for valid GitHub repo", () => {
      const result = getGitHubAvatarUrl("https://github.com/owner/repo");
      expect(result).toContain("images.weserv.nl");
      // URL is encoded, so check for the encoded form
      expect(result).toContain(
        encodeURIComponent("https://github.com/owner.png"),
      );
    });

    it("should return null for invalid URL", () => {
      expect(getGitHubAvatarUrl("https://gitlab.com/owner/repo")).toBeNull();
    });
  });

  describe("removeGitHubAnchorIcons", () => {
    it("should remove anchor icons from headings", () => {
      const html =
        '<h2><a class="anchor" href="#section">🔗</a>Section Title</h2>';
      const result = removeGitHubAnchorIcons(html);
      expect(result).toBe("<h2>Section Title</h2>");
    });

    it("should remove anchor icons with multiple classes", () => {
      const html =
        '<h2><a class="heading-anchor anchor" href="#test">🔗</a>Test</h2>';
      const result = removeGitHubAnchorIcons(html);
      expect(result).toBe("<h2>Test</h2>");
    });

    it("should preserve non-anchor links", () => {
      const html = '<a href="https://example.com">Example</a>';
      const result = removeGitHubAnchorIcons(html);
      expect(result).toBe(html);
    });
  });

  describe("addExternalLinkAttributes", () => {
    it("should add target and rel attributes to links without them", () => {
      const html = '<a href="https://example.com">Example</a>';
      const result = addExternalLinkAttributes(html);
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });

    it("should replace existing target and add rel when target exists", () => {
      const html = '<a href="https://example.com" target="_self">Example</a>';
      const result = addExternalLinkAttributes(html);
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
      expect(result).not.toContain('target="_self"');
    });

    it("should add missing noopener noreferrer to existing rel", () => {
      const html =
        '<a href="https://example.com" target="_blank" rel="external">Example</a>';
      const result = addExternalLinkAttributes(html);
      expect(result).toContain("noopener");
      expect(result).toContain("noreferrer");
      expect(result).toContain("external");
    });

    it("should not duplicate noopener noreferrer if already present", () => {
      const html =
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">Example</a>';
      const result = addExternalLinkAttributes(html);
      const matches = result.match(/noopener/g);
      expect(matches?.length).toBe(1);
    });

    it("should handle links with only noopener", () => {
      const html =
        '<a href="https://example.com" target="_blank" rel="noopener">Example</a>';
      const result = addExternalLinkAttributes(html);
      expect(result).toContain("noopener");
      expect(result).toContain("noreferrer");
    });

    it("should handle links with only noreferrer", () => {
      const html =
        '<a href="https://example.com" target="_blank" rel="noreferrer">Example</a>';
      const result = addExternalLinkAttributes(html);
      expect(result).toContain("noopener");
      expect(result).toContain("noreferrer");
    });

    it("should handle multiple links in HTML", () => {
      const html = `
        <a href="https://one.com">One</a>
        <a href="https://two.com" target="_top">Two</a>
        <a href="https://three.com" rel="external">Three</a>
      `;
      const result = addExternalLinkAttributes(html);

      // All links should have target="_blank"
      expect((result.match(/target="_blank"/g) || []).length).toBe(3);
      // All links should have rel with noopener noreferrer
      expect((result.match(/noopener/g) || []).length).toBe(3);
      expect((result.match(/noreferrer/g) || []).length).toBe(3);
    });

    it("should preserve other attributes", () => {
      const html =
        '<a href="https://example.com" class="link" id="my-link">Example</a>';
      const result = addExternalLinkAttributes(html);
      expect(result).toContain('class="link"');
      expect(result).toContain('id="my-link"');
      expect(result).toContain('href="https://example.com"');
    });
  });

  describe("sanitizeReadmeHtml", () => {
    it("should remove anchor icons and add external link attributes", () => {
      const html = `
        <h2><a class="anchor" href="#section">🔗</a>Section</h2>
        <p>Check out <a href="https://example.com">this link</a></p>
      `;
      const result = sanitizeReadmeHtml(html);

      // Anchor icon should be removed
      expect(result).not.toContain('class="anchor"');
      // Link should have security attributes
      expect(result).toContain('target="_blank"');
      expect(result).toContain('rel="noopener noreferrer"');
    });
  });
});
