import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { getSettings } from "@/settings";
import { GitProviderError, type TokenSource } from "../types";
import { githubApiBaseUrl, githubFetch } from "./http";

const execFileAsync = promisify(execFile);
const HOST = "github.com";
const UserSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().min(1),
  avatar_url: z.string().url().nullable().optional(),
});

export function githubCliEnabled(): boolean {
  return getSettings().localMode;
}

function cliError(message: string): GitProviderError {
  return new GitProviderError({ provider: "github", status: 403, message });
}

/** Read only the selected CLI account, never an ambient automation token. */
async function readToken(login?: string): Promise<string> {
  if (!githubCliEnabled()) {
    throw cliError("GitHub CLI connections are only available in local mode.");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_DEBUG;
  delete env.DEBUG;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "auth",
        "token",
        "--hostname",
        HOST,
        ...(login ? ["--user", login] : []),
      ],
      { env, timeout: 10_000, maxBuffer: 16_384 },
    );
    const token = stdout.trim();
    if (!token || /\s/.test(token)) throw new Error("Invalid CLI token");
    return token;
  } catch {
    // Child process errors include stdout/stderr, which may contain a token.
    throw cliError(
      "Could not read your GitHub CLI login. Install gh and run gh auth login --hostname github.com, then connect again.",
    );
  }
}

async function identify(token: string) {
  try {
    const response = await githubFetch(`${githubApiBaseUrl(HOST)}/user`, {
      token,
      operation: "cli_current_user",
    });
    if (!response.ok) throw new Error("GitHub rejected the CLI token");
    return UserSchema.parse(await response.json());
  } catch {
    throw cliError(
      "Could not verify your GitHub CLI account. Run gh auth login --hostname github.com and connect again.",
    );
  }
}

export async function githubCliPrincipal() {
  const user = await identify(await readToken());
  return {
    // Installation IDs and user IDs are separate GitHub namespaces.
    externalAccountId: `cli:user:${user.id}`,
    login: user.login,
    avatarUrl: user.avatar_url ?? null,
  };
}

/** Tokens stay in memory; each use verifies the saved, immutable GitHub user ID. */
export function githubCliTokenSource(account: {
  host: string;
  login: string;
  externalAccountId: string;
}): TokenSource {
  return {
    kind: "token",
    async get() {
      if (account.host !== HOST) throw cliError("Unsupported GitHub CLI host.");
      const token = await readToken(account.login);
      const user = await identify(token);
      if (`cli:user:${user.id}` !== account.externalAccountId) {
        throw cliError("Your GitHub CLI account changed. Connect it again.");
      }
      return { token, kind: "token", expiresAt: null };
    },
  };
}
