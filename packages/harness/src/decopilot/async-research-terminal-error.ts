export class AsyncResearchTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncResearchTerminalError";
  }
}
