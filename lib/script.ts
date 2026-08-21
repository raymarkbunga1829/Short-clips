/**
 * Topic in, spoken script out.
 *
 * An OpenAI-compatible model is used when a key is configured; otherwise a
 * built-in writer produces a structured script so the app works with no keys.
 */

import { draftScript, isLlmConfigured } from "./llm";
import type { Script } from "./types";

/**
 * Measured delivery speed of the neural voices at their default rate, after the
 * padding around each line is trimmed. Used to turn seconds into a word budget.
 */
export const WORDS_PER_SECOND = 2.8;

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
const LABEL = /^\s*(?:[-*\u2022]|\(?\d+[.)]|\[[^\]]{0,24}\]|(?:hook|beat|line|body|cta|close|outro)\s*\d*\s*:)\s*/i;

export function cleanLine(raw: string): string {
  return String(raw)
    .replace(EMOJI, "")
    .replace(/[*#`_]/g, "")
    .replace(LABEL, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

export function wordsForDuration(seconds: number): number {
  return Math.max(12, Math.round(seconds * WORDS_PER_SECOND));
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * The topic rewritten so it reads naturally mid-sentence. "Cold showers"
 * becomes "cold showers", but "Why Rust is fast" keeps its capitals because a
 * later capitalised word usually means a proper noun.
 */
export function subjectForm(topic: string): string {
  const trimmed = topic.trim().replace(/[.!?]+$/, "").trim();
  if (!trimmed) return trimmed;
  const [head, ...rest] = trimmed.split(" ");
  const tail = rest.join(" ");
  if (head === head.toUpperCase() && head.length > 1) return trimmed;
  if (/[A-Z]/.test(tail)) return trimmed;
  return head.charAt(0).toLowerCase() + head.slice(1) + (tail ? ` ${tail}` : "");
}

export function titleForm(topic: string): string {
  const trimmed = topic.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  if (!trimmed) return "Short";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Small, stable string hash so the same topic always picks the same angle. */
export function hashTopic(topic: string): number {
  let hash = 2166136261;
  const normalised = topic.toLowerCase();
  for (let i = 0; i < normalised.length; i += 1) {
    hash ^= normalised.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

interface Angle {
  hook: string;
  beats: string[];
  close: string;
}

/**
 * Every frame here has to stay grammatical whether the topic is a noun phrase
 * ("cold showers") or a clause ("why small habits compound"), so the topic only
 * ever appears after "about", "understand" and similar.
 */
const ANGLES: Angle[] = [
  {
    hook: "Let's talk about {subject}.",
    beats: [
      "Most explanations bury you in detail and lose you in ten seconds.",
      "Use a frame instead.",
      "What problem does this solve, who does it help, and what does it cost?",
      "Answer those three and the details stop feeling like noise.",
    ],
    close: "That's the map. Fill it in.",
  },
  {
    hook: "Here's what most people miss about {subject}.",
    beats: [
      "From the outside it looks complicated, so everyone skips it.",
      "But almost every hard idea has one simple core.",
      "Everything else is decoration on top of that core.",
      "Find it first and the rest clicks into place.",
    ],
    close: "Go looking for the core. It's usually one sentence.",
  },
  {
    hook: "Why should you care about {subject}?",
    beats: [
      "Because the people who understand it move faster than the people who don't.",
      "Not because they're smarter.",
      "They just stopped guessing and started checking.",
      "One clear idea beats ten vague ones.",
    ],
    close: "Spend a little time here. It pays for itself.",
  },
  {
    hook: "If you only remember one thing about {subject}, make it this.",
    beats: [
      "Small and repeated beats big and rare.",
      "The first attempt is supposed to be rough.",
      "Do it badly, then do it again tomorrow.",
      "Momentum is the whole game, and it starts embarrassingly small.",
    ],
    close: "Start today, smaller than feels serious.",
  },
  {
    hook: "Nobody warns you about the boring part of {subject}.",
    beats: [
      "You put in real work and nothing visible happens.",
      "That's the part where most people quit.",
      "Then it moves all at once and everyone calls it luck.",
      "The flat stretch isn't failure. It's the price of admission.",
    ],
    close: "Stay in it long enough to get paid.",
  },
];

const EXTRA_BEATS = [
  "Write down what you already believe about it, then go check whether that's true.",
  "The gap between knowing this and using it is where most people quietly stop.",
  "Explain it to someone else. You'll find the hole in your understanding fast.",
];

/** Builds a script with no model and no network. Deterministic for a topic. */
export function templateScript(topic: string, targetWords: number, seed?: number): Script {
  const key = seed ?? hashTopic(topic);
  const angle = ANGLES[key % ANGLES.length];
  const subject = subjectForm(topic);

  const lines = [angle.hook.replace("{subject}", subject), ...angle.beats, angle.close];
  const total = () => countWords(lines.join(" "));

  // Trim and pad from the middle so the hook and the close always survive.
  while (lines.length > 3 && total() > targetWords * 1.12) lines.splice(-2, 1);
  for (let i = 0; i < EXTRA_BEATS.length && total() < targetWords * 0.85; i += 1) {
    lines.splice(-1, 0, EXTRA_BEATS[(key + i) % EXTRA_BEATS.length]);
  }

  return { topic, title: titleForm(topic), lines, source: "template" };
}

export async function writeScript(
  topic: string,
  options: { seconds: number; useLlm?: boolean; seed?: number },
): Promise<Script> {
  const cleanTopic = topic.replace(/\s+/g, " ").trim();
  const targetWords = wordsForDuration(options.seconds);

  if (options.useLlm !== false && isLlmConfigured()) {
    const drafted = await draftScript(cleanTopic, targetWords);
    if (drafted) {
      return {
        topic: cleanTopic,
        title: drafted.title || titleForm(cleanTopic),
        lines: drafted.lines,
        source: "llm",
      };
    }
  }

  return templateScript(cleanTopic, targetWords, options.seed);
}
