import { useState } from "react";
import {
  SectionList,
  parseSections,
  type RawSection,
} from "@/components/sections-editor/section-list";

/**
 * Harness for the page's SectionList. Callback-driven like the variant
 * harnesses: every callback lands in a `data-testid="events"` <pre> that specs
 * read via readEvents().
 */
export function SectionListHarness({
  rawSections,
  decofile = {},
  canAddSection = true,
}: {
  rawSections: RawSection[];
  decofile?: Record<string, unknown>;
  canAddSection?: boolean;
}) {
  const [events, setEvents] = useState<unknown[]>([]);
  const push = (e: unknown) => setEvents((prev) => [...prev, e]);
  return (
    <div data-testid="harness">
      <SectionList
        listKey="ct"
        rawSections={rawSections}
        sections={parseSections(rawSections, decofile)}
        meta={null}
        decofile={decofile}
        selectedIndex={null}
        onSelect={(index) => push({ type: "select", index })}
        onDelete={(index) => push({ type: "delete", index })}
        onDuplicate={(index) => push({ type: "duplicate", index })}
        onMakeReusable={(index) => push({ type: "makeReusable", index })}
        onToggleHidden={(index) => push({ type: "toggleHidden", index })}
        onAddVariant={(index) => push({ type: "addVariant", index })}
        onDetach={(index) => push({ type: "detach", index })}
        onAddSection={() => push({ type: "add" })}
        onAddSectionAt={(index) => push({ type: "addAt", index })}
        canAddSection={canAddSection}
      />
      <pre data-testid="events">{JSON.stringify(events)}</pre>
    </div>
  );
}
