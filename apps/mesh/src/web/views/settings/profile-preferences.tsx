import { useState } from "react";
import { Page } from "@/web/components/page";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@deco/ui/components/card.tsx";
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
import { Button } from "@deco/ui/components/button.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Moon01, Monitor01, Play, Sun } from "@untitledui/icons";
import { authClient } from "@/web/lib/auth-client";
import {
  usePreferences,
  type SoundEventKey,
  type ThemeMode,
  type ToolApprovalLevel,
} from "@/web/hooks/use-preferences.ts";
import { SOUND_MAP } from "@/web/hooks/use-status-sounds.ts";
import { playSound } from "@deco/ui/lib/sound-engine.ts";
import { toast } from "@deco/ui/components/sonner.js";

function PreferenceRow({
  label,
  description,
  control,
  onClick,
  disabled,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 py-3 border-b border-border/50 last:border-0"
      onClick={disabled ? undefined : onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      onKeyDown={
        onClick && !disabled
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{ cursor: onClick && !disabled ? "pointer" : undefined }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        {control}
      </div>
    </div>
  );
}

function ProfileSection() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;
  const userImage = (user as { image?: string } | undefined)?.image;
  const [editedName, setEditedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const name = editedName ?? user?.name ?? "";
  const isDirty = editedName !== null && editedName !== (user?.name ?? "");

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      await authClient.updateUser({ name });
      setEditedName(null);
      toast.success("Profile updated");
    } catch {
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (isPending) return null;

  return (
    <Card className="p-6">
      <CardHeader className="p-0">
        <CardTitle className="text-sm">Profile</CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-6 p-0">
        <div className="flex flex-col sm:flex-row items-start gap-6">
          <Avatar
            url={userImage}
            fallback={user?.name ?? "U"}
            shape="circle"
            size="lg"
            className="shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-5 w-full">
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="display-name"
                className="text-xs text-muted-foreground"
              >
                Display name
              </Label>
              <Input
                id="display-name"
                value={name}
                onChange={(e) => setEditedName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSave();
                }}
                placeholder="Your name"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Email</span>
              <span className="text-sm text-foreground/80 pt-2 break-all">
                {user?.email}
              </span>
            </div>
          </div>
        </div>
      </CardContent>

      {isDirty && (
        <CardFooter className="p-0 pt-2 gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

function PreferencesSection() {
  const [preferences, setPreferences] = usePreferences();

  const handleNotificationsChange = async (checked: boolean) => {
    if (checked) {
      const result = await Notification.requestPermission();
      if (result !== "granted") {
        toast.error(
          "Notifications denied. Please enable them in your browser settings.",
        );
        setPreferences((prev) => ({ ...prev, enableNotifications: false }));
        return;
      }
    }
    setPreferences((prev) => ({ ...prev, enableNotifications: checked }));
  };

  const soundEvents: { key: SoundEventKey; label: string }[] = [
    { key: "completed", label: "Task completed" },
    { key: "failed", label: "Task failed" },
    { key: "requires_action", label: "Awaiting input" },
  ];

  return (
    <Card className="p-6">
      <CardHeader className="p-0">
        <CardTitle className="text-sm">Preferences</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col p-0">
        <PreferenceRow
          label="Theme"
          description="Your preferred color scheme."
          control={
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={preferences.theme}
              onValueChange={(value) => {
                if (value) {
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
        <PreferenceRow
          label="Notifications"
          description="Receive browser notifications for important events."
          disabled={typeof Notification === "undefined"}
          onClick={() =>
            handleNotificationsChange(!preferences.enableNotifications)
          }
          control={
            <Switch
              disabled={typeof Notification === "undefined"}
              checked={preferences.enableNotifications}
              onCheckedChange={handleNotificationsChange}
            />
          }
        />
        <PreferenceRow
          label="Sounds"
          description="Play sounds for agent actions and notifications."
          onClick={() =>
            setPreferences((prev) => ({
              ...prev,
              enableSounds: !prev.enableSounds,
            }))
          }
          control={
            <Switch
              checked={preferences.enableSounds}
              onCheckedChange={(checked) =>
                setPreferences((prev) => ({ ...prev, enableSounds: checked }))
              }
            />
          }
        />
        {preferences.enableSounds && (
          <div className="ml-4 mb-1 mt-0.5 rounded-lg border border-border/60 overflow-hidden divide-y divide-border/40">
            {soundEvents.map(({ key, label }) => (
              <div
                key={key}
                className="flex items-center gap-3 px-3 py-2 bg-sidebar/40"
              >
                <span className="text-xs text-muted-foreground flex-1">
                  {label}
                </span>
                <button
                  type="button"
                  aria-label={`Preview ${label} sound`}
                  onClick={() => {
                    const sound = SOUND_MAP[key];
                    if (sound) playSound(sound.dataUri).catch(() => {});
                  }}
                  className="size-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  <Play size={11} />
                </button>
                <Switch
                  checked={preferences.soundToggles[key]}
                  onCheckedChange={(checked) =>
                    setPreferences((prev) => ({
                      ...prev,
                      soundToggles: {
                        ...prev.soundToggles,
                        [key]: checked,
                      },
                    }))
                  }
                />
              </div>
            ))}
          </div>
        )}
        <PreferenceRow
          label="Tool Approval"
          description="Control how tools are approved before execution."
          control={
            <Select
              value={preferences.toolApprovalLevel}
              onValueChange={(value) =>
                setPreferences((prev) => ({
                  ...prev,
                  toolApprovalLevel: value as ToolApprovalLevel,
                }))
              }
            >
              <SelectTrigger className="w-36 h-7 text-xs">
                <span>
                  {{
                    readonly: "Ask before edit",
                    auto: "Auto approve",
                    plan: "Plan mode",
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
      </CardContent>
    </Card>
  );
}

export function ProfilePreferencesPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <div className="flex flex-col gap-6">
            <Page.Title>Profile & Preferences</Page.Title>
            <div className="flex flex-col gap-10">
              <ProfileSection />
              <PreferencesSection />
            </div>
          </div>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
