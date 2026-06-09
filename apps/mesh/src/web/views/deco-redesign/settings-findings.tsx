// Findings & notifications — user scope (redesign mockup, local state only).
//
// Personal notification delivery: which channels reach you, how often per kind
// of update, and quiet hours. This never changes what the agent does — that's
// agent-scope (Autonomy), on the agent's own Findings & notifications page.

import { useState } from "react";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@deco/ui/components/select.tsx";
import { Mail01 } from "@untitledui/icons";

const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

function ChannelLogo({ domain }: { domain: string }) {
  return <img src={favicon(domain)} alt="" className="size-4 rounded-sm" />;
}
import { Page } from "@/web/components/page";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";

type Freq = "off" | "realtime" | "digest";

const FREQ_LABEL: Record<Freq, string> = {
  off: "Off",
  realtime: "Real-time",
  digest: "Daily digest",
};

function FreqSelect({
  value,
  onChange,
}: {
  value: Freq;
  onChange: (next: Freq) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Freq)}>
      <SelectTrigger className="h-8 w-36 text-sm">
        <span>{FREQ_LABEL[value]}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="realtime">Real-time</SelectItem>
        <SelectItem value="digest">Daily digest</SelectItem>
        <SelectItem value="off">Off</SelectItem>
      </SelectContent>
    </Select>
  );
}

const CATEGORIES: { id: string; title: string; defaultFreq: Freq }[] = [
  { id: "approvals", title: "Needs my approval", defaultFreq: "realtime" },
  { id: "critical", title: "Critical issues", defaultFreq: "realtime" },
  { id: "acted", title: "Acted on its own", defaultFreq: "digest" },
  { id: "wins", title: "Resolved & shipped", defaultFreq: "digest" },
];

const HOURS = ["07:00", "08:00", "09:00", "10:00", "17:00", "18:00", "19:00"];

function HourSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-24 text-sm">
        <span>{value}</span>
      </SelectTrigger>
      <SelectContent>
        {HOURS.map((h) => (
          <SelectItem key={h} value={h}>
            {h}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FindingsSettingsPage() {
  const [channels, setChannels] = useState({
    email: true,
    slack: false,
    whatsapp: false,
  });
  const [freqs, setFreqs] = useState<Record<string, Freq>>(() =>
    Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultFreq])),
  );
  const [weekly, setWeekly] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const [from, setFrom] = useState("18:00");
  const [to, setTo] = useState("09:00");

  return (
    <Page>
      <Page.Content>
        <Page.Body maxWidth="max-w-[760px]">
          <SettingsPage>
            <div>
              <h1 className="text-xl font-medium text-foreground">
                Findings &amp; notifications
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                How and when Deco reaches you.
              </p>
            </div>

            <SettingsSection title="Channels">
              <SettingsCard>
                <SettingsCardItem
                  icon={<Mail01 size={16} />}
                  title="Email"
                  description="rafael.valls@deco.cx"
                  action={
                    <Switch
                      checked={channels.email}
                      onCheckedChange={(v) =>
                        setChannels({ ...channels, email: v })
                      }
                    />
                  }
                />
                <SettingsCardItem
                  icon={<ChannelLogo domain="slack.com" />}
                  title="Slack"
                  action={
                    channels.slack ? (
                      <Switch
                        checked
                        onCheckedChange={(v) =>
                          setChannels({ ...channels, slack: v })
                        }
                      />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setChannels({ ...channels, slack: true })
                        }
                      >
                        Connect
                      </Button>
                    )
                  }
                />
                <SettingsCardItem
                  icon={<ChannelLogo domain="whatsapp.com" />}
                  title="WhatsApp"
                  action={
                    channels.whatsapp ? (
                      <Switch
                        checked
                        onCheckedChange={(v) =>
                          setChannels({ ...channels, whatsapp: v })
                        }
                      />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setChannels({ ...channels, whatsapp: true })
                        }
                      >
                        Connect
                      </Button>
                    )
                  }
                />
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="What reaches you">
              <SettingsCard>
                {CATEGORIES.map((c) => (
                  <SettingsCardItem
                    key={c.id}
                    title={c.title}
                    action={
                      <FreqSelect
                        value={freqs[c.id] ?? c.defaultFreq}
                        onChange={(next) =>
                          setFreqs((prev) => ({ ...prev, [c.id]: next }))
                        }
                      />
                    }
                  />
                ))}
                <SettingsCardItem
                  title="Weekly summary"
                  action={
                    <Switch checked={weekly} onCheckedChange={setWeekly} />
                  }
                />
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Quiet hours">
              <SettingsCard>
                <SettingsCardItem
                  title="Pause non-critical notifications"
                  action={<Switch checked={quiet} onCheckedChange={setQuiet} />}
                />
                {quiet && (
                  <div className="flex items-center gap-3 px-4 py-4 text-sm">
                    <span className="text-muted-foreground">From</span>
                    <HourSelect value={from} onChange={setFrom} />
                    <span className="text-muted-foreground">to</span>
                    <HourSelect value={to} onChange={setTo} />
                  </div>
                )}
              </SettingsCard>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
