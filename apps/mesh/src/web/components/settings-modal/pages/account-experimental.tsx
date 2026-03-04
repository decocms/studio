import { Switch } from "@deco/ui/components/switch.tsx";
import { Folder } from "@untitledui/icons";
import { usePreferences } from "@/web/hooks/use-preferences.ts";

function ExperimentalRow({
  icon,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-6 py-4 border-b border-border last:border-0 cursor-pointer"
      onClick={() => onCheckedChange(!checked)}
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
        <Switch checked={checked} onCheckedChange={onCheckedChange} />
      </div>
    </div>
  );
}

export function AccountExperimentalPage() {
  const [preferences, setPreferences] = usePreferences();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Experimental
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          These features are unstable and may change or stop working at any
          time.
        </p>
      </div>

      <div className="flex flex-col rounded-lg border border-border bg-muted/25 px-4">
        <ExperimentalRow
          icon={<Folder size={16} />}
          label="Projects"
          description="Enable the projects feature in the sidebar."
          checked={preferences.experimental_projects}
          onCheckedChange={(checked) =>
            setPreferences((prev) => ({
              ...prev,
              experimental_projects: checked,
            }))
          }
        />
      </div>
    </div>
  );
}
