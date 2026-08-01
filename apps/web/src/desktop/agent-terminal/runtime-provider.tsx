import type { PropsWithChildren } from "react";
import {
  AgentRuntimeSlotProvider,
  type AgentRuntimeAdapter,
} from "@/lib/desktop/agent-runtime-slot";
import { NativeAgentTerminalProvider } from "./active-task-provider";
import { NativeAgentTerminalPanel } from "./terminal-panel";

const NATIVE_AGENT_RUNTIME_ADAPTER: AgentRuntimeAdapter = {
  ActiveTaskProvider: NativeAgentTerminalProvider,
  SidePanel: NativeAgentTerminalPanel,
};

/** Installed exclusively by index.native.tsx. */
export function NativeAgentRuntimeProvider({ children }: PropsWithChildren) {
  return (
    <AgentRuntimeSlotProvider adapter={NATIVE_AGENT_RUNTIME_ADAPTER}>
      {children}
    </AgentRuntimeSlotProvider>
  );
}
