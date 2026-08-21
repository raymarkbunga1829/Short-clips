/**
 * topic -> script -> voice -> captions -> mp4
 *
 * Everything runs in one request inside a temporary directory, which is what
 * lets the whole thing live in a single serverless function.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CAPTION_FONT_NAME, ensureFontsDir } from "./assets";
import { buildAss, groupWords } from "./captions";
import { DEFAULT_VOICE, LIMITS, VOICES } from "./options";
import { pickPalette } from "./palettes";
import { renderVideo } from "./render";
import { WORDS_PER_SECOND, countWords, writeScript } from "./script";
import type { ClipResult } from "./types";
import { narrate } from "./voice";

export const TIMING = {
  /** Silence before the first word. */
  leadIn: 0.35,
  /** Silence between spoken lines. */
  gap: 0.2,
  /** Silence after the last word, so the clip does not cut off abruptly. */
  tail: 0.7,
};

export class ClipError extends Error {}

export interface CreateClipOptions {
  topic: string;
  seconds?: number;
  voice?: string;
  palette?: string;
  useLlm?: boolean;
  /** Where the temporary working directory is created. */
  workRoot?: string;
}

export function normaliseTopic(raw: unknown): string {
  const topic = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!topic) throw new ClipError("Type a topic first.");
  if (topic.length > LIMITS.maxTopicLength) {
    throw new ClipError(`Keep the topic under ${LIMITS.maxTopicLength} characters.`);
  }
  return topic;
}

export function clampSeconds(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return LIMITS.defaultSeconds;
  return Math.min(LIMITS.maxSeconds, Math.max(LIMITS.minSeconds, Math.round(value)));
}

/**
 * Picks a speaking rate that lands the finished clip near the requested length.
 * The small bias keeps short-form delivery punchy, and errs under the target
 * rather than over it.
 */
const RATE_BIAS_PERCENT = 3;

export function speakingRate(wordCount: number, seconds: number, lineCount: number): string {
  const speechBudget = Math.max(
    seconds - TIMING.leadIn - TIMING.tail - Math.max(lineCount - 1, 0) * TIMING.gap,
    4,
  );
  const naturalSeconds = wordCount / WORDS_PER_SECOND;
  const adjustment = Math.round((naturalSeconds / speechBudget - 1) * 100);
  const percent = Math.min(40, Math.max(-5, adjustment + RATE_BIAS_PERCENT));
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}

export async function createClip(options: CreateClipOptions): Promise<ClipResult> {
  const topic = normaliseTopic(options.topic);
  const seconds = clampSeconds(options.seconds ?? LIMITS.defaultSeconds);
  const voice = VOICES.some((entry) => entry.id === options.voice)
    ? (options.voice as string)
    : DEFAULT_VOICE;

  const startedAt = Date.now();
  const script = await writeScript(topic, { seconds, useLlm: options.useLlm });
  const palette = pickPalette(topic, options.palette);
  const fontsDir = ensureFontsDir();

  const workDir = await mkdtemp(path.join(options.workRoot ?? os.tmpdir(), "shortclip-"));

  try {
    const narration = await narrate(script.lines, {
      voice,
      rate: speakingRate(countWords(script.lines.join(" ")), seconds, script.lines.length),
      workDir,
      leadIn: TIMING.leadIn,
      gap: TIMING.gap,
      tail: TIMING.tail,
    });

    const cues = groupWords(narration.lines);
    const assFile = path.join(workDir, "captions.ass");
    await writeFile(
      assFile,
      buildAss({
        cues,
        title: script.title,
        duration: narration.totalDuration,
        accent: palette.accent,
        fontName: CAPTION_FONT_NAME,
      }),
      "utf8",
    );

    const outFile = path.join(workDir, "short.mp4");
    await renderVideo({
      narration,
      palette,
      assFile,
      fontsDir,
      workDir,
      outFile,
      leadIn: TIMING.leadIn,
      gap: TIMING.gap,
    });

    const { size } = await stat(outFile);
    return {
      file: outFile,
      script,
      duration: narration.totalDuration,
      voice,
      palette: palette.id,
      engine: narration.engine,
      bytes: size,
      renderMs: Date.now() - startedAt,
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true });
    throw error;
  }
}
