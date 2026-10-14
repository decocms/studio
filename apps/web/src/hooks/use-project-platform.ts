/**
 * Which commerce platform each project sells on, read off the connections it
 * holds rather than a field someone filled in.
 *
 * SUSPENDS: `useConnections` is a suspense read, so this belongs on a page that
 * already waits for data and sits under a boundary. Do not put it on the
 * sidebar or the org home, which both promise to paint on the first frame —
 * a platform mark is decoration and must never hold a page back.
 */

import {
  platformFromConnections,
  type CommercePlatform,
} from "@/lib/project-profile.ts";
import { useConnections } from "@/sdk";

interface ProjectLike {
  id: string;
  connections?: readonly { connection_id: string }[] | null;
}

export function useProjectPlatforms(
  projects: readonly ProjectLike[],
): Map<string, CommercePlatform> {
  const connections = useConnections();
  const out = new Map<string, CommercePlatform>();
  for (const project of projects) {
    const platform = platformFromConnections(project, connections);
    if (platform) out.set(project.id, platform);
  }
  return out;
}
