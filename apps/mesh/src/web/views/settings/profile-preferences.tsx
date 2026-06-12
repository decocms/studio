import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy01 } from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { KEYS } from "@/web/lib/query-keys";
import {
  useChannelClient,
  useUserPhone,
} from "@/web/hooks/collections/use-channels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@deco/ui/components/select.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@deco/ui/components/toggle-group.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Moon01, Monitor01, Play, Sun } from "@untitledui/icons";
import { Controller, useForm } from "react-hook-form";
import { authClient } from "@/web/lib/auth-client";
import {
  usePreferences,
  type ThemeMode,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
import { playSound } from "@deco/ui/lib/sound-engine.ts";
import { question004Sound } from "@deco/ui/lib/question-004.ts";
import { toast } from "@deco/ui/components/sonner.js";
import { track } from "@/web/lib/posthog-client";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/web/components/settings/settings-section";

interface ProfileFormValues {
  name: string;
}

function ProfileSection() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;

  const form = useForm<ProfileFormValues>({
    values: { name: user?.name ?? "" },
  });

  const { schedule: scheduleSave, flush: flushAndSave } = useDebouncedAutosave({
    save: async () => {
      // Read live dirty state from control._formState (Proxy lag workaround).
      const liveDirtyFields = (
        form.control as unknown as {
          _formState: { dirtyFields: Record<string, unknown> };
        }
      )._formState.dirtyFields;
      if (Object.keys(liveDirtyFields).length === 0) return;

      const values = form.getValues();
      const previousDefaults = (
        form.control as unknown as { _defaultValues: ProfileFormValues }
      )._defaultValues;

      // Rebase pre-mutate so an edit during the in-flight save that returns
      // a value to its pre-save default still registers as dirty.
      form.reset(values, { keepValues: true });

      try {
        await authClient.updateUser({ name: values.name });
        track("profile_updated", { fields: ["name"] });
        toast.success("Profile updated successfully");
      } catch {
        form.reset(previousDefaults, { keepValues: true });
        toast.error("Failed to update profile");
      }
    },
  });

  if (isPending) return null;

  return (
    <SettingsSection>
      <SettingsCard>
        <SettingsCardItem
          title="Avatar"
          action={
            <Avatar
              url={userImage}
              fallback={user?.name ?? "U"}
              shape="circle"
              size="base"
            />
          }
        />
        <SettingsCardItem
          title="Display name"
          action={
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  id="display-name"
                  {...field}
                  onChange={(e) => {
                    field.onChange(e);
                    scheduleSave();
                  }}
                  onBlur={() => {
                    field.onBlur();
                    flushAndSave();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void flushAndSave();
                  }}
                  placeholder="Your name"
                  className="w-[280px]"
                />
              )}
            />
          }
        />
        <SettingsCardItem
          title="Email"
          action={
            <span className="text-sm text-muted-foreground">{user?.email}</span>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function WhatsAppLinkSection() {
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const { client } = useChannelClient();
  const queryClient = useQueryClient();
  const { data: phone } = useUserPhone(userId);
  const [copied, setCopied] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.userPhone(userId) });

  const start = useMutation({
    mutationFn: async () => {
      await client.callTool({ name: "PHONE_LINK_START", arguments: {} });
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(`Failed to start linking: ${err.message}`),
  });

  const remove = useMutation({
    mutationFn: async () => {
      await client.callTool({ name: "PHONE_DELETE", arguments: {} });
    },
    onSuccess: invalidate,
    onError: (err) => toast.error(`Failed to unlink: ${err.message}`),
  });

  // Hidden entirely when the deployment has no WhatsApp concierge configured.
  if (!phone || !phone.configured) return null;

  const conciergeDisplay = phone.conciergeNumber
    ? `+${phone.conciergeNumber.replace(/\D/g, "")}`
    : "the concierge number";

  return (
    <SettingsSection
      title="WhatsApp"
      description="Link your number to chat with your organizations' agents over WhatsApp."
    >
      <SettingsCard>
        {phone.status === "verified" ? (
          <SettingsCardItem
            title="WhatsApp number"
            description={`Linked${phone.maskedPhone ? ` · ${phone.maskedPhone}` : ""}`}
            action={
              <Button
                variant="outline"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Remove
              </Button>
            }
          />
        ) : phone.status === "pending" && phone.code ? (
          <SettingsCardItem
            title="Verify your number"
            description={`Send the code below to ${conciergeDisplay} on WhatsApp. This page updates automatically once it arrives.`}
            action={
              <div className="flex items-center gap-2">
                <code className="rounded-md bg-muted px-2 py-1.5 text-xs">
                  {phone.code}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => {
                    navigator.clipboard.writeText(phone.code ?? "").then(() => {
                      setCopied(true);
                      toast.success("Code copied");
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy01 size={14} />}
                </Button>
                <Spinner size="sm" />
              </div>
            }
          />
        ) : (
          <SettingsCardItem
            title="WhatsApp number"
            description="Not linked yet."
            action={
              <Button
                size="sm"
                disabled={start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? "Starting…" : "Link WhatsApp"}
              </Button>
            }
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function PreferencesSection() {
  const [preferences, setPreferences] = usePreferences();

  const handleNotificationsChange = async (checked: boolean) => {
    if (checked) {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        track("preferences_notifications_permission_denied");
        toast.error(
          "Notifications denied. Please enable them in your browser settings.",
        );
        setPreferences((prev) => ({ ...prev, enableNotifications: false }));
        return;
      }
    }
    track("preferences_notifications_toggled", { enabled: checked });
    setPreferences((prev) => ({ ...prev, enableNotifications: checked }));
  };

  return (
    <SettingsSection title="Preferences">
      <SettingsCard>
        <SettingsCardItem
          title="Theme"
          description="Your preferred color scheme."
          action={
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={preferences.theme}
              onValueChange={(value) => {
                if (value) {
                  track("preferences_theme_changed", { to_value: value });
                  setPreferences((prev) => ({
                    ...prev,
                    theme: value as ThemeMode,
                  }));
                }
              }}
            >
              <ToggleGroupItem value="light" aria-label="Light theme">
                <Sun size={14} />
              </ToggleGroupItem>
              <ToggleGroupItem value="dark" aria-label="Dark theme">
                <Moon01 size={14} />
              </ToggleGroupItem>
              <ToggleGroupItem value="system" aria-label="System theme">
                <Monitor01 size={14} />
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
        <SettingsCardItem
          title="Notifications"
          description="Receive browser notifications for important events."
          onClick={
            typeof Notification !== "undefined"
              ? () =>
                  handleNotificationsChange(!preferences.enableNotifications)
              : undefined
          }
          action={
            <Switch
              disabled={typeof Notification === "undefined"}
              checked={preferences.enableNotifications}
              onCheckedChange={handleNotificationsChange}
            />
          }
        />
        <SettingsCardItem
          title="Sounds"
          description="Play sounds for agent actions and notifications."
          onClick={() => {
            track("preferences_sounds_toggled", {
              enabled: !preferences.enableSounds,
            });
            setPreferences((prev) => ({
              ...prev,
              enableSounds: !prev.enableSounds,
            }));
          }}
          action={
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Preview notification sound"
                onClick={() => {
                  track("preferences_sounds_previewed");
                  playSound(question004Sound.dataUri).catch(() => {});
                }}
                className="size-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
              >
                <Play size={11} />
              </button>
              <Switch
                checked={preferences.enableSounds}
                onCheckedChange={(checked) => {
                  track("preferences_sounds_toggled", { enabled: checked });
                  setPreferences((prev) => ({
                    ...prev,
                    enableSounds: checked,
                  }));
                }}
              />
            </div>
          }
        />
        <SettingsCardItem
          title="Tool Approval"
          description="Control how tools are approved before execution."
          action={
            <Select
              value={preferences.toolApprovalLevel}
              onValueChange={(value) => {
                track("preferences_tool_approval_changed", {
                  to_value: value,
                });
                setPreferences((prev) => ({
                  ...prev,
                  toolApprovalLevel: value as ToolApprovalLevel,
                }));
              }}
            >
              <SelectTrigger className="w-36 h-7 text-xs">
                <span>
                  {{
                    readonly: "Ask before edit",
                    auto: "Auto approve",
                  }[preferences.toolApprovalLevel] ?? "Ask before edit"}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="readonly" textValue="Ask before edit">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">Ask before edit</span>
                    <span className="text-xs text-muted-foreground">
                      Auto-approve read-only tools
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="auto" textValue="Auto approve">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">Auto approve</span>
                    <span className="text-xs text-muted-foreground">
                      Execute all without approval
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export function ProfilePreferencesPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Profile & Preferences</Page.Title>
            <ProfileSection />
            <WhatsAppLinkSection />
            <PreferencesSection />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
