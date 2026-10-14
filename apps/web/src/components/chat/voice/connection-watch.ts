/**
 * A WebRTC peer connection often reports "disconnected" for a few seconds
 * during a transient network hiccup before it recovers on its own. Only
 * "failed"/"closed" are terminal immediately; "disconnected" gets a grace
 * period before it is treated as a real drop.
 */
export class ConnectionWatch {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly onDisconnect: () => void,
    private readonly graceMs = 4000,
  ) {}

  report(state: RTCPeerConnectionState) {
    if (state === "connected") {
      clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (state === "failed" || state === "closed") {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.onDisconnect();
      return;
    }
    if (state === "disconnected" && !this.timer)
      this.timer = setTimeout(this.onDisconnect, this.graceMs);
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
