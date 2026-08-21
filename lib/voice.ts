/**
 * Turns script lines into narration audio plus a word-accurate timeline.
 *
 * Each line is synthesised separately so captions can never drift across a
 * sentence boundary, and so a small pause can be inserted between lines.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { EdgeTtsSession, type EdgeWord } from "./edge-tts";
import { mp3Duration } from "./mp3";
import type { Narration, SpokenLine, WordTiming } from "./types";

export class VoiceError extends Error {}

/** Breathing room kept around the speech when trimming a line's padding. */
const HEAD_PADDING = 0.06;
const TAIL_PADDING = 0.16;

export interface NarrateOptions {
  voice: string;
  rate: string;
  workDir: string;
  /** Silence before the first word. */
  leadIn: number;
  /** Silence between lines. */
  gap: number;
  /** Silence after the last word. */
  tail: number;
}

interface RawSpeech {
  audio: Buffer;
  words: EdgeWord[];
}

/**
 * Spreads a line's duration over its words, weighted by length. Used for voices
 * or engines that return audio without timing metadata.
 */
export function estimateWords(text: string, duration: number): EdgeWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const weights = tokens.map((token) => token.replace(/[^\p{L}\p{N}]/gu, "").length + 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = 0;
  return tokens.map((token, index) => {
    const share = (weights[index] / totalWeight) * duration;
    const word = { text: token, offset: cursor, duration: share };
    cursor += share;
    return word;
  });
}

async function speakWithEdge(lines: string[], options: NarrateOptions): Promise<RawSpeech[]> {
  const session = new EdgeTtsSession({ voice: options.voice, rate: options.rate });
  try {
    const results: RawSpeech[] = [];
    for (const line of lines) {
      const speech = await session.speak(line);
      if (speech.audio.length === 0) throw new Error(`No audio returned for: "${line}"`);
      results.push(speech);
    }
    return results;
  } finally {
    session.dispose();
  }
}

/**
 * Backup voice for the rare case where the Edge service is unreachable. It
 * returns no timing metadata, so word times are estimated from the text.
 */
async function speakWithTranslate(lines: string[]): Promise<RawSpeech[]> {
  const results: RawSpeech[] = [];
  for (const line of lines) {
    // The endpoint truncates long inputs, so send it in sentence-sized pieces.
    const chunks = chunkText(line, 180);
    const parts: Buffer[] = [];
    for (const chunk of chunks) {
      const url =
        "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q=" +
        encodeURIComponent(chunk);
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Backup voice returned HTTP ${response.status}`);
      parts.push(Buffer.from(await response.arrayBuffer()));
    }
    results.push({ audio: Buffer.concat(parts), words: [] });
  }
  return results;
}

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const piece of text.split(/(?<=[.!?,;:])\s+/)) {
    if (current && `${current} ${piece}`.length > limit) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function narrate(lines: string[], options: NarrateOptions): Promise<Narration> {
  const usable = lines.map((line) => line.trim()).filter(Boolean);
  if (usable.length === 0) throw new VoiceError("There is nothing to say.");

  let engine: Narration["engine"] = "edge";
  let speeches: RawSpeech[];
  try {
    speeches = await speakWithEdge(usable, options);
  } catch (edgeError) {
    console.warn("[shortclips] Edge voice failed:", (edgeError as Error).message);
    try {
      speeches = await speakWithTranslate(usable);
      engine = "translate";
    } catch (backupError) {
      throw new VoiceError(
        `Could not reach a text-to-speech service. Edge said: ${(edgeError as Error).message}. ` +
          `Backup said: ${(backupError as Error).message}.`,
      );
    }
  }

  let estimatedTimings = engine !== "edge";
  let cursor = options.leadIn;
  const spoken: SpokenLine[] = [];

  for (let index = 0; index < usable.length; index += 1) {
    const { audio, words } = speeches[index];
    const file = path.join(options.workDir, `line-${index}.mp3`);
    await writeFile(file, audio);

    const fileDuration = mp3Duration(audio);
    if (!Number.isFinite(fileDuration) || fileDuration <= 0) {
      throw new VoiceError(`Voice audio for line ${index + 1} was unreadable.`);
    }

    let source = words;
    if (source.length === 0) {
      source = estimateWords(usable[index], fileDuration);
      estimatedTimings = true;
    }

    // The voice pads every clip with silence. Cutting back to the words keeps
    // the pacing tight and makes the finished length predictable.
    const last = source[source.length - 1];
    const trimStart = words.length > 0 ? Math.max(0, source[0].offset - HEAD_PADDING) : 0;
    const trimEnd =
      words.length > 0
        ? Math.min(fileDuration, last.offset + last.duration + TAIL_PADDING)
        : fileDuration;
    const duration = Math.max(trimEnd - trimStart, 0.2);

    const lineStart = cursor;
    const lineEnd = cursor + duration;
    const timed: WordTiming[] = source.map((word) => {
      const start = Math.min(lineStart + Math.max(word.offset - trimStart, 0), lineEnd);
      const end = Math.min(start + Math.max(word.duration, 0.08), lineEnd);
      return { text: word.text, start, end };
    });

    spoken.push({
      text: usable[index],
      file,
      trimStart,
      trimEnd,
      duration,
      start: lineStart,
      words: timed,
    });
    cursor = lineEnd + options.gap;
  }

  const speechEnd = cursor - options.gap;
  return {
    lines: spoken,
    speechEnd,
    totalDuration: Number((speechEnd + options.tail).toFixed(3)),
    engine,
    estimatedTimings,
  };
}
