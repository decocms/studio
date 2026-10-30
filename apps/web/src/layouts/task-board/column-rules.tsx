/**
 * How a column works, opened from its lane header: what the column is for,
 * what runs when a card lands in it, and the instructions and skills every
 * run there gets. One place for a column's behaviour, so the automation page
 * and Settings → Tasks are where you go deeper, not where you start.
 */

import { useState, type ComponentType } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Plus, User01, XClose, Zap } from "@untitledui/icons";
import { TASK_SYSTEM_PROMPT_MAX_LENGTH } from "@decocms/shared/task-board";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useOrgFsSkillCatalog } from "@/hooks/use-org-fs";
import { useProjectScope } from "@/hooks/use-project-scope";
import {
  useSaveColumnRules,
  useTaskBoardPrompts,
} from "@/hooks/use-task-board-prompts";
import { getDecopilotId, useProjectContext } from "@/sdk";
import {
  useAutomationActions,
  useAutomations,
  type AutomationListItem,
} from "@/hooks/use-automations";
import { useT } from "@/i18n/use-t.ts";
import { ACTOR_LABEL, columnGuide } from "./column-guide";

/** A column's saved instructions and skills, and the board-wide skills. */
function useColumnRules(columnKey: string) {
  const prompts = useTaskBoardPrompts();
  return {
    scope: prompts.data?.find((p) => p.columnKey === columnKey),
    boardSkills: prompts.data?.find((p) => p.columnKey === null)?.skills ?? [],
  };
}

/** The automations a card dropped in `columnKey` starts: the ones with a
 *  "card enters a column" starter there. */
export function useEntryAutomations(columnKey: string) {
  const { data } = useAutomations();
  return (data ?? []).filter((a) =>
    a.board_triggers.some(
      (t) => t.type === "board_column_transition" && t.column_key === columnKey,
    ),
  );
}

/** Every automation with a board starter on `columnKey`, whatever starts it. */
export function useColumnAutomations(columnKey: string) {
  const { data } = useAutomations();
  return (data ?? []).filter((a) =>
    a.board_triggers.some((t) => t.column_key === columnKey),
  );
}

/** What the column is for and when a person steps in. */
function ColumnGuide({ columnKey }: { columnKey: string }) {
  const t = useT();
  const guide = columnGuide(columnKey);
  if (!guide) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t(guide.purpose)}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={guide.actor === "agent" ? "agent" : "muted"}>
          {t(ACTOR_LABEL[guide.actor])}
        </Badge>
      </div>
      {guide.human && (
        <div className="surface-inset flex gap-2 rounded-lg px-3 py-2">
          <User01 size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
          <p className="text-sm text-foreground">
            <span className="text-muted-foreground">
              {t("taskBoard.columnRules.whenHuman")}:{" "}
            </span>
            {t(guide.human)}
          </p>
        </div>
      )}
    </div>
  );
}

