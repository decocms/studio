/**
 * The org home with nothing in it — an invitation, not a notice that a list is
 * empty. The drawing is the creation dialog's own vocabulary, so someone who
 * clicks through meets the same three objects again as cards.
 *
 * `flex-1` centres it wherever the parent is a flex column with a height; the
 * `min-h` is the floor for the parents that are not.
 */

import { EmptyProjectsArt } from "@/components/projects/project-art";
import { NewProjectButton } from "@/components/projects/new-project-dialog";
import { useT } from "@/i18n/use-t.ts";

export function ProjectsEmptyState({ canCreate }: { canCreate: boolean }) {
  const t = useT();
  return (
    <section
      data-testid="projects-empty-state"
      className="flex min-h-[60svh] flex-1 flex-col items-center justify-center gap-8 py-10 text-center animate-in fade-in-0 slide-in-from-bottom-2 duration-500 motion-reduce:animate-none"
    >
      <div className="relative flex w-full max-w-sm items-center justify-center">
        {/* A single soft light behind the scene, so the line work reads as
            lit rather than as floating on a flat page. */}
        <div
          aria-hidden
          className="absolute size-56 rounded-full bg-primary/10 blur-3xl"
        />
        <EmptyProjectsArt className="relative w-full text-foreground/70" />
      </div>

      <div className="flex max-w-md flex-col items-center gap-2">
        <h2 className="text-xl font-medium tracking-tight text-foreground">
          {t("projects.empty.title")}
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {canCreate
            ? t("projects.empty.description")
            : t("projects.empty.readOnly")}
        </p>
      </div>

      {canCreate && <NewProjectButton source="org_home_empty" size="default" />}
    </section>
  );
}
