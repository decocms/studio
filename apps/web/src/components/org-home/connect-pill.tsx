/**
 * "Connect your agent to Studio" — the door to Settings › Connect, hoisted out
 * of Settings and onto the home.
 *
 * The page it links to generates OAuth and API-key install snippets for
 * Claude, Cursor and Codex; the pill teases all three as logos. The marks are
 * decorative — the sentence beside them already names the action, so the row
 * is `aria-hidden` and the link's accessible name stays the sentence.
 * Desktop only: it offers to install a CLI on the machine you are sitting at,
 * which is not the phone you are holding.
 */

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "@untitledui/icons";
import type { ReactNode } from "react";
import { ClaudeCodeIcon, CodexIcon } from "@/components/chat/agent-icons";
import { CursorIcon } from "@/components/connect/client-icons";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

/**
 * Brand names are never translated; `size` balances stroke vs. filled marks.
 * `bg`/`fg` are each client's real brand mark colors, not design-system
 * tokens — Claude's clay orange, and OpenAI/Cursor's monochrome black marks.
 */
const CLIENTS: {
  name: string;
  Icon: (props: { size?: number }) => ReactNode;
  size: number;
  bg: string;
  fg: string;
}[] = [
  { name: "Claude", Icon: ClaudeCodeIcon, size: 14, bg: "#D97757", fg: "#fff" },
  { name: "Cursor", Icon: CursorIcon, size: 12, bg: "#000", fg: "#fff" },
  { name: "Codex", Icon: CodexIcon, size: 12, bg: "#4F46E5", fg: "#fff" },
];

export function ConnectPill() {
  const t = useT();
  const { org } = useProjectContext();

  return (
    <Link
      to="/$org/settings/connect"
      params={{ org: org.slug }}
      onClick={() => track("connect_clients_opened", { source: "org_home" })}
      className="group hidden max-w-full md:inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-full border border-border bg-card py-1.5 pl-4 pr-2.5 text-sm transition-colors hover:bg-accent/60"
    >
      <span className="font-medium text-foreground">
        {t("home.orgHome.connectPill")}
      </span>
      <span aria-hidden="true" className="flex items-center gap-1">
        {CLIENTS.map(({ name, Icon, size, bg, fg }) => (
          <span
            key={name}
            title={name}
            className="flex size-6 items-center justify-center rounded-full"
            style={{ backgroundColor: bg, color: fg }}
          >
            <Icon size={size} />
          </span>
        ))}
      </span>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
