declare const __STUDIO_VERSION__: string;
declare const __E2E_TEST_HOOKS__: boolean;

/**
 * Monaco reads its worker/trusted-types hooks off this global. `monaco-editor`
 * declares it too, but only in the module graph of its runtime entry, which
 * this app never imports statically — the engine is loaded at runtime from
 * `MONACO_VS_PATH`. `var`, not `let`, so `globalThis.MonacoEnvironment` types.
 */
declare var MonacoEnvironment: import("monaco-editor").Environment | undefined;

declare module "*?raw" {
  const content: string;
  export default content;
}

// Web Speech API — not yet included in TypeScript's lib.dom.d.ts
interface SpeechRecognitionEventMap {
  result: SpeechRecognitionEvent;
  end: Event;
  error: SpeechRecognitionErrorEvent;
  start: Event;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  grammars: SpeechGrammarList;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  abort(): void;
  start(): void;
  stop(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onstart: ((ev: Event) => void) | null;
  addEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (ev: SpeechRecognitionEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition;
  new (): SpeechRecognition;
};

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly confidence: number;
  readonly transcript: string;
}

interface SpeechGrammar {
  src: string;
  weight: number;
}

interface SpeechGrammarList {
  readonly length: number;
  addFromString(string: string, weight?: number): void;
  addFromURI(src: string, weight?: number): void;
  item(index: number): SpeechGrammar;
  [index: number]: SpeechGrammar;
}

declare var SpeechGrammarList: {
  prototype: SpeechGrammarList;
  new (): SpeechGrammarList;
};

declare module "ansi-to-html" {
  interface AnsiToHtmlOptions {
    fg?: string;
    bg?: string;
    newline?: boolean;
    escapeXML?: boolean;
    stream?: boolean;
    colors?: string[] | Record<number, string>;
  }
  class Convert {
    constructor(options?: AnsiToHtmlOptions);
    toHtml(input: string): string;
  }
  export default Convert;
}
