/**
 * The board's sprint management: plan, start, complete, rename and delete
 * sprints. Opened from the view row; which sprint the board shows is the
 * filter's job, not this dialog's.
 */

import { useState } from "react";
import { DotsHorizontal, Edit03, Plus, Trash01, Zap } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  isFinishedStatus,
  MAX_SPRINT_NAME_LENGTH,
  nextSprintId,
  type Sprint,
} from "@decocms/shared/sprints";
import { useTaskBoardItems } from "@/hooks/use-task-board-items";
import { useSprintActions } from "@/hooks/use-task-board-sprints";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { localToday, suggestNextSprint } from "./sprint-draft";
import { formatSprintDays } from "./sprint-label";

/** Radix Select has no empty value, so the backlog needs a stand-in. */
const BACKLOG_VALUE = "__backlog__";

type Draft = {
  /** Null while planning a new sprint. */
  id: string | null;
  name: string;
  startDate: string;
  endDate: string;
};

const SECTIONS: { state: Sprint["state"]; labelKey: TranslationKey }[] = [
  { state: "active", labelKey: "taskBoard.sprints.sectionActive" },
  { state: "future", labelKey: "taskBoard.sprints.sectionFuture" },
  { state: "closed", labelKey: "taskBoard.sprints.sectionClosed" },
];

