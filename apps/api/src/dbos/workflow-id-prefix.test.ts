import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { GetWorkflowsInput, WorkflowStatus } from "@dbos-inc/dbos-sdk";
import { cancelThreadGateHead } from "../dispatch-queue/thread-gate-queue";
import {
  escapeLikePrefix,
  keepLiteralIdPrefix,
  listWorkflowsByIdPrefix,
} from "./workflow-id-prefix";

const row = (workflowID: string) =>
  ({ workflowID, status: "PENDING", createdAt: 0 }) as WorkflowStatus;

const otherTenantRows = [
  row("thread-run:thrd_victimA:msg-1"),
  row("thread-run:3f0c2a9e-0000-4000-8000-000000000000:msg-2"),
  row("bgtool:thrd_victimB:job-1"),
];

/** Postgres `LIKE` with the default `\` escape, as DBOS applies it to
 *  `workflow_id_prefix` (it appends `%` and passes the prefix unescaped). */
function pgLike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(value);
}

function stubListWorkflows(table: WorkflowStatus[], honorEscapes = true) {
  return spyOn(DBOS, "listWorkflows").mockImplementation(
    async (input: GetWorkflowsInput) => {
      const prefix = input.workflow_id_prefix as string;
      const pattern = honorEscapes ? prefix : prefix.replace(/\\(.)/g, "$1");
      return table.filter((r) => pgLike(r.workflowID, `${pattern}%`));
    },
  );
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("escapeLikePrefix", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLikePrefix("thread-run:a%b_c\\d:")).toBe(
      "thread-run:a\\%b\\_c\\\\d:",
    );
  });

  it("leaves ordinary ids unchanged apart from `_`", () => {
    expect(escapeLikePrefix("thread-run:3f0c2a9e-0000:")).toBe(
      "thread-run:3f0c2a9e-0000:",
    );
    expect(escapeLikePrefix("bgtool:thrd_x:")).toBe("bgtool:thrd\\_x:");
  });
});

describe("keepLiteralIdPrefix", () => {
  it("drops rows a wildcard prefix matched but that do not start with it", () => {
    expect(keepLiteralIdPrefix(otherTenantRows, "thread-run:%:")).toEqual([]);
  });

  it("keeps rows that start with the literal prefix", () => {
    const own = row("thread-run:%:msg-9");
    expect(
      keepLiteralIdPrefix([...otherTenantRows, own], "thread-run:%:"),
    ).toEqual([own]);
  });
});

describe("listWorkflowsByIdPrefix", () => {
  it("does not return other threads' workflows for a `%` thread id", async () => {
    spies.push(stubListWorkflows(otherTenantRows));
    expect(await listWorkflowsByIdPrefix("thread-run:%:", {})).toEqual([]);
  });

  it("does not let `_` match an arbitrary character", async () => {
    spies.push(stubListWorkflows([row("thread-run:thrdXvictim:msg-1")]));
    expect(
      await listWorkflowsByIdPrefix("thread-run:thrd_victim:", {}),
    ).toEqual([]);
  });

  it("still filters when the database ignores the escapes", async () => {
    spies.push(stubListWorkflows(otherTenantRows, false));
    expect(await listWorkflowsByIdPrefix("bgtool:%:", {})).toEqual([]);
  });

  it("returns the thread's own workflows", async () => {
    const own = row("thread-run:thrd_own:msg-1");
    spies.push(stubListWorkflows([...otherTenantRows, own]));
    expect(await listWorkflowsByIdPrefix("thread-run:thrd_own:", {})).toEqual([
      own,
    ]);
  });
});

describe("cancelThreadGateHead", () => {
  it("cancels no other thread's gate for a `%` thread id", async () => {
    spies.push(stubListWorkflows(otherTenantRows, false));
    const cancel = spyOn(DBOS, "cancelWorkflows").mockResolvedValue(undefined);
    spies.push(cancel);
    await cancelThreadGateHead("%");
    expect(cancel).not.toHaveBeenCalled();
  });
});
