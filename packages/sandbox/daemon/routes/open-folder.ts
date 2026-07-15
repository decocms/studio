import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { jsonResponse } from "./body-parser";

export interface FolderOpenCommand {
  executable: string;
  args: string[];
}

/** Resolve the native file-manager command without invoking a shell. */
export function resolveFolderOpenCommand(
  platform: NodeJS.Platform,
  repoDir: string,
): FolderOpenCommand | null {
  if (platform === "darwin") {
    return { executable: "/usr/bin/open", args: [repoDir] };
  }
  if (platform === "win32") {
    return { executable: "explorer.exe", args: [repoDir] };
  }
  return null;
}

async function launchFolder(command: FolderOpenCommand): Promise<void> {
  await access(command.args[0]!);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function makeOpenFolderHandler(deps: {
  repoDir: string;
  platform?: NodeJS.Platform;
}): () => Promise<Response> {
  return async () => {
    const platform = deps.platform ?? process.platform;
    const command = resolveFolderOpenCommand(platform, deps.repoDir);
    if (!command) {
      return jsonResponse(
        { error: "Opening folders is only supported on macOS and Windows" },
        501,
      );
    }

    try {
      await launchFolder(command);
      return jsonResponse({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: `Failed to open folder: ${message}` }, 500);
    }
  };
}
