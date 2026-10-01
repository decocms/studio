/** A column's rules, edited from the strip above its lane header. */

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Stars02, XClose, Zap } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
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

export function ColumnRulesStrip({
  columnKey,
  label,
}: {
  columnKey: string;
  label: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
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
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("taskBoard.columnRules.editAriaLabel", { lane: label })}
        // Same px-2 / gap-2 / 15px glyph as the lane header, so the icon and text line up with it.
        className={cn(
          "flex h-7 min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
          !configured &&
            "opacity-0 group-hover/lane:opacity-100 focus-visible:opacity-100",
        )}
      >
        {configured ? (
          <>
            {automation ? (
              <Zap size={15} className="shrink-0 fill-current text-special" />
            ) : (
              <Stars02 size={15} className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{summary}</span>
            {showSkillCount && (
              <span className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium">
                <Stars02 size={11} />
                {skillCount}
              </span>
            )}
          </>
        ) : (
          <>
            <Plus size={15} className="shrink-0" />
            <span className="truncate">{t("taskBoard.columnRules.add")}</span>
          </>
        )}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>
              {t("taskBoard.columnRules.sheetDescription")}
            </SheetDescription>
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

  const submit = () =>
    save.mutate(
      { columnKey, prompt, skills, automation: run ? automation : null },
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
      <div className="flex min-h-0 flex-1 flex-col divide-y overflow-y-auto px-4">
        <section className="flex flex-col gap-3 py-4">
          <label className="flex items-start gap-3">
            <span className="flex-1">
              <span className="block text-sm font-medium">
                {t("taskBoard.columnRules.runLabel")}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
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
        <section className="flex flex-col gap-2 py-4">
          <SectionTitle>{t("taskBoard.columnRules.promptLabel")}</SectionTitle>
          <Textarea
            value={prompt}
            rows={5}
            maxLength={TASK_SYSTEM_PROMPT_MAX_LENGTH}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("taskBoard.columnRules.promptPlaceholder")}
            aria-label={t("taskBoard.columnRules.promptLabel")}
          />
          <p className="text-xs text-muted-foreground">
            {t("taskBoard.columnRules.promptHint")}
          </p>
        </section>
        <section className="flex flex-col gap-2 py-4">
          <SectionTitle>{t("taskBoard.columnRules.skillsLabel")}</SectionTitle>
          <SkillsField
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
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

const NO_SKILLS: string[] = [];

/** Skill chips and catalog picker; `inherited` shows read-only. */
export function SkillsField({
  value,
  onChange,
  inherited = NO_SKILLS,
}: {
  value: string[];
  onChange: (skills: string[]) => void;
  inherited?: string[];
}) {
  const t = useT();
  const catalog = useOrgFsSkillCatalog();
  const nameOf = (id: string) =>
    catalog.data?.find((s) => s.id === id)?.name ?? id;
  const options = (catalog.data ?? []).filter(
    (s) => !value.includes(s.id) && !inherited.includes(s.id),
  );

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span
              key={id}
              className="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs"
            >
              {nameOf(id)}
              <button
                type="button"
                aria-label={t("taskBoard.columnRules.removeSkill", {
                  skill: nameOf(id),
                })}
                onClick={() => onChange(value.filter((s) => s !== id))}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XClose size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Command className="h-auto rounded-lg border">
        <CommandInput
          placeholder={t("taskBoard.columnRules.searchSkills")}
          className="h-9"
        />
        <CommandList className="max-h-56">
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
                    <span className="line-clamp-1 text-xs text-muted-foreground">
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
          <p className="text-xs text-muted-foreground">
            {t("taskBoard.columnRules.inheritedHint")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {inherited.map((id) => (
              <span
                key={id}
                className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {nameOf(id)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
