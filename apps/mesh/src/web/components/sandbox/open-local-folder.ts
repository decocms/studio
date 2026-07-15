export function localFileManagerName(
  repoDir: string,
): "Finder" | "File Explorer" {
  const isWindowsPath =
    /^[a-z]:[\\/]/i.test(repoDir) || repoDir.startsWith("\\\\");
  return isWindowsPath ? "File Explorer" : "Finder";
}

export async function openSandboxRepoFolder(args: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): Promise<void> {
  const { orgSlug, virtualMcpId, branch } = args;
  const url = `/api/${orgSlug}/sandbox/${encodeURIComponent(virtualMcpId)}/${encodeURIComponent(branch)}/open-folder`;
  const response = await fetch(url, { method: "POST" });
  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(body?.error ?? "Failed to open folder");
}
