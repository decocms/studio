import type { Config } from "../types";
import { git } from "./git";

export function configureGitIdentity(config: Config): void {
  if (!config.git?.identity?.userName || !config.git?.identity?.userEmail)
    return;
  git(["config", "user.name", config.git?.identity?.userName], {
    cwd: config.repoDir,
  });
  git(["config", "user.email", config.git?.identity?.userEmail], {
    cwd: config.repoDir,
  });
}
