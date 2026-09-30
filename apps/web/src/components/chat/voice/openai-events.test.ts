import { expect, test } from "bun:test";
import type { ConversationCallbacks, DelegationReceipt } from "./conversation";
import { OpenAIConversationEvents } from "./openai-events";

function setup(receipt?: Promise<DelegationReceipt>) {
  const sent: object[] = [];
  const requests: Parameters<ConversationCallbacks["onDelegate"]>[0][] = [];
  const messages: Parameters<ConversationCallbacks["onMessage"]>[0][] = [];
  let errors = 0;
  const events = new OpenAIConversationEvents(
    (event) => {
      sent.push(event);
    },
    {
      onDelegate: async (request) => {
        requests.push(request);
        return (
          receipt ?? {
            status: "accepted",
            requestId: `request-${requests.length}`,
          }
        );
      },
      getWorkStatus() {
        return {};
      },
      cancelCurrentWork() {
        return {};
      },
      onMessage: (message) => {
        messages.push(message);
      },
      onModeChange() {},
      onConnect() {},
      onDisconnect() {},
      onVadScore() {},
      onUserSpeaking() {},
      onError() {
        errors++;
      },
    },
  );
  return { events, sent, requests, messages, errors: () => errors };
}
function fragment(id: string, delta: string, start: number, role = "input") {
  return {
    type: `session.${role}_transcript.delta`,
    event_id: id,
    delta,
    start_ms: start,
    end_ms: start + 100,
  };
}
function delegate(id: string, offset = 1000) {
  return {
    type: "session.delegation.created",
    offset_ms: offset,
    delegation: { id, target: "client" },
  };
}

test("transcript fragments never start work without a delegation", () => {
  const { events, requests, messages } = setup();
  events.receive(fragment("first", "Check", 100), 0);
  events.receive(fragment("second", " my orders", 200), 100);
  events.tick(5000);
  expect(requests).toEqual([]);
  expect(messages).toHaveLength(2);
});

test("late transcript fragments form one request and repeated delegation IDs execute once", async () => {
  const { events, requests, sent } = setup();
  events.receive(delegate("job-one"), 0);
  events.tick(600);
  expect(requests).toEqual([]);
  events.receive(fragment("first", "Check", 100), 700);
  events.receive(fragment("second", " my orders", 200), 800);
  events.receive(delegate("job-one"), 900);
  events.tick(1000);
  expect(requests).toEqual([]);
  events.tick(1400);
  events.receive(delegate("job-one"), 1500);
  events.tick(2000);
  await Promise.resolve();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    delegationId: "job-one",
    request: "Check my orders",
    transcript: [],
  });
  expect(sent).toContainEqual(
    expect.objectContaining({
      type: "session.thinking.append",
      delegation_id: "job-one",
      content: expect.stringContaining('"accepted"'),
    }),
  );
});

test("overlapping tasks retain independent IDs and complete out of order", async () => {
  const receipt = Promise.withResolvers<DelegationReceipt>();
  const { events, requests, sent } = setup(receipt.promise);
  events.receive(fragment("first", "Check orders", 100), 0);
  events.receive(delegate("orders"), 0);
  events.tick(600);
  events.receive(fragment("second", "Also inspect analytics", 1100), 700);
  events.receive(delegate("analytics", 2000), 700);
  events.tick(1300);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    request: "Also inspect analytics",
    transcript: [{ role: "user", text: "Check orders" }],
  });
  events.publishUpdate({
    delegationId: "analytics",
    delivery: "announce",
    text: "Analytics report is ready.",
  });
  events.publishUpdate({
    delegationId: "orders",
    delivery: "announce",
    text: "Order lookup failed.",
  });
  expect(
    sent.map((event) =>
      "delegation_id" in event ? event.delegation_id : null,
    ),
  ).toEqual(["analytics", "orders"]);
  receipt.resolve({ status: "accepted" });
  await Promise.resolve();
});

test("new corrections include prior conversation without repeating earlier requests", () => {
  const { events, requests } = setup();
  events.receive(fragment("first", "Create two tasks", 100), 0);
  events.receive(delegate("one"), 0);
  events.tick(600);
  events.receive(fragment("answer", "For which site?", 1100, "output"), 700);
  events.receive(fragment("second", "The current one", 1500), 800);
  events.receive(delegate("two", 2000), 800);
  events.tick(1400);
  expect(requests[1]).toEqual({
    delegationId: "two",
    request: "The current one",
    transcript: [
      { role: "user", text: "Create two tasks" },
      { role: "agent", text: "For which site?" },
    ],
  });
});

