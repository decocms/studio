import { Navigate, useParams } from "@tanstack/react-router";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { isProjectSettingsSectionKey } from "@/views/virtual-mcp/settings/sections";

/** A project's settings are sections of its Context; this keeps old links,
 *  with the rest of their search (open panels, thread). */
export default function AgentSettingsRoute() {
  const { org, agentId } = useParams({ strict: false });
  if (!org || !agentId) return null;
  return (
    <Navigate
      to={PROJECT_ROUTE.library}
      params={{ org, agentId }}
      search={(prev: Record<string, unknown>) => {
        const section =
          typeof prev.section === "string" ? prev.section : undefined;
        return {
          ...prev,
          section: isProjectSettingsSectionKey(section) ? section : "general",
        };
      }}
      replace
    />
  );
}
