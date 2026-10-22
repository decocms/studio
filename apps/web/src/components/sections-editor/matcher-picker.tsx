import { useState } from "react";
import { ChevronDown } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@decocms/ui/components/command.tsx";
import { useT } from "@/i18n/use-t.ts";
import { resolveBlockSchemaMetadata, type LiveMeta } from "./resolve-schema";
import { MatcherIcon, resolveMatcherIconName } from "./matcher-icons";
import { labelFromResolveType } from "./section-types";
import { getIconComponent } from "../agent-icon";
import {
  buildMatcherBlockReference,
  inlineMatcherRule,
  listSavedMatcherBlocks,
} from "./matcher-rules";
import { globalSectionLabel } from "./page-list";
import { formatMatcher } from "./format-matcher";
import { useBlocksSiteEditor } from "./blocks-site-editor";
import { isV8Schema } from "@decocms/shared/blocks-major";
import {
  type CampaignWindow,
  type NamedRuleKind,
  readNamedRuleValues,
} from "./named-rules";
import {
  type NamedRulePick,
  type NamedRulePickerKind,
  namedRuleMatchers,
} from "./named-rule-picker";
import {
  NamedRuleCreateForm,
  NamedRuleKindItems,
  NamedRuleNameStep,
} from "./named-rule-step";

/**
 * A default of `[]` is a NEW array on every render, so anything derived from
 * it re-renders even when nothing changed. `never[]` is assignable to any
 * `T[]`, so one frozen constant serves every optional list prop in this file.
 */
const EMPTY_ARRAY: never[] = [];

export interface MatcherEntry {
  resolveType: string;
  title: string;
  description?: string;
  iconName: string;
}

/** A saved matcher block (global rule) shown under the picker's "Saved rules". */
export interface MatcherGlobalEntry {
  /** Decofile key referenced as the rule's `__resolveType`. */
  blockKey: string;
  title: string;
  description?: string;
  iconName: string;
}

/**
 * Build the "Saved rules" list from the decofile: every global matcher block,
 * labelled by its name and described by a human summary of its underlying rule.
 */
export function extractMatcherGlobals(
  meta: LiveMeta,
  decofile: Record<string, unknown>,
): MatcherGlobalEntry[] {
  return listSavedMatcherBlocks(meta, decofile).map((block) => {
    const raw = (decofile[block.blockKey] ?? {}) as Record<string, unknown>;
    const inlined = inlineMatcherRule(
      buildMatcherBlockReference(block.blockKey),
      decofile,
      meta,
    );
    return {
      blockKey: block.blockKey,
      title: globalSectionLabel(block.blockKey, raw),
      description: formatMatcher(
        inlined,
        readNamedRuleValues(decofile),
        isV8Schema(meta),
      ),
      iconName: resolveMatcherIconName(
        block.matcherResolveType,
        undefined,
        isV8Schema(meta),
      ),
    };
  });
}

const ALWAYS_MATCHER_ICON = "Users03";

/**
 * Case-insensitive substring match, replacing cmdk's default fuzzy scorer.
 * The fuzzy scorer matches loose subsequences, so a query like "random" would
 * surface unrelated matchers whose description happens to contain those letters
 * in order. "Contains" keeps the description searchable without false hits.
 */
export function substringFilter(value: string, search: string): number {
  return value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0;
}

/** The schema's `aliases` (v7 name → next-major name); empty on v7 schemas. */
function schemaAliases(meta: LiveMeta): Record<string, string> {
  const aliases = (meta as { aliases?: unknown }).aliases;
  return aliases && typeof aliases === "object"
    ? (aliases as Record<string, string>)
    : {};
}

/**
 * Extract the list of available matcher block types from live meta.
 * Looks for block-type keys that contain "matchers" (e.g. "matchers",
 * "website/matchers") and collects each entry's resolveType + title.
 */
