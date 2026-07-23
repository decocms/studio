// ============================================================================
// VoiceWaveform - Animated waveform visualization
// ============================================================================

interface VoiceWaveformProps {
  data: number[];
}

export function VoiceWaveform({ data }: VoiceWaveformProps) {
  return (
    <div
      className="flex items-center justify-center gap-[2px] h-10 overflow-hidden"
      aria-hidden="true"
    >
      {data.map((amp, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static bars
          key={i}
          className="w-[2px] shrink-0 rounded-full bg-chart-2 transition-[height] duration-75 ease-out"
          style={{ height: `${Math.max(4, Math.round(amp * 40))}px` }}
        />
      ))}
    </div>
  );
}
