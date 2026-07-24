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
