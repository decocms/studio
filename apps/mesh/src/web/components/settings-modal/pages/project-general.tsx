import { ProjectGeneralForm } from "@/web/components/settings/project-general-form";
import { DangerZone } from "@/web/components/settings/danger-zone";

export function ProjectGeneralPage() {
  return (
    <div className="flex flex-col">
      <p className="py-4 text-base font-semibold text-foreground border-b border-border">
        General
      </p>
      <div className="pt-6 flex flex-col gap-6">
        <ProjectGeneralForm />
        <DangerZone />
      </div>
    </div>
  );
}
