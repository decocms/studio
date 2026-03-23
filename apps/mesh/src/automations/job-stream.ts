/**
 * Automation Job Stream
 *
 * Uses NATS JetStream to distribute automation fire commands across instances.
 * The scheduler publishes jobs when triggers are due; workers pull and execute.
 *
 * - WorkQueue retention: messages deleted on ack (no replay needed)
 * - Memory storage: jobs are transient; the DB is the authority
 * - Pull-based consumer: natural backpressure, one job per worker
 * - Ack wait > automation timeout: prevents premature redelivery
 */

import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type NatsConnection,
} from "nats";

const STREAM_NAME = "AUTOMATION_JOBS";
const SUBJECT_PREFIX = "automation.fire";
const CONSUMER_NAME = "automation-worker";
const MAX_DELIVER = 3;
const ACK_WAIT_NS = 6 * 60 * 1_000_000_000; // 6 min (> 5 min automation timeout)
const PULL_BATCH_SIZE = 5;
const PULL_EXPIRES_MS = 10_000;

export interface AutomationJobPayload {
  triggerId: string;
  automationId: string;
  organizationId: string;
}

export interface AutomationJobStreamOptions {
  getConnection: () => NatsConnection;
  getJetStream: () => JetStreamClient;
}

export class AutomationJobStream {
  private js: JetStreamClient | null = null;
  private running = false;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(private readonly options: AutomationJobStreamOptions) {}

  async init(): Promise<void> {
    const nc = this.options.getConnection();
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

    this.js = this.options.getJetStream();
  }

  async publish(payload: AutomationJobPayload): Promise<void> {
    if (!this.js) throw new Error("AutomationJobStream not initialized");
    const subj = `${SUBJECT_PREFIX}.${payload.triggerId}`;
    await this.js.publish(subj, this.encoder.encode(JSON.stringify(payload)));
  }

  async startConsumer(
    handler: (payload: AutomationJobPayload) => Promise<void>,
  ): Promise<void> {
    if (!this.js) throw new Error("AutomationJobStream not initialized");
    this.running = true;

    const consumer = await this.js.consumers.get(STREAM_NAME, CONSUMER_NAME);

    (async () => {
      while (this.running) {
        try {
          const messages = await consumer.fetch({
            max_messages: PULL_BATCH_SIZE,
            expires: PULL_EXPIRES_MS,
          });

          for await (const msg of messages) {
            try {
              const payload: AutomationJobPayload = JSON.parse(
                this.decoder.decode(msg.data),
              );
              await handler(payload);
              msg.ack();
            } catch (err) {
              console.error(
                "[AutomationJobStream] Handler error, nacking:",
                err,
              );
              msg.nak();
            }
          }
        } catch (err) {
          if (this.running) {
            console.error("[AutomationJobStream] Consumer fetch error:", err);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    })().catch((err) => {
      console.error("[AutomationJobStream] Consumer loop crashed:", err);
    });
  }

  stop(): void {
    this.running = false;
    this.js = null;
  }
}
