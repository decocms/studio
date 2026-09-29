import type { ConversationCallbacks, VoiceConversation } from "./conversation";
import { OpenAIConversationEvents } from "./openai-events";

export async function startOpenAIConversation(
  negotiate: (sdp: string, signal: AbortSignal) => Promise<{ sdp: string }>,
  callbacks: ConversationCallbacks,
  signal: AbortSignal,
): Promise<VoiceConversation> {
  signal.throwIfAborted();
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  const audio = document.createElement("audio");
  audio.autoplay = true;
  let microphone: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let samples: Uint8Array<ArrayBuffer> | undefined;
  let closed = false;
  let started = false;
  let ending: Promise<void> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let lastOutput = 0;
  let lastInput = 0;
  let inputAnalyser: AnalyserNode | undefined;
  let inputSamples: Uint8Array<ArrayBuffer> | undefined;
  let muted = false;
  const finished = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  void connected.promise.catch(() => {});
  const events = new OpenAIConversationEvents((event) => {
    if (!closed && channel.readyState === "open")
      channel.send(JSON.stringify(event));
  }, callbacks);
  const close = async () => {
    if (closed) return;
    closed = true;
    events.close();
    clearInterval(tick);
    signal.removeEventListener("abort", abort);
    channel.close();
    peer.close();
    for (const track of microphone?.getTracks() ?? []) track.stop();
    audio.pause();
    audio.srcObject = null;
    if (audioContext && audioContext.state !== "closed")
      await audioContext.close().catch(() => {});
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  const startupSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const ready = connected.promise;
  const startupAborted = () => connected.reject(startupSignal.reason);
  startupSignal.addEventListener("abort", startupAborted, { once: true });
  // SDP or microphone setup can fail before the channel opens.
  void ready.catch(() => {});
  channel.onmessage = ({ data }) => {
    if (closed || typeof data !== "string") return;
    try {
      const event: unknown = JSON.parse(data);
      if (typeof event === "object" && event !== null && "type" in event) {
        if (event.type === "session.started") {
          started = true;
          connected.resolve();
        }
        if (event.type === "session.closed") {
          finished.resolve();
          if (!ending) callbacks.onDisconnect();
        }
      }
      if (!ending) events.receive(event);
    } catch {
      callbacks.onError();
    }
  };
  channel.onclose = () => {
    connected.reject(new Error("Voice connection closed"));
    finished.resolve();
    if (!closed && !ending) callbacks.onDisconnect();
  };
  peer.onconnectionstatechange = () => {
    if (
      !closed &&
      ["failed", "disconnected", "closed"].includes(peer.connectionState)
    )
      callbacks.onDisconnect();
  };
  peer.ontrack = ({ streams, track }) => {
    if (closed) return;
    const stream = streams[0] ?? new MediaStream([track]);
    audio.srcObject = stream;
    audioContext ??= new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    samples = new Uint8Array(analyser.fftSize);
    audioContext.createMediaStreamSource(stream).connect(analyser);
    void audioContext.resume().catch(() => callbacks.onError());
    void audio.play().catch(() => callbacks.onError());
  };
  function outputVolume() {
    if (!analyser || !samples || closed) return 0;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += ((value - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / samples.length) * 4);
  }
  try {
    const pendingMicrophone = navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        if (closed || startupSignal.aborted) {
          for (const track of stream.getTracks()) track.stop();
          throw new DOMException("Voice connection cancelled", "AbortError");
        }
        microphone = stream;
        return stream;
      });
    const stream = await Promise.race([
      pendingMicrophone,
      new Promise<never>((_, reject) =>
        startupSignal.addEventListener(
          "abort",
          () => reject(startupSignal.reason),
          { once: true },
        ),
      ),
    ]);
    audioContext ??= new AudioContext();
    inputAnalyser = audioContext.createAnalyser();
    inputAnalyser.fftSize = 256;
    inputSamples = new Uint8Array(inputAnalyser.fftSize);
    audioContext.createMediaStreamSource(stream).connect(inputAnalyser);
    await audioContext.resume();
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    startupSignal.throwIfAborted();
    if (peer.iceGatheringState !== "complete") {
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (peer.iceGatheringState === "complete") {
            cleanup();
            resolve();
          }
        };
        const aborted = () => {
          cleanup();
          reject(startupSignal.reason);
        };
        const cleanup = () => {
          peer.removeEventListener("icegatheringstatechange", changed);
          startupSignal.removeEventListener("abort", aborted);
        };
        peer.addEventListener("icegatheringstatechange", changed);
        startupSignal.addEventListener("abort", aborted, { once: true });
        changed();
        if (startupSignal.aborted) aborted();
      });
    }
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Missing voice offer");
    const answer = await negotiate(sdp, startupSignal);
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await ready;
    signal.throwIfAborted();
    startupSignal.removeEventListener("abort", startupAborted);
    signal.removeEventListener("abort", abort);
    callbacks.onConnect();
    tick = setInterval(() => {
      if (closed || ending) return;
      events.tick();
      if (inputAnalyser && inputSamples && !muted) {
        inputAnalyser.getByteTimeDomainData(inputSamples);
        const energy =
          inputSamples.reduce(
            (sum, value) => sum + ((value - 128) / 128) ** 2,
            0,
          ) / inputSamples.length;
        if (Math.sqrt(energy) > 0.025) lastInput = Date.now();
      }
      callbacks.onUserSpeaking(!muted && Date.now() - lastInput < 400);
      const volume = outputVolume();
      if (volume > 0.02) lastOutput = Date.now();
      callbacks.onModeChange({
        mode: Date.now() - lastOutput < 400 ? "speaking" : "listening",
      });
    }, 100);
    return {
      endSession: () => {
        ending ??= (async () => {
          events.close();
          // Stop recording immediately while the provider finalizes usage.
          for (const track of microphone?.getTracks() ?? []) track.stop();
          audio.pause();
          if (started && channel.readyState === "open") {
            channel.send(JSON.stringify({ type: "session.close" }));
            let timeout: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              finished.promise,
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, 3000);
              }),
            ]);
            clearTimeout(timeout);
          }
          await close();
        })();
        return ending;
      },
      publishUpdate: (update) => events.publishUpdate(update),
      setMicMuted: (value) => {
        muted = value;
        for (const track of microphone?.getAudioTracks() ?? [])
          track.enabled = !muted;
        if (muted) callbacks.onUserSpeaking(false);
      },
      getOutputVolume: outputVolume,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