test("word-sized transcript deltas reach the agent as whole turns", () => {
  const { events, requests } = setup();
  events.receive(fragment("u1", " E aí", 100), 0);
  events.receive(fragment("u2", ", tudo bem", 200), 0);
  events.receive(fragment("a1", " Tudo", 300, "output"), 0);
  events.receive(fragment("a2", " bem!", 400, "output"), 0);
  events.receive(fragment("u3", " Quais MCPs", 500), 0);
  events.receive(fragment("u4", " tenho?", 600), 0);
  events.receive(delegate("one", 700), 0);
  events.tick(600);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    delegationId: "one",
    request: "E aí, tudo bem Quais MCPs tenho?",
    transcript: [{ role: "agent", text: "Tudo bem!" }],
  });
  events.receive(fragment("u5", " E o segundo?", 800), 700);
  events.receive(delegate("two", 900), 700);
  events.tick(1300);
  expect(requests[1]?.transcript).toEqual([
    { role: "user", text: "E aí, tudo bem" },
    { role: "agent", text: "Tudo bem!" },
    { role: "user", text: "Quais MCPs tenho?" },
  ]);
});

test("duplicate transcript events are ignored but repeated words are preserved", () => {
  const { events, messages, requests } = setup();
  events.receive(fragment("one", "very ", 100), 0);
  events.receive(fragment("one", "very ", 100), 0);
  events.receive(fragment("two", "very good", 200), 0);
  events.receive(delegate("one", 300), 0);
  events.tick(600);
  expect(messages).toHaveLength(2);
  expect(requests[0]?.request).toBe("very very good");
});

test("a later utterance cannot be assigned to an earlier delegation", () => {
  const { events, requests } = setup();
  events.receive(delegate("one", 500), 0);
  events.receive(fragment("later", "Delete the old file", 600), 0);
  events.tick(3500);
  expect(requests).toEqual([]);
});

test("empty or oversized requests never start work", () => {
  const { events, requests, sent } = setup();
  events.receive(delegate("empty"), 0);
  events.tick(3500);
  events.receive(fragment("long", "x".repeat(12001), 1100), 4000);
  events.receive(delegate("large", 2000), 4000);
  events.tick(5000);
  expect(requests).toEqual([]);
  expect(sent).toHaveLength(2);
});

test("leaving voice discards pending delegations and late receipts", async () => {
  const receipt = Promise.withResolvers<DelegationReceipt>();
  const { events, requests, sent, errors } = setup(receipt.promise);
  events.receive(fragment("one", "Check orders", 100), 0);
  events.receive(delegate("one"), 0);
  events.tick(600);
  events.receive(delegate("two", 2000), 700);
  events.close();
  receipt.resolve({ status: "accepted" });
  await Promise.resolve();
  events.tick(5000);
  events.receive({ type: "error" });
  events.publishUpdate({ delivery: "announce", text: "Late result" });
  expect(requests).toHaveLength(1);
  expect(sent).toEqual([]);
  expect(errors()).toBe(0);
});

test("context is quiet, replaceable by identity and every append fits the provider limit", () => {
  const { events, sent } = setup();
  const update = {
    delivery: "context" as const,
    contextId: "view",
    text: "Olá 🌎".repeat(300),
  };
  events.publishUpdate(update);
  const count = sent.length;
  events.publishUpdate(update);
  expect(sent).toHaveLength(count);
  events.publishUpdate({ ...update, text: "New page" });
  for (const event of sent) {
    expect(event).toMatchObject({
      type: "session.thinking.append",
      delegation_id: null,
    });
    if ("content" in event && typeof event.content === "string")
      expect(
        new TextEncoder().encode(event.content).length,
      ).toBeLessThanOrEqual(480);
  }
  expect(sent.at(-1)).toMatchObject({
    content: expect.stringContaining("superseding earlier values"),
  });
});

test("long results are announced once after every context fragment is acknowledged", () => {
  const { events, sent } = setup();
  events.publishUpdate({
    delivery: "announce",
    delegationId: "job",
    text: "A verified result. ".repeat(100),
  });
  expect(
    sent.every(
      (event) => "type" in event && event.type === "session.thinking.append",
    ),
  ).toBe(true);
  const contextEvents = [...sent];
  for (const event of contextEvents.reverse()) {
    if ("event_id" in event)
      events.receive({
        type: "session.thinking.appended",
        client_event_id: event.event_id,
      });
  }
  expect(sent).toHaveLength(contextEvents.length + 1);
  expect(sent.at(-1)).toMatchObject({
    type: "session.commentary.append",
    delegation_id: "job",
  });
  for (const event of contextEvents) {
    if ("event_id" in event)
      events.receive({
        type: "session.thinking.appended",
        client_event_id: event.event_id,
      });
  }
  expect(sent).toHaveLength(contextEvents.length + 1);
});
