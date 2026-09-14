import { useSearch } from "@tanstack/react-router";
import { FileTab } from "@/layouts/main-panel-tabs/file-tab";
import { SettingsTab } from "@/layouts/main-panel-tabs/settings-tab";
import { useRouteVirtualMcpId, useRouteThreadId } from "@/layouts/thread-route";

export default function Route() {
  const search = useSearch({ strict: false });
  const virtualMcpId = useRouteVirtualMcpId();
  const threadId = useRouteThreadId();
  const value =
    "key" in search && typeof search.key === "string" ? search.key : undefined;
  return value ? (
    <FileTab key={value} fileKey={value} taskId={threadId} />
  ) : (
    <SettingsTab virtualMcpId={virtualMcpId} />
  );
}
