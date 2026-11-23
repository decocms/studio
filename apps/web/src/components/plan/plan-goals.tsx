/**
 * Plan goals at the top of Plan: the goal this member works toward, a picker
 * over every open goal of the organization, and the form to add one. Anyone
 * adds a goal or picks one; only a goal's creator or an admin rewords or
 * archives it, so nobody changes someone else's goal from under them.
 */

import { useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Archive,
  Check,
  ChevronSelectorVertical,
  Edit03,
  Plus,
  Target04,
  Users01,
} from "@untitledui/icons";
import { toast } from "sonner";
import {
  filterPlanGoals,
  groupPlanGoals,
  type PlanGoal,
  type PlanGoalSource,
} from "@decocms/shared/plan-goals";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@decocms/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { useDateFnsLocale } from "@/hooks/use-date-fns-locale.ts";
import { usePlanGoalActions, type PlanGoals } from "@/hooks/use-plan-goals";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { ObjectiveForm } from "./plan-objective.tsx";

/** Above this many goals the picker gets a search field. */
const SEARCH_FROM = 10;

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function GoalItem({
  goal,
  active,
  onSelect,
}: {
  goal: PlanGoal;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <CommandItem value={goal.id} onSelect={onSelect} className="items-start">
      <Check className={cn("mt-0.5 size-4 shrink-0", !active && "opacity-0")} />
      <span className="line-clamp-2 flex-1 text-sm">{goal.statement}</span>
      {goal.users > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          title={t("plan.goals.people")}
        >
          <Users01 className="size-3" />
          {goal.users}
        </span>
      )}
    </CommandItem>
  );
}

