import { ProjectPluginsForm } from "@/web/components/settings/project-plugins-form";

export function ProjectPluginsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Plugins</h2>
      </div>
      <ProjectPluginsForm />
    </div>
  );
}
