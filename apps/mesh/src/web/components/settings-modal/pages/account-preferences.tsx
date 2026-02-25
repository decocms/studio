import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { Bell01, Code01 } from "@untitledui/icons";
import { usePreferences } from "@/web/hooks/use-preferences.ts";
import { toast } from "@deco/ui/components/sonner.js";

function SettingRow({
  icon,
  label,
  description,
  control,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  control: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-6 py-4 border-b border-border last:border-0"
      onClick={disabled ? undefined : onClick}
      role={onClick ? "button" : undefined}
      style={{ cursor: onClick && !disabled ? "pointer" : undefined }}
    >
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
      </div>
      <div onClick={(e) => e.stopPropagation()} className="shrink-0">
        {control}
      </div>
    </div>
  );
}

export function AccountPreferencesPage() {
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Preferences</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Customize how the app works for you.
        </p>
      </div>

      <div className="flex flex-col">
        <SettingRow
          icon={<Code01 size={16} />}
          label="Developer Mode"
          description="Show technical details like JSON input/output for tool calls."
          onClick={() =>
            setPreferences((prev) => ({ ...prev, devMode: !prev.devMode }))
          }
          control={
            <Switch
              checked={preferences.devMode}
              onCheckedChange={(checked) =>
                setPreferences((prev) => ({ ...prev, devMode: checked }))
              }
            />
          }
        />
        <SettingRow
          icon={<Bell01 size={16} />}
          label="Notifications"
          description="Play a sound and show a notification when chat messages complete while the app is unfocused."
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
      </div>

      <div className="flex flex-col gap-2 pt-2 border-t border-border">
        <div>
          <p className="text-sm font-medium text-foreground">Tool Approval</p>
          <p className="text-xs text-muted-foreground mt-1">
            Choose when to require approval before tools execute.
          </p>
        </div>
        <Select
          value={preferences.toolApprovalLevel}
          onValueChange={(value) =>
            setPreferences((prev) => ({
              ...prev,
              toolApprovalLevel: value as "none" | "readonly" | "yolo",
            }))
          }
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">None</span>
                <span className="text-xs text-muted-foreground">
                  Require approval for all tool calls
                </span>
              </div>
            </SelectItem>
            <SelectItem value="readonly">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">Read-only</span>
                <span className="text-xs text-muted-foreground">
                  Auto-approve read-only tools
                </span>
              </div>
            </SelectItem>
            <SelectItem value="yolo">
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">YOLO</span>
                <span className="text-xs text-muted-foreground">
                  Execute all tools without approval
                </span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
