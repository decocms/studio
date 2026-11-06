import { z } from "zod";
import { SUPER_AGENT_ASSIGNEE_ID } from "@/layouts/task-board/config";
import { item, PERSON, type MockTask } from "./data";
const commentSchema = z.object({
  id: z.string().max(200),
  body: z.string().max(12000),
  author: z.enum(["person", "agent"]),
  authorLabel: z.string().max(100).optional(),
  eventLabel: z.string().max(100).optional(),
  mentionUserId: z.string().optional(),
  resolved: z.boolean().optional(),
});
const seedsSchema = z
  .array(
    z.object({
      key: z.number().int().positive(),
      projectLabel: z.string().max(100).optional(),
      pullRequest: z
        .object({
          url: z
            .string()
            .url()
            .refine((url) => url.startsWith("https://")),
          number: z.number().int().positive(),
          previewUrl: z
            .string()
            .url()
            .refine((url) => url.startsWith("https://"))
            .optional(),
          repoOwner: z.string().max(100),
          repoName: z.string().max(100),
          title: z.string().max(500),
          state: z.enum(["open", "closed"]),
          merged: z.boolean(),
        })
        .optional(),
      confirmLabel: z.string().max(100).optional(),
      review: z
        .object({
          testPlan: z
            .object({
              route: z
                .string()
                .max(1000)
                .refine(
                  (route) =>
                    route.startsWith("/") &&
                    !route.startsWith("//") &&
                    !route.includes("\\"),
                ),
              steps: z
                .array(
                  z.object({
                    action: z.string().max(1000),
                    expected: z.string().max(1000),
                  }),
                )
                .min(1)
                .max(8),
            })
            .optional(),
          sections: z
            .array(
              z.object({
                label: z.string().max(100),
                body: z.string().max(2000),
                warning: z.boolean().optional(),
              }),
            )
            .max(6),
          link: z
            .object({
              label: z.string().max(100),
              url: z
                .string()
                .url()
                .refine((url) => url.startsWith("https://")),
            })
            .optional(),
        })
        .optional(),
      sortOrder: z.number().finite().optional(),
      title: z.string().max(300),
      description: z.string().max(12000),
      status: z.enum([
        "in_progress",
        "customer_approval",
        "ready_for_deployment",
        "done",
      ]),
      owner: z.enum(["person", "agent"]),
      question: z.string().max(1000),
      comments: z.array(commentSchema).max(30),
    }),
  )
  .max(50);
const scenarioSchema = z.object({
  id: z.string().max(100),
  label: z.string().max(200),
  summary: z.string().max(2000),
  context: z.string().max(2000),
  tasks: seedsSchema,
});
const imageSource = z
  .string()
  .max(200000)
  .refine(
    (value) =>
      value.startsWith("https://") ||
      /^data:image\/(png|jpeg|webp|svg\+xml)[;,]/.test(value),
  );
const brandingSchema = z.object({
  logo: imageSource.optional(),
  icon: imageSource.optional(),
});
export type Branding = z.infer<typeof brandingSchema>;
export const fixtureSchema = z
  .object({
    name: z.string().max(100),
    organization: z.string().max(100),
    branding: brandingSchema.optional(),
    scenarios: z.array(scenarioSchema).min(1).max(10),
  })
  .refine(
    (fixture) =>
      new Set(fixture.scenarios.map((scenario) => scenario.id)).size ===
      fixture.scenarios.length,
  );
export type Scenario = z.infer<typeof scenarioSchema>;
export const FIXTURE_KEY = "voice-inbox-local-fixture-v1";
export function readFixture() {
  try {
    return fixtureSchema.parse(
      JSON.parse(
        document.getElementById("voice-inbox-fixture")?.textContent ??
          localStorage.getItem(FIXTURE_KEY) ??
          "null",
      ),
    );
  } catch {
    return null;
  }
}
export function storageKey(scenario: Scenario) {
  return `voice-inbox-session-v1:${scenario.id}`;
}
export function scenarioTasks(scenario: Scenario, restore = true): MockTask[] {
  let seeds = scenario.tasks;
  if (restore) {
    try {
      seeds = seedsSchema.parse(
        JSON.parse(localStorage.getItem(storageKey(scenario)) ?? "null"),
      );
    } catch {
      /* Missing or invalid saved sessions start from the fixture. */
    }
  }
  return seeds.map((seed) => {
    const source = scenario.tasks.find((task) => task.key === seed.key);
    return {
      item: item(seed.key, {
        title: seed.title,
        description: seed.description,
        status: seed.status,
        sortOrder: seed.sortOrder ?? seed.key,
        assigneeId:
          seed.owner === "person" ? PERSON.userId : SUPER_AGENT_ASSIGNEE_ID,
      }),
      projectLabel: scenario.tasks.find((task) => task.key === seed.key)
        ?.projectLabel,
      review: source?.review,
      pullRequest: source?.pullRequest
        ? {
            ...source.pullRequest,
            createdAt: "",
            updatedAt: null,
            body: null,
            draft: false,
            mergeable: null,
            checksStatus: null,
            checks: [],
            previewUrl: source.pullRequest.previewUrl ?? null,
          }
        : undefined,
      confirmLabel: scenario.tasks.find((task) => task.key === seed.key)
        ?.confirmLabel,
      question: seed.question,
      comments: seed.comments,
    };
  });
}
export function saveScenario(scenario: Scenario, tasks: MockTask[]) {
  localStorage.setItem(
    storageKey(scenario),
    JSON.stringify(
      tasks.map((task) => ({
        key: task.item.keySeq,
        projectLabel: task.projectLabel,
        sortOrder: task.item.sortOrder,
        title: task.item.title,
        description: task.item.description ?? "",
        status: task.item.status,
        owner: task.item.assigneeId === PERSON.userId ? "person" : "agent",
        question: task.question,
        comments: task.comments,
      })),
    ),
  );
}
