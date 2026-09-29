import type { ConversationCallbacks, VoiceConversation } from "./conversation";
import { OpenAIConversationEvents } from "./openai-events";

export async function startOpenAIConversation(
  clientSecret: string,
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
  const events = new OpenAIConversationEvents((event) => {
    if (!closed && channel.readyState === "open")
      channel.send(JSON.stringify(event));
  }, callbacks);
  const close = async () => {
    if (closed) return;
    closed = true;
    events.close();
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
  const ready = new Promise<void>((resolve, reject) => {
    const aborted = () => reject(startupSignal.reason);
    const opened = () => {
      startupSignal.removeEventListener("abort", aborted);
      resolve();
    };
    startupSignal.addEventListener("abort", aborted, { once: true });
    channel.addEventListener("open", opened, { once: true });
  });
  // SDP or microphone setup can fail before the channel opens.
  void ready.catch(() => {});
  channel.onmessage = ({ data }) => {
    if (closed || typeof data !== "string") return;
    try {
      events.receive(JSON.parse(data));
    } catch {
      callbacks.onError();
    }
  };
  channel.onclose = () => {
    if (!closed) callbacks.onDisconnect();
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
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    startupSignal.throwIfAborted();
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
      signal: startupSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Voice connection unavailable");
    }
    await peer.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
    await ready;
    signal.throwIfAborted();
    callbacks.onConnect();
    return {
      endSession: close,
      sendContextualUpdate: (text, options) =>
        events.contextualUpdate(text, options?.contextId),
      sendUserMessage: (text) => events.userMessage(text),
      setMicMuted: (muted) => {
        for (const track of microphone?.getAudioTracks() ?? [])
          track.enabled = !muted;
        if (muted) callbacks.onUserSpeaking(false);
      },
      getOutputVolume: () => {
        if (!analyser || !samples || closed) return 0;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += ((value - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / samples.length) * 4);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
