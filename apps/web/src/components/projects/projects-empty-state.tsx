/**
 * The org home with nothing in it.
 *
 * This is the first thing a new org sees, and for most of them the only screen
 * they see before they decide whether this product is for them. So it is not a
 * notice that a list is empty — it is the invitation, with the one control that
 * matters and nothing else competing for the click.
 *
 * The drawing carries it: a storefront, an app and a price tag, which is
 * exactly the vocabulary the creation dialog opens with. Someone who clicks
 * through finds the same three objects again as cards, which is the whole point
 * of drawing them here rather than reaching for a generic box-with-a-plus.
 *
 * It centres itself in whatever space it is given rather than sitting at the
 * top of an empty column: with nothing else on the page there is no reading
 * order for it to lead, and pinned to the top it reads as the first item of a
 * list that never arrives. `flex-1` does that exactly wherever the parent is a
 * flex column with a height; the `min-h` is the floor for the parents that are
 * not, so it can never collapse to the height of its own art.
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
