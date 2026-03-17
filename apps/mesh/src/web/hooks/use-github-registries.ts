/**
 * Manages the list of GitHub repositories added as skill/agent registries.
 * Persisted in localStorage, scoped by organization.
 */

import { useLocalStorage } from "./use-local-storage";
import { LOCALSTORAGE_KEYS } from "../lib/localstorage-keys";

export interface GitHubRegistry {
  owner: string;
  repo: string;
}

const WELL_KNOWN_REGISTRIES: GitHubRegistry[] = [];

export function useGitHubRegistries(orgSlug: string) {
  const [registries, setRegistries] = useLocalStorage<GitHubRegistry[]>(
    LOCALSTORAGE_KEYS.githubRegistries(orgSlug),
    (existing) => existing ?? [],
  );

  const allRegistries = [
    ...WELL_KNOWN_REGISTRIES,
    ...registries.filter(
      (r) =>
        !WELL_KNOWN_REGISTRIES.some(
          (w) => w.owner === r.owner && w.repo === r.repo,
        ),
    ),
  ];

  const addRegistry = (owner: string, repo: string) => {
    setRegistries((prev) => {
      if (prev.some((r) => r.owner === owner && r.repo === repo)) return prev;
      return [...prev, { owner, repo }];
    });
  };

  const removeRegistry = (owner: string, repo: string) => {
    setRegistries((prev) =>
      prev.filter((r) => !(r.owner === owner && r.repo === repo)),
    );
  };

  return {
    registries: allRegistries,
    userRegistries: registries,
    addRegistry,
    removeRegistry,
    isWellKnown: (owner: string, repo: string) =>
      WELL_KNOWN_REGISTRIES.some((w) => w.owner === owner && w.repo === repo),
  };
}
