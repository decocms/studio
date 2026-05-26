import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebaseOntoBase } from "./rebase-onto-base";

function setupConflictingRepo(): {
  repoDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "rebase-onto-base-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  const gitOpts = { stdio: "ignore" as const };
  const gitcfg = `-c init.defaultBranch=main -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false`;
  const decoPath = ".deco/blocks/shipping.json";

  execSync(`git ${gitcfg} init --bare ${bare}`, gitOpts);
  execSync(`git ${gitcfg} init ${seed}`, gitOpts);

  mkdirSync(join(seed, ".deco/blocks"), { recursive: true });
  writeFileSync(
    join(seed, decoPath),
    JSON.stringify({ threshold: 200 }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} commit -m initial`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} branch -M main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} remote add origin ${bare}`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} push -u origin main`, gitOpts);

  execSync(`git ${gitcfg} -C ${seed} checkout -b feat/shipping`, gitOpts);
  writeFileSync(
    join(seed, decoPath),
    JSON.stringify({ threshold: 250 }, null, 2),
    "utf-8",
  );
  execSync(`git ${gitcfg} -C ${seed} add .`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${seed} commit -m "Update free shipping threshold to R$ 250"`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${seed} push -u origin feat/shipping`, gitOpts);

  // Diverge main so rebase always hits conflict resolution (modify/delete).
  execSync(`git ${gitcfg} -C ${seed} checkout main`, gitOpts);
  execSync(`git ${gitcfg} -C ${seed} rm ${decoPath}`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${seed} commit -m "Remove shipping block from main"`,
    gitOpts,
  );
  execSync(`git ${gitcfg} -C ${seed} push origin main`, gitOpts);

  const repoDir = join(root, "workspace");
  execSync(`git clone --branch feat/shipping ${bare} ${repoDir}`, gitOpts);
  execSync(
    `git ${gitcfg} -C ${repoDir} remote set-url origin ${bare}`,
    gitOpts,
  );

  return {
    repoDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("rebaseOntoBase", () => {
  it("rebases with -X theirs and resolves conflicts from branch changes", () => {
    const { repoDir, cleanup } = setupConflictingRepo();
    try {
      rebaseOntoBase(repoDir, "main", { asUser: false });

      const content = readFileSync(
        join(repoDir, ".deco/blocks/shipping.json"),
        "utf-8",
      );
      expect(JSON.parse(content)).toEqual({ threshold: 250 });

      const head = execSync(`git -C ${repoDir} rev-parse HEAD`)
        .toString()
        .trim();
      const main = execSync(`git -C ${repoDir} rev-parse origin/main`)
        .toString()
        .trim();
      expect(head).not.toBe(main);
    } finally {
      cleanup();
    }
  });
});
