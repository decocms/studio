import { join } from "path";
import { mkdirSync, readdirSync } from "fs";
import playlist from "./playlist.json";

interface Track {
  title: string;
  url: string;
}

const tracks: Track[] = playlist.tracks;

let currentProcess: ReturnType<typeof Bun.spawn> | null = null;
let playing = false;
let generation = 0;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function downloadIfNeeded(
  track: Track,
  soundsDir: string,
): Promise<string> {
  const filePath = join(soundsDir, `${toSlug(track.title)}.mp3`);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return filePath;
  }
  const response = await fetch(track.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${track.title}: ${response.status}`);
  }
  await Bun.write(filePath, response);
  return filePath;
}

function pickRandom(): Track {
  return tracks[Math.floor(Math.random() * tracks.length)]!;
}

function findCachedTrack(soundsDir: string): string | null {
  try {
    const files = readdirSync(soundsDir).filter((f) => f.endsWith(".mp3"));
    if (files.length === 0) return null;
    return join(soundsDir, files[Math.floor(Math.random() * files.length)]!);
  } catch {
    return null;
  }
}

async function playTrack(dataDir: string, gen: number, preferCached: boolean) {
  if (!playing || gen !== generation) return;

  const soundsDir = join(dataDir, "sounds");
  mkdirSync(soundsDir, { recursive: true });

  try {
    let filePath: string | null = null;

    if (preferCached) {
      filePath = findCachedTrack(soundsDir);
    }

    if (!filePath) {
      const track = pickRandom();
      filePath = await downloadIfNeeded(track, soundsDir);
    }

    if (!playing || gen !== generation) return;

    currentProcess = Bun.spawn(["afplay", filePath], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    await currentProcess.exited;
    currentProcess = null;
    consecutiveFailures = 0;

    if (playing && gen === generation) {
      playTrack(dataDir, gen, false);
    }
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      playing = false;
      return;
    }
    if (playing && gen === generation) {
      setTimeout(() => playTrack(dataDir, gen, false), 2000);
    }
  }
}

let cleanupRegistered = false;

export function startVibe(dataDir: string): void {
  if (playing) return;
  playing = true;
  consecutiveFailures = 0;
  generation++;
  playTrack(dataDir, generation, true);

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", stopVibe);
  }
}

function stopVibe(): void {
  playing = false;
  generation++;
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}

export function toggleVibe(dataDir: string): void {
  if (playing) {
    stopVibe();
  } else {
    startVibe(dataDir);
  }
}
