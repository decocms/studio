import { Page } from "@/components/page";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
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
import { authClient } from "@/lib/auth-client";
import {
  usePreferences,
  type ThemeMode,
  type ToolApprovalLevel,
} from "@/hooks/use-preferences.ts";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { useT } from "@/i18n/use-t.ts";
import type { Locale } from "@/i18n/locale.ts";
import { playSound } from "@deco/ui/lib/sound-engine.ts";
import { question004Sound } from "@deco/ui/lib/question-004.ts";
import { toast } from "@deco/ui/components/sonner.js";
import { track } from "@/lib/posthog-client";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";

interface ProfileFormValues {
  name: string;
}

// Language names stay in their own language on purpose — never translated.
const LANGUAGE_OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "pt-BR", label: "Português (Brasil)" },
];

function ProfileSection() {
  const t = useT();
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
        toast.success(t("settings.profile.updateSuccess"));
      } catch {
        form.reset(previousDefaults, { keepValues: true });
        toast.error(t("settings.profile.updateError"));
      }
    },
  });

  if (isPending) return null;

  return (
    <SettingsSection>
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.profile.avatar")}
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
          title={t("settings.profile.displayName")}
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
                  placeholder={t("settings.profile.displayNamePlaceholder")}
                  className="w-[280px]"
                />
              )}
            />
          }
        />
        <SettingsCardItem
          title={t("settings.profile.email")}
          action={
            <span className="text-sm text-muted-foreground">{user?.email}</span>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function PreferencesSection() {
  const t = useT();
  const [preferences, setPreferences] = usePreferences();

  const handleNotificationsChange = async (checked: boolean) => {
    if (checked) {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        track("preferences_notifications_permission_denied");
        toast.error(t("settings.preferences.notificationsDenied"));
        setPreferences((prev) => ({ ...prev, enableNotifications: false }));
        return;
      }
    }
    track("preferences_notifications_toggled", { enabled: checked });
    setPreferences((prev) => ({ ...prev, enableNotifications: checked }));
  };

  return (
    <SettingsSection title={t("settings.preferences.title")}>
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.preferences.theme")}
          description={t("settings.preferences.themeDescription")}
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
              <ToggleGroupItem
                value="light"
                aria-label={t("settings.preferences.themeLight")}
              >
                <Sun size={14} />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="dark"
                aria-label={t("settings.preferences.themeDark")}
              >
                <Moon01 size={14} />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="system"
                aria-label={t("settings.preferences.themeSystem")}
              >
                <Monitor01 size={14} />
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
        <SettingsCardItem
          title={t("settings.preferences.language")}
          description={t("settings.preferences.languageDescription")}
          action={
            <Select
              value={preferences.language}
              onValueChange={(value) => {
                track("preferences_language_changed", { to_value: value });
                setPreferences((prev) => ({
                  ...prev,
                  language: value as Locale,
                }));
              }}
            >
              <SelectTrigger className="w-44 h-7 text-xs">
                <span>
                  {
                    LANGUAGE_OPTIONS.find(
                      (option) => option.value === preferences.language,
                    )?.label
                  }
                </span>
              </SelectTrigger>
              <SelectContent>
                {LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    textValue={option.label}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsCardItem
          title={t("settings.preferences.notifications")}
          description={t("settings.preferences.notificationsDescription")}
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
          title={t("settings.preferences.sounds")}
          description={t("settings.preferences.soundsDescription")}
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
                aria-label={t("settings.preferences.soundsPreview")}
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
          title={t("settings.preferences.terminalVisible")}
          description={t("settings.preferences.terminalVisibleDescription")}
          onClick={() => {
            track("preferences_terminal_default_toggled", {
              enabled: !preferences.terminalVisibleByDefault,
            });
            setPreferences((prev) => ({
              ...prev,
              terminalVisibleByDefault: !prev.terminalVisibleByDefault,
            }));
          }}
          action={
            <Switch
              checked={preferences.terminalVisibleByDefault}
              onCheckedChange={(checked) => {
                track("preferences_terminal_default_toggled", {
                  enabled: checked,
                });
                setPreferences((prev) => ({
                  ...prev,
                  terminalVisibleByDefault: checked,
                }));
              }}
            />
          }
        />
        <SettingsCardItem
          title={t("settings.preferences.toolApproval")}
          description={t("settings.preferences.toolApprovalDescription")}
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
                    readonly: t("settings.preferences.toolApprovalAsk"),
                    auto: t("settings.preferences.toolApprovalAuto"),
                  }[preferences.toolApprovalLevel] ??
                    t("settings.preferences.toolApprovalAsk")}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="readonly"
                  textValue={t("settings.preferences.toolApprovalAsk")}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {t("settings.preferences.toolApprovalAsk")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("settings.preferences.toolApprovalAskDescription")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem
                  value="auto"
                  textValue={t("settings.preferences.toolApprovalAuto")}
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      {t("settings.preferences.toolApprovalAuto")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("settings.preferences.toolApprovalAutoDescription")}
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
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.title")}</Page.Title>
            <ProfileSection />
            <PreferencesSection />
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
