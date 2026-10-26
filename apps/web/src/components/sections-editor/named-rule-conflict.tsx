/**
 * The reconcile flow of a hosted v8 save that someone else's save got to
 * first (an A/B test or campaign change, use-apply-named-rule.ts, and every
 * other block save, use-save-block.ts): the same choice a section form asks
 * for (form-conflict-dialog.tsx), theirs or yours, value by value. A change's
 * blocks are one record, keyed by block name, so one dialog covers them all.
 *
 * A block one side deleted and the other changed is one plain question
 * instead (`askDeletedConflict`): "Keep my version" or "Leave it deleted"
 * when they deleted it, "Delete anyway" or "Keep their version" when the
 * user's change deletes it. Nothing is decided for the user.
 *
 * Asked from hooks that render nothing, so the dialogs live in a small
 * store: `askNamedRuleConflict` and `askDeletedConflict` queue a question
 * and resolve with the answer; `NamedRuleConflictHost`, mounted once with
 * the app's providers, shows the first one.
 */

import { Button } from "@decocms/ui/components/button.tsx";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useT } from "@/i18n/use-t.ts";
import { FormConflictDialog } from "./form-conflict-dialog";
import {
  type ConflictChoice,
  type ConflictChoices,
  type ConflictField,
  defaultConflictChoices,
  type FormConflictPlan,
} from "./form-conflict";

/**
 * A block one side deleted while the other changed it. `theyDeleted`: the
 * user's edit meets a deletion in the draft; `youDeleted`: the user's
 * deletion meets someone else's change. `label` names the block.
 */
export interface DeletedConflict {
  kind: "theyDeleted" | "youDeleted";
  label: string;
}

type Question =
  | {
      id: number;
      kind: "values";
      plan: FormConflictPlan;
      fields: ConflictField[];
      answer: (choices: ConflictChoices) => void;
    }
  | {
      id: number;
      kind: "deleted";
      conflict: DeletedConflict;
      answer: (choice: ConflictChoice) => void;
    };

let questions: Question[] = [];
let hosts: symbol[] = [];
let asked = 0;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a host is mounted to ask (else the caller says so another way). */
export function canAskNamedRuleConflict(): boolean {
  return hosts.length > 0;
}

function ask(question: Question) {
  questions = [...questions, question];
  changed();
}

function answered(id: number) {
  questions = questions.filter((q) => q.id !== id);
  changed();
}

/** Shows the choice; resolves with the user's picks once they apply them. */
export function askNamedRuleConflict(
  plan: FormConflictPlan,
  fields: ConflictField[],
): Promise<ConflictChoices> {
  return new Promise((resolve) => {
    const id = ++asked;
    ask({
      id,
      kind: "values",
      plan,
      fields,
      answer: (choices) => {
        answered(id);
        resolve(choices);
      },
    });
  });
}

/**
 * Asks about a block one side deleted (see {@link DeletedConflict}):
 * resolves `"mine"` to keep the user's side (their edit, or their deletion),
 * `"theirs"` to keep the draft's.
 */
export function askDeletedConflict(
  conflict: DeletedConflict,
): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    const id = ++asked;
    ask({
      id,
      kind: "deleted",
      conflict,
      answer: (choice) => {
        answered(id);
        resolve(choice);
      },
    });
  });
}

export function NamedRuleConflictHost() {
  const [id] = useState(() => Symbol("named-rule-conflict-host"));
  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- registers this host for the component's lifetime
  useEffect(() => {
    hosts = [...hosts, id];
    changed();
    return () => {
      hosts = hosts.filter((h) => h !== id);
      changed();
    };
  }, [id]);
  const question = useSyncExternalStore(
    subscribe,
    () => (hosts[0] === id ? (questions[0] ?? null) : null),
    () => null,
  );
  if (!question) return null;
  if (question.kind === "deleted") {
    return <DeletedChoice key={question.id} question={question} />;
  }
  return <Choice key={question.id} question={question} />;
}

function DeletedChoice({
  question,
}: {
  question: Extract<Question, { kind: "deleted" }>;
}) {
  const t = useT();
  const { kind, label } = question.conflict;
  const theyDeleted = kind === "theyDeleted";
  return (
    // Controlled with no onOpenChange: only a choice closes it.
    <AlertDialog open>
      <AlertDialogContent
        className="sm:max-w-md"
        data-testid="deleted-conflict-dialog"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>
            {theyDeleted
              ? t("sectionsEditor.deletedConflict.theyDeletedTitle", {
                  name: label,
                })
              : t("sectionsEditor.deletedConflict.youDeletedTitle", {
                  name: label,
                })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {theyDeleted
              ? t("sectionsEditor.deletedConflict.theyDeletedDescription")
              : t("sectionsEditor.deletedConflict.youDeletedDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => question.answer("theirs")}>
            {theyDeleted
              ? t("sectionsEditor.deletedConflict.leaveDeleted")
              : t("sectionsEditor.deletedConflict.keepTheirs")}
          </Button>
          <Button autoFocus onClick={() => question.answer("mine")}>
            {theyDeleted
              ? t("sectionsEditor.deletedConflict.keepMine")
              : t("sectionsEditor.deletedConflict.deleteAnyway")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Choice({
  question,
}: {
  question: Extract<Question, { kind: "values" }>;
}) {
  const [choices, setChoices] = useState(() =>
    defaultConflictChoices(question.plan),
  );
  return (
    <FormConflictDialog
      open
      fields={question.fields}
      choices={choices}
      onChoose={(pointer, choice) =>
        setChoices((now) => ({ ...now, [pointer]: choice }))
      }
      onApply={() => question.answer(choices)}
    />
  );
}
