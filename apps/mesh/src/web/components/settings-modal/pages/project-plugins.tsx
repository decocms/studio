import { ProjectPluginsForm } from "@/web/components/settings/project-plugins-form";

export function ProjectPluginsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">Features</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Extend your project with built-in capabilities that activate
          automatically on any connection that supports them.
        </p>
      </div>
      <ProjectPluginsForm />
    </div>
  );
}
