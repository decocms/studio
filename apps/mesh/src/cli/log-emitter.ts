import { EventEmitter } from "events";
import { addLogEntry } from "./cli-store";

export const logEmitter = new EventEmitter();

export interface LogEntry {
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: Date;
}

// Auto-forward events to the CLI store for Ink rendering
logEmitter.on("request", (entry: LogEntry) => {
  addLogEntry(entry);
});
