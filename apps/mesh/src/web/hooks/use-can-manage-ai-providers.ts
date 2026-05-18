import { authClient } from "@/web/lib/auth-client";
import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/web/lib/query-keys";

const AI_PROVIDER_SELF_PERMISSIONS = [
  "AI_PROVIDER_KEY_CREATE",
  "AI_PROVIDER_KEY_UPDATE",
  "AI_PROVIDER_KEY_DELETE",
];

export function useCanManageAiProviders(): boolean {
  const { data: session } = authClient.useSession();
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const userId = session?.user?.id;

  const { data: membersData } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
    enabled: !!userId,
  });

  const { data: rolesData } = useQuery({
    queryKey: KEYS.organizationRoles(locator),
    queryFn: async () => {
      const result = await orgAuth.organization.listRoles();
      return result?.data ?? [];
    },
    enabled: !!userId,
  });

  if (!userId || !membersData?.data) return false;

  const members =
    (membersData.data as { members?: Array<{ userId: string; role: string }> })
      .members ?? [];
  const currentMember = members.find((m) => m.userId === userId);
  if (!currentMember) return false;

  const { role } = currentMember;

  if (role === "admin" || role === "owner") return true;

  if (Array.isArray(rolesData)) {
    const memberRole = (
      rolesData as Array<{
        role: string;
        permission?: Record<string, string[]>;
      }>
    ).find((r) => r.role === role);
    if (memberRole?.permission) {
      const selfPerms: string[] = memberRole.permission["self"] ?? [];
      if (selfPerms.includes("*")) return true;
      if (AI_PROVIDER_SELF_PERMISSIONS.some((p) => selfPerms.includes(p)))
        return true;
    }
  }

  return false;
}
