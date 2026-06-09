import { useReducer, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Check,
  Copy01,
  Eye,
  EyeOff,
  LinkExternal01,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  SettingsCard,
  SettingsCardItem,
} from "@/web/components/settings/settings-section";
import { StepIndicator } from "@deco/ui/components/step-indicator.tsx";
import {
  invalidateChannels,
  useAgentOptions,
  useChannelClient,
  useChannelPlatforms,
  type ChannelPlatform,
  type ChannelSetupStep,
  type ChannelType,
} from "@/web/hooks/collections/use-channels";
import {
  initialState,
  reducer,
  stepIndex,
  WIZARD_STEPS,
  type WizardState,
} from "./wizard-state";

interface ResumeTarget {
  platform: ChannelType;
  channelId: string;
  webhookUrl: string;
  step: "instructions" | "endpoint" | "credentials" | "testing";
}

export function SetupWizardDialog({
  open,
  onOpenChange,
  resume,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resume?: ResumeTarget;
}) {
  const platforms = useChannelPlatforms();
  const agentOptions = useAgentOptions();
  const { org, client } = useChannelClient();
  const queryClient = useQueryClient();

  // Lazy init from `resume` so reopening at a draft's step needs no effect.
  const [state, dispatch] = useReducer(
    reducer,
    resume
      ? ({
          kind: resume.step,
          platform: resume.platform,
          channelId: resume.channelId,
          webhookUrl: resume.webhookUrl,
        } as WizardState)
      : initialState,
  );

  const createDraft = useMutation({
    mutationFn: async (platform: ChannelType) => {
      const result = (await client.callTool({
        name: "CHANNEL_CREATE",
        arguments: { channelType: platform },
      })) as { structuredContent?: { id: string; webhookUrl: string } };
      if (!result.structuredContent)
        throw new Error("Failed to create channel");
      return result.structuredContent;
    },
    onSuccess: (data, platform) => {
      invalidateChannels(queryClient, org.id);
      dispatch({
        type: "draft-created",
        platform,
        channelId: data.id,
        webhookUrl: data.webhookUrl,
      });
    },
    onError: (err) => {
      toast.error(`Failed to start setup: ${err.message}`);
      dispatch({ type: "draft-failed" });
    },
  });

  const close = () => {
    onOpenChange(false);
  };

  const platform =
    "platform" in state
      ? platforms.find((p) => p.id === state.platform)
      : undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {state.kind === "grid"
              ? "Add a channel"
              : `Set up ${platform?.name ?? "channel"}`}
          </DialogTitle>
          <DialogDescription>
            {state.kind === "grid"
              ? "Connect a chat platform so a bot can run a Decopilot agent in this organization."
              : "Follow the steps to register your bot and connect it."}
          </DialogDescription>
        </DialogHeader>

        {state.kind !== "grid" && state.kind !== "creating-draft" && (
          <div className="py-1">
            <StepIndicator
              steps={WIZARD_STEPS}
              currentStep={stepIndex(state)}
            />
          </div>
        )}

        {state.kind === "grid" && (
          <PlatformGrid
            platforms={platforms}
            disabled={createDraft.isPending}
            onSelect={(p) => {
              dispatch({ type: "select-platform", platform: p });
              createDraft.mutate(p);
            }}
          />
        )}

        {state.kind === "creating-draft" && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Spinner size="sm" /> Preparing setup…
          </div>
        )}

        {state.kind === "instructions" && platform && (
          <InstructionsStep
            platform={platform}
            onNext={() => dispatch({ type: "to-endpoint" })}
          />
        )}

        {state.kind === "endpoint" && platform && (
          <EndpointStep
            platform={platform}
            webhookUrl={state.webhookUrl}
            onBack={() => dispatch({ type: "back-to-instructions" })}
            onNext={() => dispatch({ type: "to-credentials" })}
          />
        )}

        {state.kind === "credentials" && platform && (
          <CredentialsStep
            platform={platform}
            channelId={state.channelId}
            agentOptions={agentOptions}
            onBack={() => dispatch({ type: "back-to-endpoint" })}
            onSaved={() => {
              invalidateChannels(queryClient, org.id);
              dispatch({ type: "creds-saved" });
            }}
          />
        )}

        {(state.kind === "testing" || state.kind === "test-error") && (
          <TestStep
            channelId={state.channelId}
            error={state.kind === "test-error" ? state.error : undefined}
            onBack={() => dispatch({ type: "back-to-endpoint" })}
            onPassed={(botDisplayName) => {
              invalidateChannels(queryClient, org.id);
              dispatch({ type: "test-passed", botDisplayName });
            }}
            onFailed={(error) => dispatch({ type: "test-failed", error })}
          />
        )}

        {state.kind === "active" && (
          <ActiveStep
            platformName={platform?.name ?? "Channel"}
            botDisplayName={state.botDisplayName}
            onDone={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlatformGrid({
  platforms,
  onSelect,
  disabled,
}: {
  platforms: ChannelPlatform[];
  onSelect: (p: ChannelType) => void;
  disabled: boolean;
}) {
  return (
    <SettingsCard>
      {platforms.map((p) => (
        <SettingsCardItem
          key={p.id}
          onClick={disabled ? undefined : () => onSelect(p.id)}
          icon={
            <Avatar
              fallback={p.name.charAt(0)}
              className="size-8 bg-primary/10 text-primary"
            />
          }
          title={p.name}
          description={p.description}
        />
      ))}
    </SettingsCard>
  );
}

function InstructionsStep({
  platform,
  onNext,
}: {
  platform: ChannelPlatform;
  onNext: () => void;
}) {
  const step = platform.setupInstructions[0];
  return (
    <div className="space-y-4">
      <StepBody step={step} />
      <DialogFooter>
        <Button size="sm" onClick={onNext}>
          Next
        </Button>
      </DialogFooter>
    </div>
  );
}

function EndpointStep({
  platform,
  webhookUrl,
  onBack,
  onNext,
}: {
  platform: ChannelPlatform;
  webhookUrl: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const step = platform.setupInstructions[1] ?? platform.setupInstructions[0];
  return (
    <div className="space-y-4">
      <StepBody step={step} />
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Endpoint URL</Label>
        <CopyableValue value={webhookUrl} />
      </div>
      <DialogFooter className="justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </Button>
        <Button size="sm" onClick={onNext}>
          Next
        </Button>
      </DialogFooter>
    </div>
  );
}

function CredentialsStep({
  platform,
  channelId,
  agentOptions,
  onBack,
  onSaved,
}: {
  platform: ChannelPlatform;
  channelId: string;
  agentOptions: Array<{ id: string; title: string }>;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { client } = useChannelClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState<string>("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const save = useMutation({
    mutationFn: async () => {
      const credentials: Record<string, string> = {};
      for (const f of platform.credentialFields) {
        const v = values[f.key]?.trim() ?? "";
        if (v) credentials[f.key] = v;
      }
      await client.callTool({
        name: "CHANNEL_UPDATE",
        arguments: {
          id: channelId,
          credentials,
          ...(agentId ? { agentId } : {}),
        },
      });
    },
    onSuccess: onSaved,
    onError: (err) => toast.error(`Failed to save credentials: ${err.message}`),
  });

  const missingRequired = platform.credentialFields.some(
    (f) => !f.optional && !(values[f.key]?.trim() ?? ""),
  );

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {platform.credentialFields.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {f.label}
            {f.optional ? " (optional)" : ""}
          </Label>
          <div className="relative">
            <Input
              type={f.secret && !revealed[f.key] ? "password" : "text"}
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
              className={cn("h-8 text-sm", f.secret && "ph-no-capture pr-8")}
            />
            {f.secret && (
              <button
                type="button"
                onClick={() =>
                  setRevealed((r) => ({ ...r, [f.key]: !r[f.key] }))
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {revealed[f.key] ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
          </div>
          {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
        </div>
      ))}

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          Agent (which Decopilot agent the bot runs)
        </Label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select an agent…" />
          </SelectTrigger>
          <SelectContent>
            {agentOptions.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The bot answers messages by running this agent. You can change it
          later.
        </p>
      </div>

      <DialogFooter className="justify-between">
        <Button variant="ghost" size="sm" type="button" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </Button>
        <Button
          size="sm"
          type="submit"
          disabled={save.isPending || missingRequired}
        >
          {save.isPending ? "Saving…" : "Save & continue"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function TestStep({
  channelId,
  error,
  onBack,
  onPassed,
  onFailed,
}: {
  channelId: string;
  error?: string;
  onBack: () => void;
  onPassed: (botDisplayName?: string) => void;
  onFailed: (error: string) => void;
}) {
  const { client } = useChannelClient();
  const test = useMutation({
    mutationFn: async () => {
      const result = (await client.callTool({
        name: "CHANNEL_TEST",
        arguments: { id: channelId },
      })) as {
        structuredContent?: {
          ok: boolean;
          message?: string;
          botDisplayName?: string;
        };
      };
      return result.structuredContent;
    },
    onSuccess: (data) => {
      if (data?.ok) onPassed(data.botDisplayName);
      else onFailed(data?.message ?? "The platform rejected the credentials.");
    },
    onError: (err) => onFailed(err.message),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Test the connection to confirm your credentials work, then activate the
        channel.
      </p>
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <DialogFooter className="justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </Button>
        <Button
          size="sm"
          onClick={() => test.mutate()}
          disabled={test.isPending}
        >
          {test.isPending ? (
            <>
              <Spinner size="sm" /> Testing…
            </>
          ) : (
            "Test & activate"
          )}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ActiveStep({
  platformName,
  botDisplayName,
  onDone,
}: {
  platformName: string;
  botDisplayName?: string;
  onDone: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md bg-primary/10 p-3 text-sm">
        <Check size={16} className="text-primary" />
        <span>
          {platformName} is connected
          {botDisplayName ? ` as ${botDisplayName}` : ""}. Your bot is live.
        </span>
      </div>
      <DialogFooter>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function StepBody({ step }: { step?: ChannelSetupStep }) {
  if (!step) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{step.title}</p>
      <p className="text-sm text-muted-foreground">{step.description}</p>
      {step.link && (
        <a
          href={step.link.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {step.link.label} <LinkExternal01 size={14} />
        </a>
      )}
    </div>
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={() => {
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            toast.success("Copied to clipboard");
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={14} /> : <Copy01 size={14} />}
      </Button>
    </div>
  );
}
