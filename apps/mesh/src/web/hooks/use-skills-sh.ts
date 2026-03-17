/**
 * Hook for searching skills from skills.sh API.
 * API: GET https://skills.sh/api/search?q={query}&limit=20
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";
import type { RegistryItem } from "../components/store/types";

interface SkillsShResult {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

function skillsShToRegistryItem(skill: SkillsShResult): RegistryItem {
  const [owner, repo] = (skill.source || "").split("/");
  return {
    id: skill.id,
    name: skill.name,
    title: skill.name,
    description: `${formatInstalls(skill.installs)} from ${skill.source}`,
    server: {
      name: skill.skillId || skill.name,
      title: skill.name,
      description: `${formatInstalls(skill.installs)} from ${skill.source}`,
      repository:
        owner && repo
          ? {
              url: `https://github.com/${skill.source}`,
              source: "github",
            }
          : undefined,
    },
    _meta: {
      "mcp.mesh": {
        id: skill.id,
        tags: ["skill", "skills.sh"],
        categories: ["Skills"],
      },
      "mesh.skillssh": {
        source: skill.source,
        installs: skill.installs,
        skillId: skill.skillId,
      },
    } as RegistryItem["_meta"],
  };
}

function formatInstalls(count: number): string {
  if (!count || count <= 0) return "";
  if (count >= 1_000_000)
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000)
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

export function useSkillsShSearch(query: string) {
  return useQuery({
    queryKey: KEYS.skillsShSearch(query),
    queryFn: async (): Promise<RegistryItem[]> => {
      if (!query || query.length < 2) return [];
      // Use proxy to avoid CORS — in dev Vite proxies /api/skills-sh → skills.sh/api
      // In production the server handles it
      const res = await fetch(
        `/api/skills-sh/search?q=${encodeURIComponent(query)}&limit=20`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as {
        skills: SkillsShResult[];
      };
      return (data.skills || []).map(skillsShToRegistryItem);
    },
    staleTime: 10 * 60 * 1000,
    enabled: query.length >= 2,
  });
}
