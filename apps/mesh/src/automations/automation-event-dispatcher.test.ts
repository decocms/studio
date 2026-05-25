import { describe, expect, it, mock } from "bun:test";
import type { AutomationsStorage } from "@/storage/automations";
import type { Automation, AutomationTrigger } from "@/storage/types";
import {
  AutomationEventDispatcher,
  type EventFireFn,
} from "./automation-event-dispatcher";

// ============================================================================
// Helpers
// ============================================================================

const ORG_ID = "org_test";
const USER_ID = "user_test";

function makeAutomation(overrides?: Partial<Automation>): Automation {
  return {
    id: "auto_1",
    organization_id: ORG_ID,
    name: "Test",
    active: true,
    created_by: USER_ID,
    messages: JSON.stringify([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ]),
    models: JSON.stringify({ tier: "smart" }),
    temperature: 0.5,
    virtual_mcp_id: "agent_1",
    kind: "agent",
    connection_id: null,
    tool_name: null,
    tool_input: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeTriggerWithAutomation(
  triggerOverrides?: Partial<AutomationTrigger>,
  automationOverrides?: Partial<Automation>,
): AutomationTrigger & { automation: Automation } {
  return {
    id: "trig_1",
    automation_id: "auto_1",
    type: "event",
    cron_expression: null,
    connection_id: "conn_1",
    event_type: "order.created",
    params: null,
    last_run_at: null,
    next_run_at: null,
    api_key_id: null,
    created_at: "2026-01-01T00:00:00Z",
    ...triggerOverrides,
    automation: makeAutomation(automationOverrides),
  };
}

function makeDispatcher(opts?: {
  storage?: AutomationsStorage;
  fire?: EventFireFn;
}) {
  const storage =
    opts?.storage ??
    ({
      findActiveEventTriggers: mock(() => Promise.resolve([])),
    } as unknown as AutomationsStorage);

  const fire: EventFireFn =
    opts?.fire ?? (mock(async () => undefined) as EventFireFn);

  const dispatcher = new AutomationEventDispatcher(storage, fire);
  return { dispatcher, storage, fire };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 50));
}

// ============================================================================
// Tests
// ============================================================================

