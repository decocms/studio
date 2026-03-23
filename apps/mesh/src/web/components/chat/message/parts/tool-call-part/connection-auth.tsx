"use client";

import { Lock01 } from "@untitledui/icons";
import type { ToolUIPart } from "ai";
import {
  AuthCard,
  type ConnectionAuthData,
} from "@/web/components/connection-auth-card";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

interface ConnectionAuthPartProps {
  part: ToolUIPart;
}

export function ConnectionAuthPart({ part }: ConnectionAuthPartProps) {
  const effectiveState = getEffectiveState(part.state);

  if (effectiveState === "loading") {
    return (
      <ToolCallShell
        icon={<Lock01 className="size-4" />}
        title="Checking connection auth..."
        state="loading"
      />
    );
  }

  // Extract auth data from tool output
  const output = part.output as ConnectionAuthData | undefined;
  if (!output?.connection_id) {
    return (
      <ToolCallShell
        icon={<Lock01 className="size-4" />}
        title="Connection Auth"
        summary="No auth data"
        state="idle"
      />
    );
  }

  return <AuthCard data={output} />;
}
