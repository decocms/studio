import { Navigate, useParams, useSearch } from "@tanstack/react-router";
import { PROJECT_ROUTE } from "@/hooks/use-destination-route";
import { isProjectSettingsSectionKey } from "@/views/virtual-mcp/settings/sections";

/** A project's settings are sections of its Context; this keeps old links. */
export default function AgentSettingsRoute() {
  const { org, agentId } = useParams({ strict: false });
  const { section } = useSearch({ strict: false });
  if (!org || !agentId) return null;
  return (
    <Navigate
      to={PROJECT_ROUTE.library}
      params={{ org, agentId }}
      search={{
        section: isProjectSettingsSectionKey(section) ? section : "general",
      }}
      replace
    />
  );
}