describe("AutomationEventDispatcher", () => {
  describe("dispatchForEvents", () => {
    it("queries triggers using (source, type, organizationId)", async () => {
      const { dispatcher, storage } = makeDispatcher();
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "order.created",
          data: {},
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      expect(
        (
          storage as unknown as {
            findActiveEventTriggers: ReturnType<typeof mock>;
          }
        ).findActiveEventTriggers,
      ).toHaveBeenCalledWith("conn_1", "order.created", ORG_ID);
    });

    it("calls fire for each matching trigger", async () => {
      const trigger = makeTriggerWithAutomation();
      const storage = {
        findActiveEventTriggers: mock(() => Promise.resolve([trigger])),
      } as unknown as AutomationsStorage;
      const fire: EventFireFn = mock(async () => undefined);

      const { dispatcher } = makeDispatcher({ storage, fire });
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "order.created",
          data: { foo: "bar" },
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      expect(
        (fire as unknown as ReturnType<typeof mock>).mock.calls.length,
      ).toBe(1);
      const [arg] = (fire as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      expect(arg.automation.id).toBe("auto_1");
      expect(arg.trigger.id).toBe("trig_1");
    });

    it("wraps event data into a system context message", async () => {
      const trigger = makeTriggerWithAutomation();
      const storage = {
        findActiveEventTriggers: mock(() => Promise.resolve([trigger])),
      } as unknown as AutomationsStorage;
      const fire: EventFireFn = mock(async () => undefined);

      const { dispatcher } = makeDispatcher({ storage, fire });
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "order.created",
          data: { orderId: 456 },
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      const [arg] = (fire as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      const msg = arg.contextMessages[0];
      expect(msg.role).toBe("system");
      expect(msg.content).toContain("untrusted external input");
      expect(msg.content).toContain("orderId");
      expect(msg.content).toContain("456");
      expect(msg.content).toContain("---BEGIN EVENT DATA---");
      expect(msg.content).toContain("---END EVENT DATA---");
    });

    it("derives idempotencyKey from event id + trigger id", async () => {
      const trigger = makeTriggerWithAutomation();
      const storage = {
        findActiveEventTriggers: mock(() => Promise.resolve([trigger])),
      } as unknown as AutomationsStorage;
      const fire: EventFireFn = mock(async () => undefined);

      const { dispatcher } = makeDispatcher({ storage, fire });
      dispatcher.dispatchForEvents([
        {
          id: "evt_abc",
          source: "conn_1",
          type: "order.created",
          data: {},
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      const [arg] = (fire as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      expect(arg.idempotencyKey).toBe("evt:evt_abc:trig:trig_1");
    });

    it("omits idempotencyKey when event has no id", async () => {
      const trigger = makeTriggerWithAutomation();
      const storage = {
        findActiveEventTriggers: mock(() => Promise.resolve([trigger])),
      } as unknown as AutomationsStorage;
      const fire: EventFireFn = mock(async () => undefined);

      const { dispatcher } = makeDispatcher({ storage, fire });
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "order.created",
          data: {},
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      const [arg] = (fire as unknown as ReturnType<typeof mock>).mock.calls[0]!;
      expect(arg.idempotencyKey).toBeUndefined();
    });

    it("swallows storage errors so the bus loop never throws", async () => {
      const storage = {
        findActiveEventTriggers: mock(() =>
          Promise.reject(new Error("db down")),
        ),
      } as unknown as AutomationsStorage;

      const { dispatcher } = makeDispatcher({ storage });
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "test",
          data: {},
          organizationId: ORG_ID,
        },
      ]);
      await flush();
    });

    it("fires once per matching event in a batch", async () => {
      const trigger = makeTriggerWithAutomation();
      const storage = {
        findActiveEventTriggers: mock(() => Promise.resolve([trigger])),
      } as unknown as AutomationsStorage;
      const fire: EventFireFn = mock(async () => undefined);

      const { dispatcher } = makeDispatcher({ storage, fire });
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "order.created",
          data: { id: 1 },
          organizationId: ORG_ID,
        },
        {
          source: "conn_1",
          type: "order.created",
          data: { id: 2 },
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      expect(
        (fire as unknown as ReturnType<typeof mock>).mock.calls.length,
      ).toBe(2);
    });
  });

  describe("paramsMatch", () => {
    const makeStorage = (
      trigger: AutomationTrigger & { automation: Automation },
    ) =>
      ({
        findActiveEventTriggers: mock(() => Promise.resolve([trigger])),
      }) as unknown as AutomationsStorage;

    async function expectFire(
      triggerOverrides: Partial<AutomationTrigger>,
      data: unknown,
      shouldFire: boolean,
    ) {
      const trigger = makeTriggerWithAutomation(triggerOverrides);
      const storage = makeStorage(trigger);
      const fire: EventFireFn = mock(async () => undefined);

      const { dispatcher } = makeDispatcher({ storage, fire });
      dispatcher.dispatchForEvents([
        {
          source: "conn_1",
          type: "test",
          data,
          organizationId: ORG_ID,
        },
      ]);
      await flush();

      const calls = (fire as unknown as ReturnType<typeof mock>).mock.calls
        .length;
      if (shouldFire) expect(calls).toBe(1);
      else expect(calls).toBe(0);
    }

    it("null params → always matches", () =>
      expectFire({ params: null }, { anything: true }, true));
    it("{} params → always matches", () =>
      expectFire({ params: "{}" }, { foo: "bar" }, true));
    it("matches when every param is satisfied", () =>
      expectFire(
        { params: JSON.stringify({ status: "paid" }) },
        { status: "paid", total: 100 },
        true,
      ));
    it("rejects when a param is unsatisfied", () =>
      expectFire(
        { params: JSON.stringify({ status: "paid" }) },
        { status: "pending" },
        false,
      ));
    it("rejects null data when params exist", () =>
      expectFire({ params: JSON.stringify({ key: "val" }) }, null, false));
    it("rejects malformed param JSON", () =>
      expectFire({ params: "not json" }, {}, false));
    it("rejects array-shaped params", () =>
      expectFire({ params: JSON.stringify(["a", "b"]) }, { a: 1 }, false));

    // ---- array-data sugar (scalar param against array data) ----
    it("scalar param matches when data array includes it", () =>
      expectFire(
        { params: JSON.stringify({ labelIds: "INBOX" }) },
        { labelIds: ["INBOX", "IMPORTANT"] },
        true,
      ));
    it("scalar param rejects when data array lacks it", () =>
      expectFire(
        { params: JSON.stringify({ labelIds: "DRAFT" }) },
        { labelIds: ["INBOX"] },
        false,
      ));

    // ---- explicit operators ----
    it("{op:eq} matches", () =>
      expectFire(
        { params: JSON.stringify({ x: { op: "eq", value: 1 } }) },
        { x: 1 },
        true,
      ));
    it("{op:contains} matches substring on a string field", () =>
      expectFire(
        {
          params: JSON.stringify({
            subject: { op: "contains", value: "urgent" },
          }),
        },
        { subject: "URGENT — please read" },
        true,
      ));
    it("{op:contains} matches an element on an array field", () =>
      expectFire(
        { params: JSON.stringify({ tags: { op: "contains", value: "bug" } }) },
        { tags: ["BUG-fix", "p0"] },
        true,
      ));
    it("{op:in} matches when scalar is in allowed set", () =>
      expectFire(
        {
          params: JSON.stringify({
            status: { op: "in", value: ["paid", "shipped"] },
          }),
        },
        { status: "paid" },
        true,
      ));
    it("{op:in} matches when array overlaps allowed set", () =>
      expectFire(
        {
          params: JSON.stringify({
            tags: { op: "in", value: ["urgent", "p0"] },
          }),
        },
        { tags: ["nice-to-have", "p0"] },
        true,
      ));
    it("{op:in} rejects when no overlap", () =>
      expectFire(
        { params: JSON.stringify({ tags: { op: "in", value: ["x"] } }) },
        { tags: ["y", "z"] },
        false,
      ));
  });
});
