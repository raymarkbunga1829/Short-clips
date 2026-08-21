export interface WordTiming {
  text: string;
  /** Seconds from the start of the finished clip. */
  start: number;
  end: number;
}

export interface SpokenLine {
  text: string;
  /** Absolute path of the synthesised audio for this line. */
  file: string;
  /** Offsets into the audio file, excluding the silence the voice pads with. */
  trimStart: number;
  trimEnd: number;
  /** Length of the trimmed audio, i.e. trimEnd - trimStart. */
  duration: number;
  /** Where this line begins on the finished clip's timeline. */
  start: number;
  words: WordTiming[];
}

export interface Narration {
  lines: SpokenLine[];
  /** Where the last word stops. */
  speechEnd: number;
  /** Length of the finished clip, including lead-in and tail. */
  totalDuration: number;
  engine: "edge" | "translate";
  /** True when word timings were estimated rather than reported by the voice service. */
  estimatedTimings: boolean;
}

export interface Script {
  topic: string;
  title: string;
  lines: string[];
  source: "llm" | "template";
}

export interface Cue {
  start: number;
  end: number;
  words: WordTiming[];
}

export interface ClipOptions {
  topic: string;
  seconds: number;
  voice: string;
  palette?: string;
  useLlm: boolean;
}

export interface ClipResult {
  file: string;
  script: Script;
  duration: number;
  voice: string;
  palette: string;
  engine: string;
  bytes: number;
  renderMs: number;
}
