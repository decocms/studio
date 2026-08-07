/**
 * GitHub utility functions
 */

/**
 * Extract GitHub repository owner and name from a repository URL
 * Supports formats like:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
export function extractGitHubRepo(repositoryUrl?: string | { url?: string }): {
  owner: string;
  repo: string;
} | null {
  if (!repositoryUrl) return null;

  const url =
    typeof repositoryUrl === "string" ? repositoryUrl : repositoryUrl.url;
  if (!url) return null;

  // Handle GitHub URLs
  const githubMatch = url.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (githubMatch) {
    return {
      owner: githubMatch[1] || "",
      repo: githubMatch[2] || "",
    };
  }

  return null;
}

/**
 * Get GitHub avatar URL for a repository
 * Uses a proxy service to bypass CORS issues with GitHub's avatar URLs
 */
export function getGitHubAvatarUrl(
  repositoryUrl?: string | { url?: string },
): string | null {
  const repo = extractGitHubRepo(repositoryUrl);
  if (!repo) return null;

  // GitHub's direct avatar URL has CORS issues, so we use a proxy
  // Using images.weserv.nl as a free image proxy service
  const githubAvatarUrl = `https://github.com/${repo.owner}.png`;
  const avatarUrl = `https://images.weserv.nl/?url=${encodeURIComponent(githubAvatarUrl)}&output=webp`;
  return avatarUrl;
}

/**
 * Remove GitHub's anchor link icons from heading elements
 * These are the chain-link icons that appear next to headings
 */
export function removeGitHubAnchorIcons(html: string): string {
  return html.replace(/<a[^>]*class="[^"]*anchor[^"]*"[^>]*>.*?<\/a>/gi, "");
}

/**
 * Add external link attributes to all links in the HTML
 * Ensures links open in new tabs with proper security attributes
 */
export function addExternalLinkAttributes(html: string): string {
  return html.replace(/<a\s+([^>]*href="[^"]*"[^>]*)>/gi, (match, attrs) => {
    let result = match;
    let updatedAttrs = attrs;

    // Handle target attribute
    if (updatedAttrs.includes("target=")) {
      result = result.replace(/target="[^"]*"/gi, 'target="_blank"');
      updatedAttrs = updatedAttrs.replace(
        /target="[^"]*"/gi,
        'target="_blank"',
      );
    } else {
      updatedAttrs = `${updatedAttrs} target="_blank"`;
      result = `<a ${updatedAttrs}>`;
    }

    // Handle rel attribute - always ensure noopener noreferrer is present
    if (!updatedAttrs.includes("rel=")) {
      result = result.replace(/>$/, ' rel="noopener noreferrer">');
    } else if (
      !updatedAttrs.includes("noopener") ||
      !updatedAttrs.includes("noreferrer")
    ) {
      // Append missing values to existing rel attribute
      result = result.replace(/rel="([^"]*)"/gi, (_relMatch, relValue) => {
        const values = new Set(relValue.split(/\s+/).filter(Boolean));
        values.add("noopener");
        values.add("noreferrer");
        return `rel="${Array.from(values).join(" ")}"`;
      });
    }

    return result;
  });
}

/**
 * Sanitize README HTML by removing unwanted elements and adding security attributes
 */
export function sanitizeReadmeHtml(html: string): string {
  let result = removeGitHubAnchorIcons(html);
  result = addExternalLinkAttributes(result);
  return result;
}

/**
 * Fetch README HTML from GitHub API
 */
export async function fetchGitHubReadme(
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      {
        headers: {
          Accept: "application/vnd.github.v3.html",
        },
      },
    );
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to fetch README: ${response.statusText}`);
    }
    const html = await response.text();
    return sanitizeReadmeHtml(html);
  } catch (error) {
    console.error("Error fetching README:", error);
    return null;
  }
}
