/**
 * The reconcile flow of an A/B test or campaign change that someone else's
 * save got to first (use-apply-named-rule.ts): the same choice a section
 * form asks for (form-conflict-dialog.tsx), theirs or yours, value by value,
 * and for a block one side removed, the whole block. The change's blocks
 * are one record, keyed by block name, so one dialog covers them all.
 *
 * Asked from a hook that renders nothing, so the dialog lives in a small
 * store: `askNamedRuleConflict` queues a question and resolves with the
 * choices; `NamedRuleConflictHost`, mounted once with the app's providers,
 * shows the first one.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { FormConflictDialog } from "./form-conflict-dialog";
import {
  type ConflictChoices,
  type ConflictField,
  defaultConflictChoices,
  type FormConflictPlan,
} from "./form-conflict";

interface Question {
  id: number;
  plan: FormConflictPlan;
  fields: ConflictField[];
  answer: (choices: ConflictChoices) => void;
}

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

/** Shows the choice; resolves with the user's picks once they apply them. */
export function askNamedRuleConflict(
  plan: FormConflictPlan,
  fields: ConflictField[],
): Promise<ConflictChoices> {
  return new Promise((resolve) => {
    const id = ++asked;
    questions = [
      ...questions,
      {
        id,
        plan,
        fields,
        answer: (choices) => {
          questions = questions.filter((q) => q.id !== id);
          changed();
          resolve(choices);
        },
      },
    ];
    changed();
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
  return <Choice key={question.id} question={question} />;
}

function Choice({ question }: { question: Question }) {
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
