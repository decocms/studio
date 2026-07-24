import { useState } from "react";
import {
  SectionVariantList,
  type SectionVariantEntry,
} from "@/components/sections-editor/section-variant-list";
import { PageVariantTabs } from "@/components/sections-editor/page-variant-tabs";
import type { PageVariant } from "@/components/sections-editor/page-variants";
import { VariantRenameDialog } from "@/components/sections-editor/variant-rename-dialog";
import {
  MatcherPicker,
  type MatcherEntry,
  type MatcherGlobalEntry,
} from "@/components/sections-editor/matcher-picker";

/**
 * Harnesses for the variant/matcher UI components. These components are
 * callback-driven (they don't own the variant data), so each harness records
 * every callback invocation into a `data-testid="events"` <pre> that specs read
 * via readEvents(). That lets us assert exactly which action fired with which
 * argument when the user clicks a tab / menu item / dialog button.
 */

function EventLog({ events }: { events: unknown[] }) {
  return <pre data-testid="events">{JSON.stringify(events)}</pre>;
}

export function SectionVariantListHarness({
  variants,
  selectedIndex,
}: {
  variants: SectionVariantEntry[];
  selectedIndex: number;
}) {
  const [events, setEvents] = useState<unknown[]>([]);
  const push = (e: unknown) => setEvents((prev) => [...prev, e]);
  return (
    <div data-testid="harness">
      <SectionVariantList
        listKey="ct"
        variants={variants}
        selectedIndex={selectedIndex}
        onSelect={(index) => push({ type: "select", index })}
        onDuplicate={(index) => push({ type: "duplicate", index })}
        onDelete={(index) => push({ type: "delete", index })}
        onRemoveAll={() => push({ type: "removeAll" })}
        onReorder={(from, to) => push({ type: "reorder", from, to })}
        onAdd={() => push({ type: "add" })}
      />
      <EventLog events={events} />
    </div>
  );
}

export function PageVariantTabsHarness({
  variants,
  activeIndex,
  matchers = [],
}: {
  variants: PageVariant[];
  activeIndex: number;
  matchers?: Array<{ resolveType: string; iconName: string }>;
}) {
  const [events, setEvents] = useState<unknown[]>([]);
  const push = (e: unknown) => setEvents((prev) => [...prev, e]);
  return (
    <div data-testid="harness">
      <PageVariantTabs
        listKey="ct"
        variants={variants}
        activeIndex={activeIndex}
        decofile={{}}
        meta={null}
        matchers={matchers}
        onSelect={(index) => push({ type: "select", index })}
        onReorder={(from, to) => push({ type: "reorder", from, to })}
        onRename={(index) => push({ type: "rename", index })}
        onDuplicate={(index) => push({ type: "duplicate", index })}
        onDelete={(index) => push({ type: "delete", index })}
        onAdd={() => push({ type: "add" })}
      />
      <EventLog events={events} />
    </div>
  );
}

export function VariantRenameDialogHarness({
  initialName,
  autoLabel,
}: {
  initialName: string;
  autoLabel: string;
}) {
  const [open, setOpen] = useState(true);
  const [events, setEvents] = useState<unknown[]>([]);
  const push = (e: unknown) => setEvents((prev) => [...prev, e]);
  return (
    <div data-testid="harness">
      <VariantRenameDialog
        open={open}
        initialName={initialName}
        autoLabel={autoLabel}
        onSubmit={(name) => push({ type: "submit", name })}
        onOpenChange={(next) => {
          push({ type: "openChange", open: next });
          setOpen(next);
        }}
      />
      <EventLog events={events} />
    </div>
  );
}

export function MatcherPickerHarness({
  currentRt,
  currentLabel,
  currentGlobalKey,
  matchers,
  globals,
}: {
  currentRt: string;
  currentLabel: string;
  currentGlobalKey?: string;
  matchers: MatcherEntry[];
  globals?: MatcherGlobalEntry[];
}) {
  const [events, setEvents] = useState<unknown[]>([]);
  const push = (e: unknown) => setEvents((prev) => [...prev, e]);
  return (
    <div data-testid="harness">
      <MatcherPicker
        currentRt={currentRt}
        currentLabel={currentLabel}
        currentGlobalKey={currentGlobalKey}
        matchers={matchers}
        globals={globals}
        onSelect={(resolveType) => push({ type: "select", resolveType })}
        onSelectGlobal={(blockKey) => push({ type: "selectGlobal", blockKey })}
      />
      <EventLog events={events} />
    </div>
  );
}
