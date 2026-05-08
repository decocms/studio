import { VirtualMcpDetailView } from "@/web/views/virtual-mcp";

export function SettingsTab({ virtualMcpId }: { virtualMcpId: string }) {
  return <VirtualMcpDetailView virtualMcpId={virtualMcpId} hideOwnTitle />;
}