export function SprintsButton({ sprints }: { sprints: readonly Sprint[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        label={t("taskBoard.sprints.manage")}
        tooltipSide="bottom"
        variant="secondary"
        onClick={() => setOpen(true)}
      >
        <Zap />
      </IconButton>
      {open && (
        <SprintsDialog sprints={sprints} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function SprintsDialog({
  sprints,
  onClose,
}: {
  sprints: readonly Sprint[];
  onClose: () => void;
}) {
  const t = useT();
  const actions = useSprintActions();
  // The org's whole board: a sprint's cards are counted across projects.
  const { items } = useTaskBoardItems();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [deleting, setDeleting] = useState<Sprint | null>(null);

  const cardsIn = (sprintId: string) =>
    items.filter((item) => item.sprintId === sprintId);

  const planNew = () =>
    setDraft({ id: null, ...suggestNextSprint(sprints, localToday()) });

  const save = (value: Draft) => {
    const fields = {
      name: value.name.trim(),
      startDate: value.startDate || null,
      endDate: value.endDate || null,
    };
    const done = { onSuccess: () => setDraft(null) };
    if (value.id === null) actions.create.mutate(fields, done);
    else actions.update.mutate({ id: value.id, ...fields }, done);
  };

  return (
    <>
      <Dialog open onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("taskBoard.sprints.title")}</DialogTitle>
            <DialogDescription>
              {t("taskBoard.sprints.description")}
            </DialogDescription>
          </DialogHeader>

          {draft ? (
            <SprintForm
              draft={draft}
              pending={actions.create.isPending || actions.update.isPending}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSave={save}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="justify-self-start"
              onClick={planNew}
            >
              <Plus size={16} />
              {t("taskBoard.sprints.new")}
            </Button>
          )}

          <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
            {sprints.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("taskBoard.sprints.empty")}
              </p>
            )}
            {SECTIONS.map(({ state, labelKey }) => {
              const inSection = sprints.filter((s) => s.state === state);
              if (inSection.length === 0) return null;
              return (
                <section key={state} className="flex flex-col gap-1">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t(labelKey)}
                  </h3>
                  {inSection.map((sprint) => (
                    <SprintRow
                      key={sprint.id}
                      sprint={sprint}
                      cardCount={cardsIn(sprint.id).length}
                      busy={
                        actions.start.isPending &&
                        actions.start.variables === sprint.id
                      }
                      onStart={() => actions.start.mutate(sprint.id)}
                      onComplete={() => setCompleting(sprint)}
                      onEdit={() =>
                        setDraft({
                          id: sprint.id,
                          name: sprint.name,
                          startDate: sprint.startDate ?? "",
                          endDate: sprint.endDate ?? "",
                        })
                      }
                      onDelete={() => setDeleting(sprint)}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {completing && (
        <CompleteSprintDialog
          sprint={completing}
          sprints={sprints}
          openCards={
            cardsIn(completing.id).filter(
              (item) => !isFinishedStatus(item.status),
            ).length
          }
          pending={actions.complete.isPending}
          onCancel={() => setCompleting(null)}
          onConfirm={(moveOpenTo) =>
            actions.complete.mutate(
              { id: completing.id, moveOpenTo },
              { onSuccess: () => setCompleting(null) },
            )
          }
        />
      )}

      {deleting && (
        <Dialog open onOpenChange={(next) => !next && setDeleting(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("taskBoard.sprints.deleteTitle", { name: deleting.name })}
              </DialogTitle>
              <DialogDescription>
                {t("taskBoard.sprints.deleteDescription", {
                  count: cardsIn(deleting.id).length,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                {t("taskBoard.sprints.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={actions.remove.isPending}
                onClick={() =>
                  actions.remove.mutate(deleting.id, {
                    onSuccess: () => setDeleting(null),
                  })
                }
              >
                {actions.remove.isPending && <Spinner className="size-4" />}
                {t("taskBoard.sprints.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function SprintRow({
  sprint,
  cardCount,
  busy,
  onStart,
  onComplete,
  onEdit,
  onDelete,
}: {
  sprint: Sprint;
  cardCount: number;
  busy: boolean;
  onStart: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const days = formatSprintDays(sprint);
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/40">
      <Zap
        size={16}
        className={cn(
          "shrink-0",
          sprint.state === "active"
            ? "text-foreground"
            : "text-muted-foreground",
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {sprint.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {[days, t("taskBoard.sprints.cardCount", { count: cardCount })]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {sprint.state === "active" && (
        <Badge variant="outline">{t("taskBoard.sprints.running")}</Badge>
      )}
      {sprint.state === "future" && (
        <Button size="sm" variant="outline" disabled={busy} onClick={onStart}>
          {busy && <Spinner className="size-4" />}
          {t("taskBoard.sprints.start")}
        </Button>
      )}
      {sprint.state === "active" && (
        <Button size="sm" variant="outline" onClick={onComplete}>
          {t("taskBoard.sprints.complete")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t("taskBoard.sprints.more")} size="icon-sm">
            <DotsHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Edit03 size={14} />
            {t("taskBoard.sprints.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash01 size={14} />
            {t("taskBoard.sprints.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SprintForm({
  draft,
  pending,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  pending: boolean;
  onChange: (next: Draft) => void;
  onCancel: () => void;
  onSave: (draft: Draft) => void;
}) {
  const t = useT();
  const backwards =
    draft.startDate !== "" &&
    draft.endDate !== "" &&
    draft.endDate < draft.startDate;
  const valid = draft.name.trim() !== "" && !backwards;
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(draft);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sprint-name">{t("taskBoard.sprints.nameLabel")}</Label>
        <Input
          id="sprint-name"
          value={draft.name}
          maxLength={MAX_SPRINT_NAME_LENGTH}
          autoFocus
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sprint-start">
            {t("taskBoard.sprints.startLabel")}
          </Label>
          <Input
            id="sprint-start"
            type="date"
            value={draft.startDate}
            onChange={(event) =>
              onChange({ ...draft, startDate: event.target.value })
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sprint-end">{t("taskBoard.sprints.endLabel")}</Label>
          <Input
            id="sprint-end"
            type="date"
            value={draft.endDate}
            min={draft.startDate || undefined}
            onChange={(event) =>
              onChange({ ...draft, endDate: event.target.value })
            }
          />
        </div>
      </div>
      {backwards && (
        <p className="text-xs text-destructive">
          {t("taskBoard.sprints.endBeforeStart")}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("taskBoard.sprints.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!valid || pending}>
          {pending && <Spinner className="size-4" />}
          {draft.id === null
            ? t("taskBoard.sprints.create")
            : t("taskBoard.sprints.save")}
        </Button>
      </div>
    </form>
  );
}

function CompleteSprintDialog({
  sprint,
  sprints,
  openCards,
  pending,
  onCancel,
  onConfirm,
}: {
  sprint: Sprint;
  sprints: readonly Sprint[];
  openCards: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (moveOpenTo: string | null) => void;
}) {
  const t = useT();
  const targets = sprints.filter(
    (candidate) => candidate.id !== sprint.id && candidate.state !== "closed",
  );
  const [target, setTarget] = useState(
    nextSprintId(sprints, sprint.id) ?? BACKLOG_VALUE,
  );
  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("taskBoard.sprints.completeTitle", { name: sprint.name })}
          </DialogTitle>
          <DialogDescription>
            {openCards === 0
              ? t("taskBoard.sprints.completeNothingOpen")
              : t("taskBoard.sprints.completeDescription", {
                  count: openCards,
                })}
          </DialogDescription>
        </DialogHeader>
        {openCards > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>{t("taskBoard.sprints.moveOpenTo")}</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
                <SelectItem value={BACKLOG_VALUE}>
                  {t("taskBoard.sprints.backlog")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("taskBoard.sprints.cancel")}
          </Button>
          <Button
            disabled={pending}
            onClick={() => onConfirm(target === BACKLOG_VALUE ? null : target)}
          >
            {pending && <Spinner className="size-4" />}
            {t("taskBoard.sprints.complete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