function starterLabelKey(automation: AutomationListItem, columnKey: string) {
  const starter = automation.board_triggers.find(
    (s) => s.column_key === columnKey,
  );
  const type = starter?.type ?? "board_column_transition";
  switch (type) {
    case "board_pr_ready":
      return "taskBoard.columnRules.starter.board_pr_ready" as const;
    case "board_pr_merged":
      return "taskBoard.columnRules.starter.board_pr_merged" as const;
    case "board_column_transition":
      return "taskBoard.columnRules.starter.board_column_transition" as const;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/** What runs on cards landing here, each with its switch, plus a new one
 *  already bound to this column in the board's project. */
function ColumnAutomations({
  columnKey,
  label,
  onLeave,
}: {
  columnKey: string;
  label: string;
  onLeave: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const { project } = useProjectScope();
  const navigate = useNavigate();
  const automations = useColumnAutomations(columnKey);
  const { update, create, triggerAdd } = useAutomationActions();
  const [creating, setCreating] = useState(false);
  const agentId = project?.id ?? getDecopilotId(org.id);

  const createBound = async () => {
    setCreating(true);
    try {
      const created = await create.mutateAsync({
        name: t("taskBoard.columnRules.newAutomationName", { column: label }),
        messages: [],
        models: { tier: "smart" },
        active: false,
        virtual_mcp_id: agentId,
      });
      await triggerAdd.mutateAsync({
        automation_id: created.id,
        type: "board_column_transition",
        column_key: columnKey,
      });
      onLeave();
      navigate({
        to: "/$org/projects/$agentId/automations/$automationId",
        params: { org: org.slug, agentId, automationId: created.id },
      });
    } catch {
      toast.error(t("taskBoard.columnRules.newAutomationFailed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{t("taskBoard.columnRules.onEnterLabel")}</SectionTitle>
      {automations.length === 0 && (
        <p className="text-meta">{t("taskBoard.columnRules.noAutomations")}</p>
      )}
      {automations.length > 0 && (
        <div className="surface divide-y divide-border">
          {automations.map((automation) => (
            <div
              key={automation.id}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <Zap
                size={14}
                className={cn(
                  "shrink-0",
                  automation.active
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              />
              <Link
                to="/$org/projects/$agentId/automations/$automationId"
                params={{
                  org: org.slug,
                  agentId: automation.virtual_mcp_id,
                  automationId: automation.id,
                }}
                onClick={onLeave}
                className="flex min-w-0 flex-1 flex-col hover:underline"
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-foreground">
                    {automation.name}
                  </span>
                  {automation.system_key && (
                    <Badge variant="muted">
                      {t("automations.builtin.badge")}
                    </Badge>
                  )}
                </span>
                <span className="text-meta">
                  {t(starterLabelKey(automation, columnKey))}
                </span>
              </Link>
              <Switch
                checked={automation.active}
                disabled={update.isPending}
                onCheckedChange={(active) =>
                  update.mutate({ id: automation.id, active })
                }
                aria-label={t("taskBoard.columnRules.toggleAutomation", {
                  name: automation.name,
                })}
              />
            </div>
          ))}
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        className="w-fit gap-1.5"
        disabled={creating}
        onClick={createBound}
      >
        <Plus size={14} />
        {t("taskBoard.columnRules.newAutomation")}
      </Button>
    </section>
  );
}

export function ColumnRulesSheet({
  columnKey,
  label,
  icon: Icon,
  iconClassName,
  open,
  onOpenChange: setOpen,
}: {
  columnKey: string;
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  iconClassName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { scope, boardSkills } = useColumnRules(columnKey);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        className="w-full gap-0 sm:max-w-lg"
        aria-describedby={undefined}
      >
        <SheetHeader className="gap-3 border-b">
          <SheetTitle className="flex items-center gap-2">
            {Icon && <Icon size={16} className={iconClassName} />}
            {label}
          </SheetTitle>
          <ColumnGuide columnKey={columnKey} />
        </SheetHeader>
        <ColumnRulesForm
          columnKey={columnKey}
          label={label}
          initial={{
            prompt: scope?.prompt ?? "",
            skills: scope?.skills ?? [],
          }}
          boardSkills={boardSkills}
          onDone={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

/** Mounted per open, so the draft reseeds from saved rules. */
function ColumnRulesForm({
  columnKey,
  label,
  initial,
  boardSkills,
  onDone,
}: {
  columnKey: string;
  label: string;
  initial: {
    prompt: string;
    skills: string[];
  };
  boardSkills: string[];
  onDone: () => void;
}) {
  const t = useT();
  const save = useSaveColumnRules();
  const [prompt, setPrompt] = useState(initial.prompt);
  const [skills, setSkills] = useState(initial.skills);
  const dirty =
    prompt !== initial.prompt ||
    skills.join("\n") !== initial.skills.join("\n");

  const submit = () =>
    save.mutate(
      { columnKey, ...(dirty ? { rules: { prompt, skills } } : {}) },
      {
        onSuccess: () => {
          toast.success(t("taskBoard.columnRules.saved"));
          onDone();
        },
        onError: (err) =>
          toast.error(
            err instanceof Error
              ? err.message
              : t("taskBoard.columnRules.failed"),
          ),
      },
    );

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-4">
        <ColumnAutomations
          columnKey={columnKey}
          label={label}
          onLeave={onDone}
        />
        <section className="flex flex-col gap-2">
          <SectionTitle>{t("taskBoard.columnRules.promptLabel")}</SectionTitle>
          <Textarea
            value={prompt}
            rows={6}
            maxLength={TASK_SYSTEM_PROMPT_MAX_LENGTH}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("taskBoard.columnRules.promptPlaceholder")}
            aria-label={t("taskBoard.columnRules.promptLabel")}
          />
        </section>
        <section className="flex min-h-64 flex-1 flex-col gap-2">
          <SectionTitle>{t("taskBoard.columnRules.skillsLabel")}</SectionTitle>
          <SkillsField
            fill
            value={skills}
            onChange={setSkills}
            inherited={boardSkills}
          />
        </section>
      </div>
      <SheetFooter className="flex-row justify-end border-t">
        <Button variant="outline" onClick={onDone}>
          {t("taskBoard.columnRules.cancel")}
        </Button>
        <Button disabled={save.isPending || !dirty} onClick={submit}>
          {t("taskBoard.columnRules.save")}
        </Button>
      </SheetFooter>
    </>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-sm font-medium text-foreground">{children}</h3>;
}

const NO_SKILLS: string[] = [];

/** Skill chips and catalog picker; `inherited` shows read-only. */
export function SkillsField({
  value,
  onChange,
  inherited = NO_SKILLS,
  fill = false,
}: {
  value: string[];
  onChange: (skills: string[]) => void;
  inherited?: string[];
  /** Grow the picker into the parent's free height instead of a fixed cap. */
  fill?: boolean;
}) {
  const t = useT();
  const catalog = useOrgFsSkillCatalog();
  const nameOf = (id: string) =>
    catalog.data?.find((s) => s.id === id)?.name ?? id;
  // A run can't load a manual-only skill, so a rule can't ask for one.
  const options = (catalog.data ?? []).filter(
    (s) =>
      !s.disableModelInvocation &&
      !value.includes(s.id) &&
      !inherited.includes(s.id),
  );
  // Already shown as inherited below; don't render it twice.
  const ownValue = value.filter((id) => !inherited.includes(id));

  return (
    <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
      {ownValue.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ownValue.map((id) => (
            <Badge key={id} variant="outline" className="py-0 pr-0 pl-2">
              {nameOf(id)}
              <IconButton
                label={t("taskBoard.columnRules.removeSkill", {
                  skill: nameOf(id),
                })}
                onClick={() => onChange(value.filter((s) => s !== id))}
                className="size-5 text-muted-foreground"
              >
                <XClose size={12} />
              </IconButton>
            </Badge>
          ))}
        </div>
      )}
      <Command className={cn("h-auto border", fill && "min-h-0 flex-1")}>
        <CommandInput
          placeholder={t("taskBoard.columnRules.searchSkills")}
          className="h-9"
        />
        <CommandList className={cn(fill ? "max-h-none flex-1" : "max-h-56")}>
          <CommandEmpty>{t("taskBoard.columnRules.noSkills")}</CommandEmpty>
          <CommandGroup>
            {options.map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.name} ${s.id}`}
                onSelect={() => onChange([...value, s.id])}
              >
                <Plus size={14} className="shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{s.name}</span>
                  {s.description && (
                    <span className="text-meta line-clamp-1">
                      {s.description}
                    </span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
      {inherited.length > 0 && (
        <>
          <p className="text-meta">
            {t("taskBoard.columnRules.inheritedHint")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {inherited.map((id) => (
              <Badge key={id} variant="muted">
                {nameOf(id)}
              </Badge>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
