/**
 * Automation Job Stream
 *
 * Uses NATS JetStream to distribute automation fire commands across instances.
 * The scheduler publishes jobs when triggers are due; workers pull and execute.
 *
 * - WorkQueue retention: messages deleted on ack (no replay needed)
 * - Memory storage: jobs are transient; the DB is the authority
 * - Uses `.consume()` for a persistent consumer that handles reconnection internally
 * - Ack wait > automation timeout: prevents premature redelivery
 */

import {
  AckPolicy,
  type ConsumerMessages,
  DeliverPolicy,
  DiscardPolicy,
  type JetStreamClient,
  type NatsConnection,
  RetentionPolicy,
  StorageType,
} from "nats";

const STREAM_NAME = "AUTOMATION_JOBS";
const SUBJECT_PREFIX = "automation.fire";
const CONSUMER_NAME = "automation-worker";
const MAX_DELIVER = 3;
const ACK_WAIT_NS = 6 * 60 * 1_000_000_000; // 6 min (> 5 min automation timeout)
const PULL_BATCH_SIZE = 5;

export interface AutomationJobPayload {
  triggerId: string;
  automationId: string;
  organizationId: string;
}

export interface AutomationJobStreamOptions {
  getConnection: () => NatsConnection | null;
  getJetStream: () => JetStreamClient | null;
}

// Module-level state (singleton)
let js: JetStreamClient | null = null;
let subscription: ConsumerMessages | null = null;
let starting = false;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function init(opts: AutomationJobStreamOptions): Promise<void> {
  // Stop any existing consumer so we can re-create it after reconnection
  if (subscription) {
    subscription.stop();
    subscription = null;
  }
  starting = false;

  const nc = opts.getConnection();
  if (!nc) {
    console.warn("[AutomationJobStream] init: getConnection() returned null");
    return;
  }

  const jsm = await nc.jetstreamManager();

  const config = {
    name: STREAM_NAME,
    subjects: [`${SUBJECT_PREFIX}.>`],
    storage: StorageType.Memory,
    retention: RetentionPolicy.Workqueue,
    discard: DiscardPolicy.Old,
    max_msgs: 10_000,
    num_replicas: 1,
  };

  try {
    await jsm.streams.info(STREAM_NAME);
    await jsm.streams.update(STREAM_NAME, config);
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && err.message.includes("stream not found");
    if (isNotFound) {
      await jsm.streams.add(config);
    } else {
      throw err;
    }
  }

  // Ensure durable pull consumer exists
  try {
    await jsm.consumers.info(STREAM_NAME, CONSUMER_NAME);
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && err.message.includes("consumer not found");
    if (isNotFound) {
      await jsm.consumers.add(STREAM_NAME, {
        durable_name: CONSUMER_NAME,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: MAX_DELIVER,
        ack_wait: ACK_WAIT_NS,
        filter_subject: `${SUBJECT_PREFIX}.>`,
      });
    } else {
      throw err;
    }
  }

  js = opts.getJetStream() ?? null;
}

export async function publish(payload: AutomationJobPayload): Promise<void> {
  if (!js) {
    console.warn(
      "[AutomationJobStream] NATS not ready, dropping job:",
      payload.triggerId,
    );
    return;
  }
  const subj = `${SUBJECT_PREFIX}.${payload.triggerId}`;
  await js.publish(subj, encoder.encode(JSON.stringify(payload)));
}

export async function startConsumer(
  handler: (payload: AutomationJobPayload) => Promise<void>,
): Promise<void> {
  if (!js) return;
  if (subscription || starting) return; // Already consuming or in progress
  starting = true;

  try {
    const consumer = await js.consumers.get(STREAM_NAME, CONSUMER_NAME);
    subscription = await consumer.consume({ max_messages: PULL_BATCH_SIZE });
  } finally {
    starting = false;
  }

  (async () => {
    for await (const msg of subscription!) {
      try {
        const payload: AutomationJobPayload = JSON.parse(
          decoder.decode(msg.data),
        );
        await handler(payload);
        msg.ack();
      } catch (err) {
        console.error("[AutomationJobStream] Handler error, nacking:", err);
        msg.nak();
      }
    }
  })().catch((err) => {
    console.error("[AutomationJobStream] Consumer loop crashed:", err);
  });
}

export function stop(): void {
  if (subscription) {
    subscription.stop();
    subscription = null;
  }
  js = null;
}
