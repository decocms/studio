import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useVoiceInput } from "./use-voice-input";

describe("useVoiceInput.startRecording", () => {
  const win = window as unknown as Record<string, unknown>;
  let originalSpeechRecognition: unknown;

  beforeEach(() => {
    originalSpeechRecognition = win.SpeechRecognition;
  });

  afterEach(() => {
    win.SpeechRecognition = originalSpeechRecognition;
    delete win.webkitSpeechRecognition;
  });

  it("resolves 'unsupported' when the browser has no SpeechRecognition", async () => {
    delete win.SpeechRecognition;
    delete win.webkitSpeechRecognition;

    const { result } = renderHook(() => useVoiceInput());

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.startRecording();
    });

    expect(outcome).toBe("unsupported");
    expect(result.current.status).toBe("unsupported");
  });

  it("resolves 'permission-denied' when getUserMedia rejects", async () => {
    win.SpeechRecognition =
      function () {} as unknown as typeof SpeechRecognition;
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () => Promise.reject(new Error("denied")),
      },
      configurable: true,
    });

    const { result } = renderHook(() => useVoiceInput());

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.startRecording();
    });

    expect(outcome).toBe("permission-denied");
    expect(result.current.status).toBe("permission-denied");

    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });
  });

  it("stops the mic stream when recognition.start() throws", async () => {
    let stopCalls = 0;
    win.SpeechRecognition = function () {
      return {
        start() {
          throw new Error("already started");
        },
        stop() {},
        abort() {},
      };
    } as unknown as typeof SpeechRecognition;

    const originalAudioContext = win.AudioContext;
    win.AudioContext = function () {
      return {
        createMediaStreamSource: () => ({ connect: () => {} }),
        createAnalyser: () => ({
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 0,
          getByteFrequencyData: () => {},
        }),
        close: () => Promise.resolve(),
      };
    };

    const track = { stop: () => stopCalls++ };
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () =>
          Promise.resolve({
            getTracks: () => [track],
          } as unknown as MediaStream),
      },
      configurable: true,
    });

    const { result } = renderHook(() => useVoiceInput());

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.startRecording();
    });

    expect(outcome).toBe("idle");
    expect(result.current.status).toBe("idle");
    expect(stopCalls).toBe(1);

    win.AudioContext = originalAudioContext;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });
  });
});
