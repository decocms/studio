// CMS tool UI — Deco's "makes" side, rendered inline in the chat like any tool
// call. One tool: tool-cms_content. It shows a CONTENT EDIT the way deco sites
// Content works — a prop diff on a page's section (or a global section): for each
// section, the fields that change (title, CTA, image, …) as before → after. This
// mirrors the real SectionsEditor (pages → sections → props), read-only, plus
// publish actions. Publishing writes the section block back (mocked via the
// redesign store so the home + sidebar reflect it).
import { useState } from "react";
import type { ToolUIPart } from "ai";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowRight, Check, Image01, LayoutAlt01 } from "@untitledui/icons";
import type {
  FieldChange,
  SectionEdit,
} from "@/web/views/deco-redesign/mock-cms";
import {
  setIncidentState,
  useOverrides,
} from "@/web/views/deco-redesign/mock-store";
import type {
  AutonomyMode,
  IncidentState,
} from "@/web/views/deco-redesign/mock-data";
import { unwrapResult } from "./utils.tsx";

interface ContentOutput {
  proposalId: string;
  seedState: IncidentState;
  autonomy: AutonomyMode;
  scope: string;
  edits: SectionEdit[];
}

type Outcome = "published" | "editing" | "dismissed" | "reverted" | null;

export function CmsContentEditPart({ part }: { part: ToolUIPart }) {
  const data = unwrapResult<ContentOutput>(part.output);
  const overrides = useOverrides();
  const [outcome, setOutcome] = useState<Outcome>(null);
  if (!data) return null;

  const base = overrides[data.proposalId] ?? data.seedState;
  const published = base === "resolved";

  const act = (next: Exclude<Outcome, null>, state: IncidentState) => {
    setOutcome(next);
    setIncidentState(data.proposalId, state);
  };

  return (
    <div className="my-3 flex max-w-[600px] flex-col gap-3">
      {data.edits.map((edit, i) => (
        <SectionEditCard key={`${edit.resolveType}-${i}`} edit={edit} />
      ))}

      {published && (
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
          <Check size={12} />
          Published
        </span>
      )}

      {outcome === null ? (
        <ContentActions base={base} onAct={act} />
      ) : (
        <p className="text-sm text-foreground">{followupText(outcome)}</p>
      )}
    </div>
  );
}

function SectionEditCard({ edit }: { edit: SectionEdit }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm">
        <LayoutAlt01 size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">
          {edit.global
            ? "Global"
            : `${edit.page}${edit.pagePath ? ` · ${edit.pagePath}` : ""}`}
        </span>
        <ArrowRight size={12} className="shrink-0 text-muted-foreground/60" />
        <span className="font-medium text-foreground">
          {edit.section} section
        </span>
        {edit.op === "add" && (
          <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">
            New
          </span>
        )}
        {edit.global && (
          <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {edit.appliesTo ?? "all pages"}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 p-1">
        {edit.changes.map((c) => (
          <FieldDiffRow key={c.path} change={c} />
        ))}
      </div>
    </div>
  );
}

function FieldDiffRow({ change }: { change: FieldChange }) {
  const isNew = change.before === "—";
  return (
    <div className="rounded-md px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {change.label}
        <span className="font-mono text-muted-foreground/50">
          {change.path}
        </span>
      </div>
      {change.type === "image" ? (
        <div className="flex items-center gap-3">
          {!isNew && (
            <>
              <ImageThumb name={change.before} src={change.srcBefore} muted />
              <ArrowRight
                size={12}
                className="shrink-0 text-muted-foreground/60"
              />
            </>
          )}
          <ImageThumb name={change.after} src={change.srcAfter} />
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 text-sm">
          {!isNew && (
            <span className="text-muted-foreground line-through">
              {change.before}
            </span>
          )}
          <span className="text-foreground">{change.after}</span>
        </div>
      )}
    </div>
  );
}

function ImageThumb({
  name,
  src,
  muted = false,
}: {
  name: string;
  src?: string;
  muted?: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  return (
    <div className={cn("flex flex-col gap-1.5", muted && "opacity-50")}>
      <div className="w-32 h-20 rounded-md overflow-hidden border border-border bg-muted flex items-center justify-center text-muted-foreground">
        {src && !imgError ? (
          <img
            src={src}
            alt=""
            onError={() => setImgError(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <Image01 size={20} />
        )}
      </div>
      <span
        className={cn(
          "text-xs truncate max-w-32",
          muted ? "text-muted-foreground line-through" : "text-foreground",
        )}
      >
        {name}
      </span>
    </div>
  );
}

function ContentActions({
  base,
  onAct,
}: {
  base: IncidentState;
  onAct: (outcome: Exclude<Outcome, null>, state: IncidentState) => void;
}) {
  if (base === "needs_review") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="success"
          onClick={() => onAct("published", "resolved")}
        >
          <Check size={14} />
          Publish
        </Button>
        <Button
          variant="outline"
          onClick={() => onAct("editing", "in_progress")}
        >
          Open in Content
        </Button>
        <Button
          variant="ghost"
          className="ml-auto text-muted-foreground"
          onClick={() => onAct("dismissed", "dismissed")}
        >
          Not now
        </Button>
      </div>
    );
  }
  if (base === "resolved") {
    return (
      <Button variant="outline" onClick={() => onAct("reverted", "watching")}>
        Revert this change
      </Button>
    );
  }
  return null;
}

function followupText(outcome: Exclude<Outcome, null>): string {
  switch (outcome) {
    case "published":
      return "Publishing now — I'll write the section blocks back and schedule them as planned.";
    case "editing":
      return "Opening this in Content so you can tweak any field before it goes live.";
    case "dismissed":
      return "Got it, leaving the content as-is. I'll note the call so I don't re-propose this.";
    case "reverted":
      return "Reverted — the section is back to its previous props. Nothing else changed.";
  }
}
