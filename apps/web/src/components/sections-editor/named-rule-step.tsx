import { createContext, useContext, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { MatcherIcon } from "./matcher-icons";
import type { CampaignWindow, NamedRuleKind } from "./named-rules";
import {
  isoToLocalInput,
  newNameProblem,
  type NamedRulePick,
  type NamedRulePickerKind,
  parseShareInput,
  windowFromInputs,
} from "./named-rule-picker";

/** Icons the built-ins declare in their schema (`flask`, `calendar-event`). */
const NAMED_RULE_ICON: Record<NamedRuleKind, string> = {
  experiments: "flask",
  campaigns: "calendar-event",
};

/**
 * Where the site's tests and campaigns are managed: the Experiments tab and
 * the Campaigns view. The content browser provides it; without it (another
 * surface) the rows show no link.
 */
export interface NamedRuleViews {
  open: (kind: NamedRuleKind) => void;
}

const NamedRuleViewsContext = createContext<NamedRuleViews | null>(null);

export function NamedRuleViewsProvider({
  value,
  children,
}: {
  value: NamedRuleViews;
  children: ReactNode;
}) {
  return (
    <NamedRuleViewsContext.Provider value={value}>
      {children}
    </NamedRuleViewsContext.Provider>
  );
}

function useNamedRuleViews(): NamedRuleViews | null {
  return useContext(NamedRuleViewsContext);
}

/**
 * What a variant inside a form field needs for named rules: the kinds the
 * picker offers, and `prepare`, which saves a new name's block (guarded) and
 * gives the rule to put in the field, or `null` when nothing should change.
 * The sections editor provides it; without it the field's picker is as
 * before.
 */
export interface NamedRuleFieldSupport {
  kinds: NamedRulePickerKind[];
  prepare: (pick: NamedRulePick) => Promise<Record<string, unknown> | null>;
  /**
   * Makes sure the kind's block exists before a field points at it (an empty
   * one is saved, guarded, when there is none). `false`: nothing to point at.
   */
  ensureBlock: (kind: NamedRuleKind) => Promise<boolean>;
}

const NamedRuleFieldContext = createContext<NamedRuleFieldSupport | null>(null);

export const NamedRuleFieldProvider = NamedRuleFieldContext.Provider;

export function useNamedRuleFieldSupport(): NamedRuleFieldSupport | null {
  return useContext(NamedRuleFieldContext);
}

/** The picker's first list: "A/B test" and "Date", one item per kind. */
export function NamedRuleKindItems({
  kinds,
  currentKind,
  onOpen,
}: {
  kinds: NamedRulePickerKind[];
  currentKind: NamedRuleKind | null;
  onOpen: (kind: NamedRuleKind) => void;
}) {
  const t = useT();
  return (
    <>
      {kinds.map(({ kind }) => {
        const title =
          kind === "experiments"
            ? t("sectionsEditor.namedRulePicker.abTestTitle")
            : t("sectionsEditor.namedRulePicker.dateTitle");
        const description =
          kind === "experiments"
            ? t("sectionsEditor.namedRulePicker.abTestDescription")
            : t("sectionsEditor.namedRulePicker.dateDescription");
        return (
          <CommandItem
            key={kind}
            value={`${title} ${description}`}
            onSelect={() => onOpen(kind)}
            className={cn("gap-2.5", currentKind === kind && "bg-accent/60")}
          >
            <MatcherIcon iconName={NAMED_RULE_ICON[kind]} size="sm" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">{title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {description}
              </span>
            </div>
          </CommandItem>
        );
      })}
    </>
  );
}

/**
 * Second step: the kind's names, and "+ Create" for what's typed. Lives in
 * the same command dialog as the rule list.
 */
export function NamedRuleNameStep({
  kind,
  currentName,
  onBack,
  onPick,
  onCreate,
}: {
  kind: NamedRulePickerKind;
  currentName: string | null;
  onBack: () => void;
  onPick: (name: string) => void;
  onCreate: (name: string) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const tests = kind.kind === "experiments";
  const typed = search.trim();
  const names = kind.entries.map((e) => e.name);
  const canCreate =
    kind.state !== "conflict" && newNameProblem(typed, names) === null;

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          {t("sectionsEditor.namedRulePicker.back")}
        </Button>
      </div>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={
          tests
            ? t("sectionsEditor.namedRulePicker.searchTests")
            : t("sectionsEditor.namedRulePicker.searchCampaigns")
        }
      />
      <CommandList>
        {kind.state === "conflict" ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {tests
              ? t("sectionsEditor.namedRulePicker.conflictTests")
              : t("sectionsEditor.namedRulePicker.conflictCampaigns")}
          </p>
        ) : (
          <>
            {kind.entries.length === 0 && !typed && (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {tests
                  ? t("sectionsEditor.namedRulePicker.noTests")
                  : t("sectionsEditor.namedRulePicker.noCampaigns")}
              </p>
            )}
            {kind.entries.length > 0 && (
              <CommandGroup
                heading={
                  tests
                    ? t("sectionsEditor.namedRulePicker.testsHeading")
                    : t("sectionsEditor.namedRulePicker.campaignsHeading")
                }
              >
                {kind.entries.map((entry) => (
                  <CommandItem
                    key={entry.name}
                    value={`${entry.name} ${entry.summary}`}
                    onSelect={() => onPick(entry.name)}
                    className={cn(
                      "gap-2.5",
                      currentName === entry.name && "bg-accent/60",
                    )}
                  >
                    <MatcherIcon
                      iconName={NAMED_RULE_ICON[kind.kind]}
                      size="sm"
                    />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{entry.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {entry.summary ||
                          (tests
                            ? ""
                            : t(
                                "sectionsEditor.namedRulePicker.alwaysRunning",
                              ))}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {canCreate && (
              <CommandGroup forceMount>
                <CommandItem
                  forceMount
                  value={`__create__ ${typed}`}
                  onSelect={() => onCreate(typed)}
                  className="gap-2.5"
                >
                  <Plus className="size-4 text-muted-foreground" />
                  <span className="truncate text-sm">
                    {tests
                      ? t("sectionsEditor.namedRulePicker.createTest", {
                          name: typed,
                        })
                      : t("sectionsEditor.namedRulePicker.createCampaign", {
                          name: typed,
                        })}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </>
  );
}

/**
 * Third step, for a new name: a test's share (50 to start) or a campaign's
 * dates. Kept out of the command list's keyboard handling, so the inputs
 * behave as inputs.
 */
export function NamedRuleCreateForm({
  kind,
  initialName,
  existingNames,
  prefill,
  pending,
  submitLabel,
  onBack,
  onSubmit,
}: {
  kind: NamedRuleKind;
  initialName: string;
  existingNames: string[];
  /** A campaign's starting dates (an inline date rule being moved). */
  prefill?: CampaignWindow | null;
  pending?: boolean;
  /** The button's words; "Create and use" in the rule picker. */
  submitLabel?: string;
  onBack: () => void;
  onSubmit: (pick: NamedRulePick) => void;
}) {
  const t = useT();
  const tests = kind === "experiments";
  const [name, setName] = useState(initialName);
  const [share, setShare] = useState("50");
  const [start, setStart] = useState(isoToLocalInput(prefill?.start));
  const [end, setEnd] = useState(isoToLocalInput(prefill?.end));
  const [tried, setTried] = useState(false);

  const nameProblem = newNameProblem(name, existingNames);
  const shareValue = parseShareInput(share);
  const window = windowFromInputs(start, end);
  const valueProblem = tests
    ? shareValue === null
      ? t("sectionsEditor.namedRulePicker.shareInvalid")
      : null
    : "problem" in window
      ? t("sectionsEditor.namedRulePicker.endBeforeStart")
      : null;
  const nameMessage =
    nameProblem === "empty"
      ? t("sectionsEditor.namedRulePicker.nameEmpty")
      : nameProblem === "taken"
        ? t("sectionsEditor.namedRulePicker.nameTaken")
        : nameProblem === "reserved"
          ? t("sectionsEditor.namedRulePicker.nameReserved")
          : null;

  const submit = () => {
    setTried(true);
    if (nameProblem || valueProblem || pending) return;
    const trimmed = name.trim();
    if (tests) {
      onSubmit({
        kind: "experiments",
        name: trimmed,
        create: { share: shareValue! },
      });
    } else if ("window" in window) {
      onSubmit({
        kind: "campaigns",
        name: trimmed,
        create: { window: window.window },
      });
    }
  };

  return (
    // cmdk handles arrows and Enter on the whole dialog; the form keeps them.
    <form
      className="flex flex-col gap-4 p-4"
      onKeyDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center gap-2">
        <MatcherIcon iconName={NAMED_RULE_ICON[kind]} size="sm" />
        <h3 className="text-sm font-medium">
          {tests
            ? t("sectionsEditor.namedRulePicker.newTestTitle")
            : t("sectionsEditor.namedRulePicker.newCampaignTitle")}
        </h3>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="named-rule-name">
          {t("sectionsEditor.namedRulePicker.nameLabel")}
        </Label>
        <Input
          id="named-rule-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        {tried && nameMessage && (
          <p className="text-xs text-destructive">{nameMessage}</p>
        )}
      </div>
      {tests ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="named-rule-share">
            {t("sectionsEditor.namedRulePicker.shareLabel")}
          </Label>
          <Input
            id="named-rule-share"
            inputMode="numeric"
            value={share}
            onChange={(e) => setShare(e.target.value)}
            className="w-24"
          />
          <p className="text-xs text-muted-foreground">
            {t("sectionsEditor.namedRulePicker.shareHint")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="named-rule-start">
                {t("sectionsEditor.namedRulePicker.startLabel")}
              </Label>
              <Input
                id="named-rule-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="named-rule-end">
                {t("sectionsEditor.namedRulePicker.endLabel")}
              </Label>
              <Input
                id="named-rule-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("sectionsEditor.namedRulePicker.windowHint")}
          </p>
        </div>
      )}
      {tried && valueProblem && (
        <p className="text-xs text-destructive">{valueProblem}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {t("sectionsEditor.namedRulePicker.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {submitLabel ?? t("sectionsEditor.namedRulePicker.createAndUse")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Where a variant's rule names a test or campaign: the name, locked (it is
 * changed by picking another above), what it does now, and the way to the
 * Experiments tab or Campaigns view. A name that isn't there (deleted,
 * discarded, never created, typed by hand) says so, with the picker right
 * above and, when the picker can create it (`onCreate`), "Create it"; a date
 * rule still written with its own dates says what to do.
 */
export function NamedRuleRow({
  kind,
  name,
  summary,
  missing,
  inlineDate,
  onCreate,
}: {
  kind: NamedRuleKind;
  name: string;
  summary: string;
  missing: boolean;
  inlineDate?: boolean;
  /** Opens the form that creates the missing name. */
  onCreate?: () => void;
}) {
  const t = useT();
  const tests = kind === "experiments";
  const note = inlineDate
    ? t("sectionsEditor.namedRulePicker.inlineDate")
    : missing
      ? onCreate
        ? tests
          ? t("sectionsEditor.namedRulePicker.missingTest")
          : t("sectionsEditor.namedRulePicker.missingCampaign")
        : tests
          ? t("sectionsEditor.namedRulePicker.missingTestNoCreate")
          : t("sectionsEditor.namedRulePicker.missingCampaignNoCreate")
      : tests
        ? t("sectionsEditor.namedRulePicker.testRowHint")
        : t("sectionsEditor.namedRulePicker.campaignRowHint");
  return (
    <div
      className="flex flex-col gap-1.5 rounded-[var(--studio-control-radius,var(--radius-md))] border border-border/80 bg-muted/30 px-3 py-2"
      data-testid="named-rule-row"
    >
      {!inlineDate && (
        <div className="flex min-w-0 items-center gap-2">
          <MatcherIcon iconName={NAMED_RULE_ICON[kind]} size="sm" />
          <span className="truncate text-sm font-medium">{name}</span>
          {summary && (
            <span className="truncate text-xs text-muted-foreground">
              {summary}
            </span>
          )}
        </div>
      )}
      <p
        className={cn(
          "text-xs",
          missing && !inlineDate ? "text-foreground" : "text-muted-foreground",
        )}
        data-testid={missing && !inlineDate ? "named-rule-missing" : undefined}
      >
        {note}
      </p>
      {missing && !inlineDate && onCreate && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={onCreate}
        >
          <Plus className="size-4" />
          {t("sectionsEditor.namedRulePicker.createMissing")}
        </Button>
      )}
      {!inlineDate && <NamedRuleViewsLink kind={kind} />}
    </div>
  );
}

/** "Open Experiments" / "Open Campaigns", where the surface can go there. */
export function NamedRuleViewsLink({ kind }: { kind: NamedRuleKind }) {
  const t = useT();
  const views = useNamedRuleViews();
  if (!views) return null;
  return (
    <button
      type="button"
      onClick={() => views.open(kind)}
      className="inline-flex w-fit items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline cursor-pointer"
    >
      {kind === "experiments"
        ? t("sectionsEditor.namedRulePicker.openExperiments")
        : t("sectionsEditor.namedRulePicker.openCampaigns")}
      <ArrowUpRight className="size-3" />
    </button>
  );
}
