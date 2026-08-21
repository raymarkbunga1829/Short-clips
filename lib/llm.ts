/**
 * Optional script writing through any OpenAI-compatible chat completions API.
 *
 * Entirely optional: with no key set, callers fall back to the built-in writer
 * in script.ts. Set OPENAI_API_KEY (and optionally OPENAI_BASE_URL /
 * OPENAI_MODEL) in the Vercel project to get topic-specific writing.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT =
  "You write voiceover scripts for vertical short-form video (TikTok, YouTube Shorts). " +
  "You write the way people talk: short sentences, concrete nouns, no filler. " +
  "You never use emoji, hashtags, stage directions or speaker labels.";

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export function isLlmConfigured(): boolean {
  return Boolean(env("SHORTCLIPS_LLM_API_KEY", "OPENAI_API_KEY"));
}

function buildPrompt(topic: string, targetWords: number): string {
  return (
    `Write the narration for a short video about: ${topic}\n\n` +
    "Rules:\n" +
    `- About ${targetWords} words in total. Never more than ${Math.round(targetWords * 1.2)}.\n` +
    "- 3 to 6 lines. Each line is one or two spoken sentences.\n" +
    "- Line 1 is a hook of at most 12 words that stops the scroll.\n" +
    "- The middle lines say something specific and true about the topic.\n" +
    "- The last line lands the point or gives one clear next step.\n" +
    "- Plain spoken English. No markdown, no emoji, no hashtags, no labels.\n\n" +
    'Reply with JSON only: {"title": "4 to 6 word on-screen title", "lines": ["...", "..."]}'
  );
}

function extractJson(content: string): { title?: unknown; lines?: unknown } | null {
  let text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function draftScript(
  topic: string,
  targetWords: number,
): Promise<{ title: string; lines: string[] } | null> {
  const { cleanLine, countWords } = await import("./script");
  const key = env("SHORTCLIPS_LLM_API_KEY", "OPENAI_API_KEY");
  if (!key) return null;

  const baseUrl = (env("SHORTCLIPS_LLM_BASE_URL", "OPENAI_BASE_URL") ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: env("SHORTCLIPS_LLM_MODEL", "OPENAI_MODEL") ?? DEFAULT_MODEL,
        temperature: 0.85,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(topic, targetWords) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[shortclips] LLM request failed with HTTP ${response.status}`);
      return null;
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.lines)) return null;

    const lines = parsed.lines
      .filter((line): line is string => typeof line === "string")
      .map(cleanLine)
      .filter(Boolean);

    if (lines.length < 2 || lines.length > 8) return null;

    const words = countWords(lines.join(" "));
    if (words < targetWords * 0.5 || words > targetWords * 1.8) {
      console.warn(`[shortclips] LLM script was ${words} words, outside the budget.`);
      return null;
    }

    return {
      title: typeof parsed.title === "string" ? cleanLine(parsed.title) : "",
      lines,
    };
  } catch (error) {
    console.warn("[shortclips] LLM request errored:", (error as Error).message);
    return null;
  }
}
