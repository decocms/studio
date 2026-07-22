import { useRef, useState } from "react";

const WAVEFORM_BARS = 48;

export type VoiceInputStatus =
  | "idle"
  | "recording"
  | "unsupported"
  | "permission-denied";

export interface UseVoiceInputReturn {
  status: VoiceInputStatus;
  transcript: string;
  interimTranscript: string;
  waveformData: number[];
  isSupported: boolean;
  startRecording: () => Promise<VoiceInputStatus>;
  stopRecording: () => string;
  cancelRecording: () => void;
}

export function useVoiceInput(): UseVoiceInputReturn {
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [waveformData, setWaveformData] = useState<number[]>(() =>
    Array(WAVEFORM_BARS).fill(0.05),
  );

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);
  const isRecordingRef = useRef(false);
  const finalTranscriptRef = useRef("");
  // Capture interim at stop time since state may be stale in the closure
  const interimTranscriptRef = useRef("");

  const isSupported =
    typeof window !== "undefined" &&
    !!(
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    );

  const stopVisualizer = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((t) => t.stop());
    analyserRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
  };

  const startVisualizerWithStream = (stream: MediaStream) => {
    streamRef.current = stream;

    const ctx = new AudioContext();
    audioContextRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    analyserRef.current = analyser;

    const freqData = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(freqData);

      const bars: number[] = [];
      for (let i = 0; i < WAVEFORM_BARS; i++) {
        const idx = Math.floor((i / WAVEFORM_BARS) * freqData.length);
        bars.push(Math.max(0.04, (freqData[idx] ?? 0) / 255));
      }
      setWaveformData(bars);
      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const startRecording = async (): Promise<VoiceInputStatus> => {
    const SpeechRecognitionCtor =
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setStatus("unsupported");
      return "unsupported";
    }

    // Request microphone permission first — this triggers the browser prompt
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus("permission-denied");
      return "permission-denied";
    }

    setTranscript("");
    setInterimTranscript("");
    interimTranscriptRef.current = "";
    finalTranscriptRef.current = "";
    isRecordingRef.current = true;
    setStatus("recording");

    startVisualizerWithStream(stream);

    const recognition = new (
      SpeechRecognitionCtor as typeof SpeechRecognition
    )();
    recognitionRef.current = recognition;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let newFinal = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) {
          newFinal += text;
        } else {
          interim += text;
        }
      }
      if (newFinal) {
        finalTranscriptRef.current += newFinal;
        setTranscript(finalTranscriptRef.current);
      }
      interimTranscriptRef.current = interim;
      setInterimTranscript(interim);
    };

    recognition.onend = () => {
      if (isRecordingRef.current) {
        try {
          recognition.start();
        } catch {
          // Recognition may already be stopped
        }
      }
    };

    try {
      recognition.start();
    } catch {
      isRecordingRef.current = false;
      recognitionRef.current = null;
      stopVisualizer();
      setStatus("idle");
      return "idle";
    }
    return "recording";
  };

  const stopRecording = (): string => {
    isRecordingRef.current = false;
    recognitionRef.current?.stop();
    stopVisualizer();
    setStatus("idle");
    setWaveformData(Array(WAVEFORM_BARS).fill(0.05));
    setInterimTranscript("");

    const final = (
      finalTranscriptRef.current +
      (interimTranscriptRef.current ? " " + interimTranscriptRef.current : "")
    ).trim();

    setTranscript("");
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
    return final;
  };

  const cancelRecording = () => {
    isRecordingRef.current = false;
    recognitionRef.current?.abort();
    stopVisualizer();
    setStatus("idle");
    setTranscript("");
    setInterimTranscript("");
    setWaveformData(Array(WAVEFORM_BARS).fill(0.05));
    finalTranscriptRef.current = "";
    interimTranscriptRef.current = "";
  };

  return {
    status,
    transcript,
    interimTranscript,
    waveformData,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
