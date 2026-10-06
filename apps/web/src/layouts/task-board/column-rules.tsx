/** A column's rules, edited from the strip above its lane header. */

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Stars02, XClose, Zap } from "@untitledui/icons";
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
import { TASK_SYSTEM_PROMPT_MAX_LENGTH } from "@decocms/shared/task-board";
import { useOrgFsSkillCatalog } from "@/hooks/use-org-fs";
import {
  useSaveColumnRules,
  useTaskBoardColumnAutomations,
  useTaskBoardPrompts,
} from "@/hooks/use-task-board-prompts";
import { useT } from "@/i18n/use-t.ts";

/** Whether the column has rules; an unconfigured one is added from the lane header instead. */
export function useColumnConfigured(columnKey: string) {
  const prompts = useTaskBoardPrompts();
  const automations = useTaskBoardColumnAutomations();
  return (
    !!automations.data?.some((a) => a.columnKey === columnKey) ||
    !!prompts.data?.some((p) => p.columnKey === columnKey)
  );
}

export function ColumnRulesStrip({
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
  const t = useT();
  const prompts = useTaskBoardPrompts();
  const automations = useTaskBoardColumnAutomations();
  const scope = prompts.data?.find((p) => p.columnKey === columnKey);
  const automation = automations.data?.find((a) => a.columnKey === columnKey);
  const skillCount = scope?.skills.length ?? 0;
  const configured = !!automation || !!scope;
  const summary =
    automation?.prompt ||
    scope?.prompt ||
    (automation
      ? t("taskBoard.columnRules.defaultRun")
      : t("taskBoard.columnRules.skillsOnly", { count: skillCount }));
  // A skills-only rule already says the count in its summary.
  const showSkillCount = skillCount > 0 && (!!automation || !!scope?.prompt);

  return (
    <>
      {configured && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("taskBoard.columnRules.editAriaLabel", { lane: label })}
          // Same px-2 / gap-2 / 15px glyph as the lane header, so the icon and text line up with it.
          className="flex h-7 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {automation ? (
            <Zap size={15} className="shrink-0 fill-current text-special" />
          ) : (
            <Stars02 size={15} className="shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{summary}</span>
          {showSkillCount && (
            <span className="flex shrink-0 items-center gap-0.5 text-2xs font-medium">
              <Stars02 size={11} />
              {skillCount}
            </span>
          )}
        </button>
      )}
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
              run: !!automation,
              automation: automation?.prompt ?? "",
              prompt: scope?.prompt ?? "",
              skills: scope?.skills ?? [],
            }}
            boardSkills={
              prompts.data?.find((p) => p.columnKey === null)?.skills ?? []
            }
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
    run: boolean;
    automation: string;
    prompt: string;
    skills: string[];
  };
  boardSkills: string[];
  onDone: () => void;
}) {
  const t = useT();
  const save = useSaveColumnRules();
  const [run, setRun] = useState(initial.run);
  const [automation, setAutomation] = useState(initial.automation);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [skills, setSkills] = useState(initial.skills);

  const nextAutomation = run ? automation : null;
  const initialAutomation = initial.run ? initial.automation : null;
  const submit = () =>
    save.mutate(
      {
        columnKey,
        ...(prompt !== initial.prompt ||
        skills.join("\n") !== initial.skills.join("\n")
          ? { rules: { prompt, skills } }
          : {}),
        ...(nextAutomation !== initialAutomation
          ? { automation: nextAutomation }
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
        <section className="flex flex-col gap-2">
          <label className="flex items-start gap-3">
            <span className="flex-1">
              <span className="block text-sm font-medium text-foreground">
                {t("taskBoard.columnRules.runLabel")}
              </span>
              <span className="text-meta mt-0.5 block">
                {t("taskBoard.columnRules.runHint")}
              </span>
            </span>
            <Switch checked={run} onCheckedChange={setRun} />
          </label>
          {run && (
            <Textarea
              value={automation}
              rows={5}
              onChange={(e) => setAutomation(e.target.value)}
              placeholder={t("taskBoard.columnRules.automationPlaceholder")}
              aria-label={t("taskBoard.columnRules.automationLabel")}
            />
          )}
        </section>
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
