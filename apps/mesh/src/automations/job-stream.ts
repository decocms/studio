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
    console.log(
      "[AutomationJobStream] Initializing JetStream stream and consumer...",
    );
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
      const info = await jsm.streams.info(STREAM_NAME);
      console.log(
        `[AutomationJobStream] Stream ${STREAM_NAME} exists, messages=${info.state.messages}, updating config`,
      );
      await jsm.streams.update(STREAM_NAME, config);
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error && err.message.includes("stream not found");
      if (isNotFound) {
        console.log(
          `[AutomationJobStream] Stream ${STREAM_NAME} not found, creating`,
        );
        await jsm.streams.add(config);
      } else {
        throw err;
      }
    }

    // Ensure durable pull consumer exists
    try {
      const cInfo = await jsm.consumers.info(STREAM_NAME, CONSUMER_NAME);
      console.log(
        `[AutomationJobStream] Consumer ${CONSUMER_NAME} exists, pending=${cInfo.num_pending} waiting=${cInfo.num_waiting}`,
      );
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error && err.message.includes("consumer not found");
      if (isNotFound) {
        console.log(
          `[AutomationJobStream] Consumer ${CONSUMER_NAME} not found, creating`,
        );
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
    console.log("[AutomationJobStream] Initialization complete");
  }

  async publish(payload: AutomationJobPayload): Promise<void> {
    if (!this.js) throw new Error("AutomationJobStream not initialized");
    const subj = `${SUBJECT_PREFIX}.${payload.triggerId}`;
    console.log(
      `[AutomationJobStream] Publishing to ${subj}:`,
      JSON.stringify(payload),
    );
    const ack = await this.js.publish(
      subj,
      this.encoder.encode(JSON.stringify(payload)),
    );
    console.log(
      `[AutomationJobStream] Published, stream=${ack.stream} seq=${ack.seq}`,
    );
  }

  async startConsumer(
    handler: (payload: AutomationJobPayload) => Promise<void>,
  ): Promise<void> {
    if (!this.js) throw new Error("AutomationJobStream not initialized");
    this.running = true;

    console.log("[AutomationJobStream] Starting consumer pull loop...");
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
              console.log(
                `[AutomationJobStream] Received job: trigger=${payload.triggerId} automation=${payload.automationId} subject=${msg.subject} redelivered=${msg.redelivered}`,
              );
              await handler(payload);
              msg.ack();
              console.log(
                `[AutomationJobStream] Job acked: trigger=${payload.triggerId}`,
              );
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
            // Brief pause before retry
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
