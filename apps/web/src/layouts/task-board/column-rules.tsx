/** A column's rules, edited from the icon in its lane header. */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Plus, XClose } from "@untitledui/icons";
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
import {
  LANES,
  TASK_SYSTEM_PROMPT_MAX_LENGTH,
} from "@decocms/shared/task-board";
import { useOrgFsSkillCatalog } from "@/hooks/use-org-fs";
import {
  useSaveColumnRules,
  useTaskBoardPrompts,
} from "@/hooks/use-task-board-prompts";
import { getDecopilotId, useProjectContext } from "@/sdk";
import { useAutomationActions, useAutomations } from "@/hooks/use-automations";
import { useT } from "@/i18n/use-t.ts";

/** A column's saved instructions and skills, and the board-wide skills. */
function useColumnRules(columnKey: string) {
  const prompts = useTaskBoardPrompts();
  return {
    scope: prompts.data?.find((p) => p.columnKey === columnKey),
    boardSkills: prompts.data?.find((p) => p.columnKey === null)?.skills ?? [],
  };
}

/** The automations whose "card enters a column" starter watches `columnKey`:
 *  the ones a card dropped there starts. */
export function useEntryAutomations(columnKey: string) {
  const { data } = useAutomations();
  return (data ?? []).filter((a) => a.board_columns.includes(columnKey));
}

/** Every automation that runs on cards in `columnKey`: the entry ones, and on
 *  In Review the ones that review a card's pull request once it is ready. */
function useColumnAutomations(columnKey: string) {
  const { data } = useAutomations();
  return (data ?? []).filter(
    (a) =>
      a.board_columns.includes(columnKey) ||
      (columnKey === LANES.review && a.reviews_prs),
  );
}

/** Each automation that runs on cards landing in the column, with its switch. */
function ColumnAutomations({ columnKey }: { columnKey: string }) {
  const t = useT();
  const { org } = useProjectContext();
  const automations = useColumnAutomations(columnKey);
  const { update } = useAutomationActions();

  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{t("taskBoard.columnRules.automationsLabel")}</SectionTitle>
      {automations.map((automation) => (
        <div
          key={automation.id}
          className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
        >
          <Link
            to="/$org/projects/$agentId/automations/$automationId"
            params={{
              org: org.slug,
              agentId: automation.virtual_mcp_id,
              automationId: automation.id,
            }}
            className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground hover:underline"
          >
            <span className="truncate">{automation.name}</span>
            {automation.system_key && (
              <Badge variant="muted">{t("automations.builtin.badge")}</Badge>
            )}
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
      <p className="text-meta">
        {automations.length === 0 && (
          <>{t("taskBoard.columnRules.noAutomations")} </>
        )}
        <Link
          to="/$org/projects/$agentId/automations"
          params={{ org: org.slug, agentId: getDecopilotId(org.id) }}
          className="text-foreground underline underline-offset-2"
        >
          {t("taskBoard.columnRules.addAutomation")}
        </Link>
      </p>
    </section>
  );
}

export function ColumnRulesSheet({
  columnKey,
  label,
  open,
  onOpenChange: setOpen,
}: {
  columnKey: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { scope, boardSkills } = useColumnRules(columnKey);

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          className="w-full gap-0 sm:max-w-md"
          aria-describedby={undefined}
        >
          <SheetHeader className="border-b">
            <SheetTitle>{label}</SheetTitle>
          </SheetHeader>
          <ColumnRulesForm
            columnKey={columnKey}
            initial={{
              prompt: scope?.prompt ?? "",
              skills: scope?.skills ?? [],
            }}
            boardSkills={boardSkills}
            onDone={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Mounted per open, so the draft reseeds from saved rules. */
function ColumnRulesForm({
  columnKey,
  initial,
  boardSkills,
  onDone,
}: {
  columnKey: string;
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

  const submit = () =>
    save.mutate(
      {
        columnKey,
        ...(prompt !== initial.prompt ||
        skills.join("\n") !== initial.skills.join("\n")
          ? { rules: { prompt, skills } }
          : {}),
      },
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
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        <ColumnAutomations columnKey={columnKey} />
        <section className="flex flex-col gap-2">
          <SectionTitle>{t("taskBoard.columnRules.promptLabel")}</SectionTitle>
          <Textarea
            value={prompt}
            rows={5}
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
        <Button disabled={save.isPending} onClick={submit}>
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

  return (
    <div className={cn("flex flex-col gap-2", fill && "min-h-0 flex-1")}>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
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
