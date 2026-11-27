/** Settings › Connect: the `decocms-studio` skill + CLI login, then the org's API keys. */

import { type ComponentType, useState } from "react";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { Link01 } from "@untitledui/icons";
import { ClaudeCodeIcon, CodexIcon } from "@/components/chat/agent-icons";
import { CursorIcon } from "@/components/connect/client-icons";
import {
  type ConnectClient,
  CopySnippet,
} from "@/components/connect/copy-snippet";
import {
  cliLoginCommand,
  skillInstallCommand,
} from "@/components/connect/skill-install";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import { SettingsSection } from "@/components/settings/settings-section";
import { RequireCapability } from "@/components/require-capability";
import { ApiKeysSection } from "@/views/settings/api-keys";

/** Brand names are never translated; only "Other" carries a `labelKey`. */
const CLIENTS: {
  id: ConnectClient;
  label: string;
  labelKey?: TranslationKey;
  Icon: ComponentType<{ size?: number }>;
}[] = [
  { id: "claude-code", label: "Claude", Icon: ClaudeCodeIcon },
  { id: "cursor", label: "Cursor", Icon: CursorIcon },
  { id: "codex", label: "Codex", Icon: CodexIcon },
  {
    id: "raw",
    label: "Other client",
    labelKey: "settings.connectClients.otherClient",
    Icon: Link01,
  },
];

function ClientTabsList() {
  const t = useT();
  return (
    <TabsList
      variant="underline"
      className="h-10 min-w-0 flex-1 gap-1 overflow-x-auto border-b-0"
    >
      {CLIENTS.map(({ id, label, labelKey, Icon }) => (
        <TabsTrigger key={id} value={id} variant="underline" className="gap-2">
          <Icon size={16} />
          {labelKey ? t(labelKey) : label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** Install the skill, then log the CLI in: the two things a local agent needs. */
function SkillSetup({
  client,
  onClientChange,
}: {
  client: ConnectClient;
  onClientChange: (value: string) => void;
}) {
  const t = useT();
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <div className="flex flex-col gap-3">
      <p className="px-4 text-sm leading-snug text-muted-foreground">
        {t("settings.connectClients.skillDescription")}
      </p>
      <Card className="gap-0 divide-y divide-border overflow-hidden p-0">
        <Tabs
          value={client}
          onValueChange={onClientChange}
          variant="underline"
          className="gap-0"
        >
          <h3 className="px-5 pt-4 text-sm font-medium">
            {t("settings.connectClients.skillInstallStep")}
          </h3>
          <div className="flex px-3 py-1">
            <ClientTabsList />
          </div>
          {CLIENTS.map(({ id }) => (
            <TabsContent key={id} value={id} className="flex flex-col p-2">
              <CopySnippet label="bash" code={skillInstallCommand(id)} />
              {id === "raw" && (
                <p className="px-3 pb-2 text-xs leading-snug text-muted-foreground">
                  {t("settings.connectClients.skillOtherAgentsHint")}
                </p>
              )}
            </TabsContent>
          ))}
        </Tabs>
        <div className="flex flex-col gap-1 p-2">
          <h3 className="px-3 pt-2 text-sm font-medium">
            {t("settings.connectClients.skillLoginStep")}
          </h3>
          <CopySnippet label="bash" code={cliLoginCommand(origin)} />
        </div>
      </Card>
      <p className="px-4 text-xs leading-snug text-muted-foreground">
        <a
          href="https://bun.com"
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2 hover:no-underline"
        >
          {t("settings.connectClients.skillNeedsBun")}
        </a>{" "}
        {t("settings.connectClients.skillLoginHint")}
      </p>
    </div>
  );
}

function OrgConnectContent() {
  const t = useT();
  const [client, setClient] = useState<ConnectClient>("claude-code");
  /** Narrow rather than cast: Tabs hands back a bare string. */
  const selectClient = (value: string) => {
    const next = CLIENTS.find((c) => c.id === value);
    if (next) setClient(next.id);
  };

  return (
    <>
      <SettingsSection title={t("settings.connectClients.skillTitle")}>
        <SkillSetup client={client} onClientChange={selectClient} />
      </SettingsSection>

      <RequireCapability capability="api-keys:manage" area="api-keys">
        <ApiKeysSection />
      </RequireCapability>
    </>
  );
}

export function OrgConnectPage() {
  return (
    <SettingsGroupPage group="connect">
      <OrgConnectContent />
    </SettingsGroupPage>
  );
}
