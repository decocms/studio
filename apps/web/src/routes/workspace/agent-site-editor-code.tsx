import { AgentViewGuard } from "./agent-view-guard";
import { useSearch } from "@tanstack/react-router";
import { CodeTab } from "@/layouts/main-panel-tabs/code-tab";

export default function CodeRoute() {
  const search = useSearch({ strict: false });
  const file =
    "file" in search && typeof search.file === "string"
      ? search.file
      : undefined;
  return (
    <AgentViewGuard tabId="code">
      <CodeTab openPath={file ?? null} />
    </AgentViewGuard>
  );
}