function GoalPicker({
  goals,
  active,
  onPick,
  onNew,
}: {
  goals: PlanGoal[];
  active: PlanGoal | null;
  onPick: (goal: PlanGoal) => void;
  onNew: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { yours, others } = groupPlanGoals(filterPlanGoals(goals, query));
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <ChevronSelectorVertical />
          {t("plan.goals.change")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] p-0">
        <Command shouldFilter={false}>
          {goals.length > SEARCH_FROM && (
            <CommandInput
              placeholder={t("plan.goals.search")}
              value={query}
              onValueChange={setQuery}
            />
          )}
          <CommandList className="max-h-[360px]">
            <CommandEmpty>{t("plan.goals.noMatch")}</CommandEmpty>
            {yours.length > 0 && (
              <CommandGroup heading={t("plan.goals.yours")}>
                {yours.map((goal) => (
                  <GoalItem
                    key={goal.id}
                    goal={goal}
                    active={goal.id === active?.id}
                    onSelect={() => {
                      close();
                      onPick(goal);
                    }}
                  />
                ))}
              </CommandGroup>
            )}
            {others.length > 0 && (
              <CommandGroup heading={t("plan.goals.others")}>
                {others.map((goal) => (
                  <GoalItem
                    key={goal.id}
                    goal={goal}
                    active={goal.id === active?.id}
                    onSelect={() => {
                      close();
                      onPick(goal);
                    }}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
          <CommandSeparator />
          <CommandGroup>
            <CommandItem
              value="__new"
              onSelect={() => {
                close();
                onNew();
              }}
            >
              <Plus className="size-4" />
              {t("plan.goals.new")}
            </CommandItem>
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type SimilarGoal = ToolOutput<"PLAN_GOAL_SIMILAR">["matches"][number];

/** The goals that already say what the person is about to add, before it is saved. */
function SimilarGoals({
  matches,
  disabled,
  onUse,
  onCreate,
}: {
  matches: SimilarGoal[];
  disabled: boolean;
  onUse: (goal: SimilarGoal) => void;
  onCreate: () => void;
}) {
  const t = useT();
  const locale = useDateFnsLocale();
  const people = (n: number) =>
    n === 0
      ? t("plan.goals.similar.peopleNone")
      : n === 1
        ? t("plan.goals.similar.peopleOne")
        : t("plan.goals.similar.peopleMany", { n });
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
      <p className="text-sm text-foreground">{t("plan.goals.similar.title")}</p>
      {matches.map((goal) => (
        <div key={goal.id} className="flex flex-col items-start gap-1.5">
          <p className="text-sm font-medium text-foreground italic">
            {goal.statement}
          </p>
          <p className="text-meta">
            {t("plan.goals.similar.meta", {
              when: formatDistanceToNow(new Date(goal.created_at), {
                addSuffix: true,
                locale,
              }),
              people: people(goal.users),
            })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onUse(goal)}
          >
            {t("plan.goals.similar.use")}
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onCreate}
        >
          {t("plan.goals.similar.createAnyway")}
        </Button>
      </div>
    </div>
  );
}

function ArchiveGoal({
  disabled,
  onArchive,
}: {
  disabled: boolean;
  onArchive: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <Archive />
          {t("plan.goals.archive")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("plan.goals.archiveConfirm.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("plan.goals.archiveConfirm.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("plan.goals.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onArchive}>
            {t("plan.goals.archiveConfirm.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PlanGoalsSection({ goals: state }: { goals: PlanGoals }) {
  const t = useT();
  const actions = usePlanGoalActions();
  const [mode, setMode] = useState<"view" | "create" | "edit">("view");
  /** The goal waiting on the person's answer to "use that one instead?". */
  const [similar, setSimilar] = useState<{
    statement: string;
    source: PlanGoalSource | null;
    matches: SimilarGoal[];
  } | null>(null);
  /** Only the latest duplicate check may go on to create; leaving moves this on. */
  const checks = useRef(0);
  const { goals, active } = state;
  const busy =
    actions.create.isPending ||
    actions.update.isPending ||
    actions.archive.isPending ||
    actions.pick.isPending;
  const creating =
    actions.similar.isPending ||
    actions.create.isPending ||
    actions.pick.isPending;

  const view = () => {
    checks.current++;
    setSimilar(null);
    setMode("view");
  };

  const create = (
    statement: string,
    source: PlanGoalSource | null,
    similarShown: boolean,
  ) =>
    actions.create.mutate(
      { statement, source, make_active: true },
      {
        onSuccess: () => {
          track("plan_goal_created", {
            found: source !== null,
            similar_shown: similarShown,
          });
          view();
        },
        onError: (error) =>
          toast.error(errorText(error, t("plan.goals.saveError"))),
      },
    );

  const save = (statement: string, source: PlanGoalSource | null) => {
    setSimilar(null);
    if (goals.length === 0) return create(statement, source, false);
    const check = ++checks.current;
    actions.similar.mutate(
      { statement },
      {
        onSuccess: ({ matches }) => {
          if (check !== checks.current) return;
          if (matches.length === 0) return create(statement, source, false);
          track("plan_goal_similar_shown", { matches: matches.length });
          setSimilar({ statement, source, matches });
        },
        // The check only helps; when it fails, the goal is created as asked.
        onError: () => {
          if (check === checks.current) create(statement, source, false);
        },
      },
    );
  };

  const pickExisting = (goal: SimilarGoal) =>
    actions.pick.mutate(
      { goal_id: goal.id },
      {
        onSuccess: () => {
          track("plan_goal_similar_used", { users: goal.users });
          view();
        },
        onError: (error) =>
          toast.error(errorText(error, t("plan.goals.pickError"))),
      },
    );

  const body = () => {
    if (state.isPending) {
      return <p className="h-8 animate-pulse rounded bg-muted" />;
    }
    if (goals.length === 0 || mode === "create") {
      return (
        <>
          {goals.length === 0 && (
            <p className="max-w-[560px] text-base text-pretty text-muted-foreground">
              {t("plan.goals.empty")}
            </p>
          )}
          <ObjectiveForm
            initial=""
            onDone={goals.length > 0 ? view : undefined}
            saving={creating}
            onSave={save}
          />
          {similar && (
            <SimilarGoals
              matches={similar.matches}
              disabled={creating}
              onUse={pickExisting}
              onCreate={() => create(similar.statement, similar.source, true)}
            />
          )}
        </>
      );
    }
    if (mode === "edit" && active) {
      return (
        <ObjectiveForm
          initial={active.statement}
          onDone={view}
          saving={actions.update.isPending}
          onSave={(statement) =>
            actions.update.mutate(
              { id: active.id, statement },
              {
                onSuccess: view,
                onError: (error) =>
                  toast.error(errorText(error, t("plan.goals.saveError"))),
              },
            )
          }
        />
      );
    }
    return (
      <div className="flex flex-col items-start gap-3">
        {active && (
          <p className="max-w-[720px] text-2xl leading-snug font-medium text-balance text-foreground">
            {active.statement}
          </p>
        )}
        {active?.source && (
          <p className="text-meta" title={active.source.quote}>
            {t("plan.goals.found", { source: active.source.label })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <GoalPicker
            goals={goals}
            active={active}
            onNew={() => setMode("create")}
            onPick={(goal) => {
              if (goal.id === active?.id) return;
              track("plan_goal_picked", { mine: goal.mine, users: goal.users });
              actions.pick.mutate(
                { goal_id: goal.id },
                {
                  onError: (error) =>
                    toast.error(errorText(error, t("plan.goals.pickError"))),
                },
              );
            }}
          />
          {active?.can_edit && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setMode("edit")}
              >
                <Edit03 />
                {t("plan.goals.edit")}
              </Button>
              <ArchiveGoal
                disabled={busy}
                onArchive={() =>
                  actions.archive.mutate(
                    { id: active.id },
                    {
                      onError: (error) =>
                        toast.error(
                          errorText(error, t("plan.goals.archiveError")),
                        ),
                    },
                  )
                }
              />
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Target04 size={13} />
        {t("plan.goals.eyebrow")}
      </div>
      {body()}
    </section>
  );
}
