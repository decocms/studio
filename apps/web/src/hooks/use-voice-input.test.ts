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

  it("stops recording instead of busy-looping restarts on a fatal recognition error", async () => {
    let startCalls = 0;
    let recognition: {
      start: () => void;
      stop: () => void;
      abort: () => void;
      onerror?: (event: { error: string }) => void;
      onend?: () => void;
    };
    win.SpeechRecognition = function () {
      recognition = {
        start() {
          startCalls++;
        },
        stop() {},
        abort() {},
      };
      return recognition;
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

    const track = { stop: () => {} };
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

    // Stub the visualizer's rAF loop so it doesn't outlive the test.
    const originalRaf = win.requestAnimationFrame;
    const originalCaf = win.cancelAnimationFrame;
    win.requestAnimationFrame = (() =>
      1) as unknown as typeof win.requestAnimationFrame;
    win.cancelAnimationFrame =
      (() => {}) as unknown as typeof win.cancelAnimationFrame;

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.startRecording();
    });
    expect(startCalls).toBe(1);

    await act(async () => {
      recognition.onerror?.({ error: "network" });
      recognition.onend?.();
    });

    expect(result.current.status).toBe("idle");
    // onend must not restart a recognizer that just fatally errored.
    expect(startCalls).toBe(1);

    win.AudioContext = originalAudioContext;
    win.requestAnimationFrame = originalRaf;
    win.cancelAnimationFrame = originalCaf;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });
  });

  it("ignores a cancelled recognizer's late error once a newer one has started", async () => {
    const instances: Array<{
      onerror?: (event: { error: string }) => void;
      onend?: () => void;
    }> = [];
    win.SpeechRecognition = function () {
      const instance: {
        start: () => void;
        stop: () => void;
        abort: () => void;
        onerror?: (event: { error: string }) => void;
        onend?: () => void;
      } = { start() {}, stop() {}, abort() {} };
      instances.push(instance);
      return instance;
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

    const track = { stop: () => {} };
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

    const originalRaf = win.requestAnimationFrame;
    const originalCaf = win.cancelAnimationFrame;
    win.requestAnimationFrame = (() =>
      1) as unknown as typeof win.requestAnimationFrame;
    win.cancelAnimationFrame =
      (() => {}) as unknown as typeof win.cancelAnimationFrame;

    const { result } = renderHook(() => useVoiceInput());

    await act(async () => {
      await result.current.startRecording();
    });
    act(() => result.current.cancelRecording());
    await act(async () => {
      await result.current.startRecording();
    });
    expect(instances.length).toBe(2);
    expect(result.current.status).toBe("recording");

    // The cancelled recognizer's abort() resolves late as an "aborted" error.
    act(() => instances[0]?.onerror?.({ error: "aborted" }));

    expect(result.current.status).toBe("recording");

    win.AudioContext = originalAudioContext;
    win.requestAnimationFrame = originalRaf;
    win.cancelAnimationFrame = originalCaf;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: originalGetUserMedia },
      configurable: true,
    });
  });
});