export function extractMatchers(meta: LiveMeta): MatcherEntry[] {
  const blocks = meta.manifest?.blocks ?? {};
  const result: MatcherEntry[] = [];
  const seen = new Set<string>();
  // Next-major schemas list the v7 names of their built-ins (e.g.
  // `website/matchers/never.ts` for `never`) under `aliases`, so old content
  // still resolves. They are the same matcher: offer only the real name. Any
  // other site lists its matchers exactly as before.
  const v8 = isV8Schema(meta);
  const aliases = v8 ? schemaAliases(meta) : {};

  for (const [blockType, blockMap] of Object.entries(blocks)) {
    if (!blockType.includes("matchers")) continue;
    // The `$live/matchers/*` group holds legacy compat aliases (e.g.
    // `MatchUserAgent`) that only re-export the canonical `website/matchers/*`
    // blocks. Listing them would show every built-in matcher twice, so offer
    // only the canonical types. Old decofiles that reference the aliases are
    // still read via format-matcher.ts.
    if (blockType.startsWith("$live/")) continue;

    for (const resolveType of Object.keys(blockMap)) {
      // Skip "always" — it's hardcoded as the first option in the picker.
      // Case-insensitive so the legacy `MatchAlways` alias is caught too.
      if (resolveType.toLowerCase().includes("always")) continue;
      // Guard against the same matcher being registered under more than one
      // block-type group (e.g. "matchers" and "website/matchers").
      if (seen.has(resolveType)) continue;
      seen.add(resolveType);
      const target = aliases[resolveType];
      if (target && Object.hasOwn(blockMap, target)) continue;

      const metadata = resolveBlockSchemaMetadata(resolveType, meta);
      // v8: a built-in's generated title is its bare name (`never`,
      // `campaign`), so it gets a label instead. v7 keeps main's title.
      const title = v8
        ? metadata.title && metadata.title !== resolveType
          ? metadata.title
          : labelFromResolveType(resolveType)
        : (metadata.title ?? labelFromResolveType(resolveType));

      result.push({
        resolveType,
        title,
        description: metadata.description,
        iconName: resolveMatcherIconName(resolveType, metadata.icon, v8),
      });
    }
  }

  return result;
}

function resolveCurrentMatcherIcon(
  currentRt: string,
  matchers: MatcherEntry[],
  v8: boolean,
): string {
  if (!currentRt) return ALWAYS_MATCHER_ICON;

  const match = matchers.find((matcher) => matcher.resolveType === currentRt);
  if (match) return match.iconName;

  return resolveMatcherIconName(currentRt, undefined, v8);
}

/**
 * A button + CommandDialog that lets users pick a matcher type for a variant rule.
 */
/** The picker's v8 "A/B test" and "Campaign" items (named-rule-picker.ts). */
export interface NamedRulePickerProps {
  kinds: NamedRulePickerKind[];
  /** The test or campaign the variant's rule names now, if any. */
  selected: { kind: NamedRuleKind; name: string } | null;
  /** Dates a new campaign starts with (an inline date rule being moved). */
  campaignPrefill?: CampaignWindow | null;
  /** Writes the pick; resolves once saved (or refused, with its toast). */
  onPick: (pick: NamedRulePick) => Promise<unknown> | void;
}

type PickerStep =
  | { view: "rules" }
  | { view: "names"; kind: NamedRuleKind }
  | { view: "create"; kind: NamedRuleKind; name: string };

