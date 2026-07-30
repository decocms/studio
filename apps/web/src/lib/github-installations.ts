/**
 * Fallback GitHub App slug for when GITHUB_LIST_USER_ORGS can't report one —
 * the slug is harvested from the user's installations, so a user with zero
 * installations (the exact case that needs the install link) never gets it.
 */
const DEFAULT_GITHUB_APP_SLUG = "deco-cms";

export function githubAppInstallUrl(appSlug?: string): string {
  return `https://github.com/apps/${appSlug ?? DEFAULT_GITHUB_APP_SLUG}/installations/new`;
}

export type GithubInstallation = {
  installationId: number;
  login: string;
  avatarUrl: string;
  type: string;
};

type McpCallTool = (req: {
  name: string;
  arguments: Record<string, unknown>;
}) => Promise<unknown>;

export async function fetchGithubInstallations(
  selfCallTool: McpCallTool,
  connectionId: string,
): Promise<{ installations: GithubInstallation[]; appSlug?: string }> {
  const result = await selfCallTool({
    name: "GITHUB_LIST_USER_ORGS",
    arguments: { connectionId },
  });
  const content = (result as { content?: Array<{ text?: string }> })
    .content?.[0]?.text;
  if (!content) {
    throw new Error("No response from GITHUB_LIST_USER_ORGS");
  }
  try {
    return JSON.parse(content) as {
      installations: GithubInstallation[];
      appSlug?: string;
    };
  } catch {
    throw new Error("Invalid response from GITHUB_LIST_USER_ORGS");
  }
}

export function findGithubInstallation(
  installations: GithubInstallation[],
  login: string,
): GithubInstallation | undefined {
  const needle = login.toLowerCase();
  return installations.find((inst) => inst.login.toLowerCase() === needle);
}
