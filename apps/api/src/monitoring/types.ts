/**
 * Monitoring Types
 *
 * Shared types for the monitoring system.
 */

// ============================================================================
// Raw Monitoring Event (Before Redaction)
// ============================================================================

export interface RawMonitoringEvent {
  organizationId: string;
  connectionId: string;
  toolName: string;
  input: unknown; // Not yet redacted
  output: unknown; // Not yet redacted
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
  timestamp: Date;
  userId?: string;
  requestId: string;
  properties?: Record<string, string>; // Custom key-value metadata
}

// ============================================================================
// Worker Message Types
// ============================================================================

export interface WorkerMessage {
  type: "log" | "flush" | "shutdown";
  payload?: RawMonitoringEvent;
}

export interface WorkerResponse {
  type: "ack" | "error" | "flushed";
  error?: string;
}

// ============================================================================
// Monitoring Configuration
// ============================================================================

export interface MonitoringConfig {
  enabled: boolean;
  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  databaseUrl?: string;
  redactor: "regex" | "presidio";
}

export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  enabled: true,
  batchSize: 250,
  flushIntervalMs: 300,
  maxQueueSize: 10000,
  redactor: "regex",
};