export function MatcherPicker({
  currentRt,
  currentLabel,
  currentGlobalKey,
  matchers,
  globals = EMPTY_ARRAY,
  onSelect,
  onSelectGlobal,
  named,
}: {
  currentRt: string;
  currentLabel: string;
  /** Block key when the current rule references a saved global matcher block. */
  currentGlobalKey?: string;
  matchers: MatcherEntry[];
  globals?: MatcherGlobalEntry[];
  onSelect: (resolveType: string) => void;
  onSelectGlobal?: (blockKey: string) => void;
  /** v8 only: tests and campaigns by name. Absent, the picker is as before. */
  named?: NamedRulePickerProps;
}) {
  const v8Editor = useBlocksSiteEditor();
  const [open, setOpenState] = useState(false);
  const [step, setStep] = useState<PickerStep>({ view: "rules" });
  const [pending, setPending] = useState(false);
  // The step resets when the dialog opens, not when it closes: the closing
  // dialog keeps showing what was picked or created, not the rule list
  // filtered by the name typed.
  const setOpen = (next: boolean) => {
    if (next) setStep({ view: "rules" });
    setOpenState(next);
  };
  const t = useT();
  const namedKinds = named?.kinds ?? EMPTY_ARRAY;
  // The named items stand in for the raw `experiment` and `campaign` rules.
  const hiddenMatchers = namedRuleMatchers(namedKinds);
  const listedMatchers =
    hiddenMatchers.size > 0
      ? matchers.filter((m) => !hiddenMatchers.has(m.resolveType))
      : matchers;
  const currentNamedKind =
    !currentGlobalKey && named?.selected ? named.selected.kind : null;
  const stepKind =
    step.view === "rules"
      ? null
      : (namedKinds.find((k) => k.kind === step.kind) ?? null);

  const handlePick = async (pick: NamedRulePick) => {
    if (!named) return;
    setPending(true);
    try {
      await named.onPick(pick);
    } finally {
      setPending(false);
    }
    setOpen(false);
  };
  // A saved-block reference wins the trigger icon; otherwise fall back to the
  // built-in matcher module's icon.
  const currentGlobal = currentGlobalKey
    ? globals.find((g) => g.blockKey === currentGlobalKey)
    : undefined;
  const currentIconName =
    currentGlobal?.iconName ??
    resolveCurrentMatcherIcon(currentRt, matchers, v8Editor);
  const CurrentIcon = getIconComponent(currentIconName);

  const handleSelect = (rt: string) => {
    onSelect(rt);
    setOpen(false);
  };

  const handleSelectGlobal = (blockKey: string) => {
    onSelectGlobal?.(blockKey);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center gap-2 rounded-[var(--studio-control-radius,var(--radius-md))] border border-input bg-transparent px-3 text-left text-sm shadow-xs transition-colors hover:bg-accent cursor-pointer"
      >
        {CurrentIcon && (
          <CurrentIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate">{currentLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("sectionsEditor.matcherPicker.chooseRuleTitle")}
        description={t("sectionsEditor.matcherPicker.chooseRuleDescription")}
        className="sm:max-w-lg"
        filter={substringFilter}
      >
        {step.view === "names" && stepKind ? (
          <NamedRuleNameStep
            key={stepKind.kind}
            kind={stepKind}
            currentName={
              named?.selected?.kind === stepKind.kind
                ? named.selected.name
                : null
            }
            onBack={() => setStep({ view: "rules" })}
            onPick={(name) =>
              void handlePick({ kind: stepKind.kind, name } as NamedRulePick)
            }
            onCreate={(name) =>
              setStep({ view: "create", kind: stepKind.kind, name })
            }
          />
        ) : step.view === "create" && stepKind ? (
          <NamedRuleCreateForm
            kind={stepKind.kind}
            initialName={step.name}
            existingNames={stepKind.entries.map((e) => e.name)}
            prefill={
              stepKind.kind === "campaigns" ? named?.campaignPrefill : null
            }
            pending={pending}
            onBack={() => setStep({ view: "names", kind: stepKind.kind })}
            onSubmit={(pick) => void handlePick(pick)}
          />
        ) : (
          <>
            <CommandInput
              placeholder={t(
                "sectionsEditor.matcherPicker.searchRulesPlaceholder",
              )}
            />
            <CommandList>
              <CommandEmpty>
                {t("sectionsEditor.matcherPicker.noRulesFound")}
              </CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value={`${t("sectionsEditor.matcherPicker.alwaysLabel")} ${t("sectionsEditor.matcherPicker.targetAllUsers")}`}
                  onSelect={() => handleSelect("")}
                  className={cn(
                    "gap-2.5",
                    !currentRt && !currentGlobalKey && "bg-accent/60",
                  )}
                >
                  <MatcherIcon iconName={ALWAYS_MATCHER_ICON} size="sm" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm">
                      {t("sectionsEditor.matcherPicker.alwaysLabel")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("sectionsEditor.matcherPicker.targetAllUsers")}
                    </span>
                  </div>
                </CommandItem>
                {namedKinds.length > 0 && (
                  <NamedRuleKindItems
                    kinds={namedKinds}
                    currentKind={currentNamedKind}
                    onOpen={(kind) => setStep({ view: "names", kind })}
                  />
                )}
                {listedMatchers.map((matcher) => (
                  <CommandItem
                    key={matcher.resolveType}
                    value={`${matcher.title} ${matcher.resolveType} ${matcher.description ?? ""}`}
                    onSelect={() => handleSelect(matcher.resolveType)}
                    className={cn(
                      "gap-2.5",
                      !currentGlobalKey &&
                        currentRt === matcher.resolveType &&
                        "bg-accent/60",
                    )}
                  >
                    <MatcherIcon iconName={matcher.iconName} size="sm" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm">{matcher.title}</span>
                      {matcher.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {matcher.description}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
              {globals.length > 0 && (
                <CommandGroup
                  heading={t("sectionsEditor.matcherPicker.savedRulesHeading")}
                >
                  {globals.map((global) => (
                    <CommandItem
                      key={global.blockKey}
                      value={`${global.title} ${global.blockKey} ${global.description ?? ""}`}
                      onSelect={() => handleSelectGlobal(global.blockKey)}
                      className={cn(
                        "gap-2.5",
                        currentGlobalKey === global.blockKey && "bg-accent/60",
                      )}
                    >
                      <MatcherIcon iconName={global.iconName} size="sm" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{global.title}</span>
                        {global.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {global.description}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </>
        )}
      </CommandDialog>
    </>
  );
}
