import type {
  TaskBoardItem,
  TaskBoardItemPr,
} from "@/layouts/task-board/config";
import { SUPER_AGENT_ASSIGNEE_ID } from "@/layouts/task-board/config";

export const PERSON = { userId: "user_example", user: { name: "Alex" } };
export const ORG = {
  id: "org_example",
  slug: "demo",
  name: "Demo",
  logo: null,
};
export const PROJECT = {
  id: "project_example",
  slug: "website",
  name: "Website",
};
export const CREATED_AT = new Date().toISOString();

export interface MockComment {
  audience?: "human" | "internal";
  parentId?: string;
  id: string;
  body: string;
  author: "person" | "agent";
  authorLabel?: string;
  eventLabel?: string;
  mentionUserId?: string;
  resolved?: boolean;
}
export interface MockReview {
  testPlan?: { route: string; steps: { action: string; expected: string }[] };
  sections: { label: string; body: string; warning?: boolean }[];
  link?: { label: string; url: string };
}
export interface MockTask {
  review?: MockReview;
  pullRequest?: TaskBoardItemPr;
  projectLabel?: string;
  confirmLabel?: string;
  item: TaskBoardItem;
  comments: MockComment[];
  question: string;
}

export function item(
  keySeq: number,
  overrides: Partial<TaskBoardItem>,
): TaskBoardItem {
  return {
    id: `task_example_${keySeq}`,
    organizationId: ORG.id,
    keySeq,
    title: "",
    description: null,
    status: "todo",
    priority: "medium",
    type: "feature",
    harnessId: "claude-code",
    assigneeId: PERSON.userId,
    assignedBy: PERSON.userId,
    repo: null,
    repositoryId: null,
    virtualMcpId: null,
    sprintId: null,
    parentId: null,
    isEpic: false,
    dueDate: null,
    sortOrder: keySeq,
    externalUrl: null,
    previewRoutes: [],
    source: null,
    retryAttempts: 0,
    reviewCycleStartedAt: null,
    threads: [],
    tags: [],
    reviewVerdicts: [],
    statusSince: CREATED_AT,
    createdBy: PERSON.userId,
    createdAt: CREATED_AT,
    updatedBy: PERSON.userId,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

export function initialTasks(): MockTask[] {
  return [
    {
      item: item(24, {
        title: "Revisar a nova home",
        status: "customer_approval",
        description:
          "A hierarquia e os espaçamentos estão ajustados. A versão mobile também está pronta para revisão.",
        reviewVerdicts: [
          { reviewer: "reviewer", verdict: "approved", verified: true },
        ],
      }),
      question: "Podemos seguir com essa versão?",
      comments: [
        {
          id: "comment_example_24",
          author: "agent",
          body: "Concluí a revisão da home. Desktop e mobile passaram pelos checks. Deixei o card com você para aprovar a versão antes da publicação.",
        },
      ],
    },
    {
      item: item(31, {
        title: "Definir o fluxo de checkout",
        status: "in_progress",
        priority: "high",
        description:
          "Precisamos decidir se o visitante pode concluir a compra sem criar uma conta.",
        threads: [
          {
            threadId: "thread_example_31",
            virtualMcpId: null,
            status: "requires_action",
            title: "Checkout",
            lastMessage: "Podemos manter a compra sem conta?",
            hasPreview: false,
            failureKind: null,
            hasMessages: true,
            costUsd: null,
            costProvider: null,
            createdAt: CREATED_AT,
            lastActiveAt: CREATED_AT,
          },
        ],
      }),
      question: "Seguimos com a compra sem conta?",
      comments: [
        {
          id: "comment_example_31",
          author: "agent",
          body: "Minha sugestão é manter a compra sem conta e oferecer o cadastro depois do pedido. Preciso dessa decisão para continuar a implementação.",
        },
      ],
    },
    {
      item: item(36, {
        title: "Confirmar a condição da campanha",
        status: "in_progress",
        assigneeId: SUPER_AGENT_ASSIGNEE_ID,
        description:
          "A página está pronta. Falta confirmar o escopo da condição comercial.",
      }),
      question: "A condição vale para toda a coleção?",
      comments: [
        {
          id: "comment_example_36",
          author: "agent",
          body: "@Alex, a condição vale para todos os produtos da coleção? Preciso confirmar antes de finalizar o texto.",
          mentionUserId: PERSON.userId,
          resolved: false,
        },
      ],
    },
    {
      item: item(42, {
        title: "Validar navegação mobile",
        status: "in_progress",
        assigneeId: SUPER_AGENT_ASSIGNEE_ID,
        type: "chore",
      }),
      question: "",
      comments: [
        {
          id: "comment_example_42",
          author: "agent",
          body: "Estou conferindo os links e o comportamento do menu no mobile.",
        },
      ],
    },
  ];
}

/** Prototype-only mention resolution; the existing comment contract has no inbox receipt. */
export function needsPerson(task: MockTask): boolean {
  return (
    (task.item.assigneeId === PERSON.userId &&
      (task.item.status === "customer_approval" ||
        task.item.status === "in_review" ||
        task.item.threads.some(
          (thread) => thread.status === "requires_action",
        ))) ||
    task.comments.some(
      (comment) => comment.mentionUserId === PERSON.userId && !comment.resolved,
    )
  );
}
