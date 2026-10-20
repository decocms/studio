export interface SoundAsset {
  /** Unique identifier for the sound */
  name: string;
  /** Base64-encoded data URI (data:audio/mpeg;base64,...) */
  dataUri: string;
  /** Duration in seconds */
  duration: number;
  /** Audio format */
  format: "mp3" | "wav" | "ogg";
  /** License identifier */
  license: "CC0" | "OGA-BY" | "MIT";
  /** Original author/creator */
  author: string;
}
