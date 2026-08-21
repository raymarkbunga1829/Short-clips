"use client";

import { useEffect, useRef, useState } from "react";

import { DEFAULT_VOICE, EXAMPLE_TOPICS, LENGTH_CHOICES, LIMITS, VOICES } from "@/lib/options";

interface ClipSummary {
  topic: string;
  title: string;
  lines: string[];
  scriptSource: "llm" | "template";
  voiceEngine: string;
  seconds: number;
}

interface Clip {
  url: string;
  blob: Blob;
  filename: string;
  summary: ClipSummary | null;
}

/** Headers are latin-1, so the summary arrives base64 encoded. */
function decodeSummary(value: string | null): ClipSummary | null {
  if (!value) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as ClipSummary;
  } catch {
    return null;
  }
}

/** Roughly tracks the stages the server works through, for a bit of reassurance. */
function stageMessage(elapsed: number): string {
  if (elapsed < 4) return "Writing the script…";
  if (elapsed < 12) return "Recording the voiceover…";
  return "Rendering 1080 × 1920…";
}

export default function Home() {
  const [topic, setTopic] = useState("");
  const [seconds, setSeconds] = useState(15);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [canShare, setCanShare] = useState(false);

  const clipRef = useRef<Clip | null>(null);
  clipRef.current = clip;

  useEffect(() => {
    return () => {
      if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
    };
  }, []);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!clip) return;
    const file = new File([clip.blob], clip.filename, { type: "video/mp4" });
    setCanShare(Boolean(navigator.canShare?.({ files: [file] })));
  }, [clip]);

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmed, seconds, voice }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Generation failed (${response.status}).`);
      }

      const blob = await response.blob();
      const summary = decodeSummary(response.headers.get("X-Clip-Summary"));
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "short.mp4";

      if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
      setClip({ url: URL.createObjectURL(blob), blob, filename, summary });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!clip) return;
    const file = new File([clip.blob], clip.filename, { type: "video/mp4" });
    try {
      await navigator.share({ files: [file], title: clip.summary?.title ?? "Short clip" });
    } catch {
      // The user dismissed the share sheet; nothing to do.
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Short-clips</h1>
        <p>Type a topic. Get a 9:16 clip with a voiceover and burned-in captions.</p>
      </header>

      <form className="card" onSubmit={generate}>
        <div className="field">
          <label htmlFor="topic">Topic</label>
          <input
            id="topic"
            type="text"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="Why small habits compound"
            maxLength={LIMITS.maxTopicLength}
            enterKeyHint="go"
            autoComplete="off"
          />
          <div className="examples">
            {EXAMPLE_TOPICS.map((example) => (
              <button
                key={example}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => setTopic(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label id="length-label">Length</label>
            <div className="segmented" role="group" aria-labelledby="length-label">
              {LENGTH_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={seconds === choice}
                  onClick={() => setSeconds(choice)}
                  disabled={busy}
                >
                  {choice}s
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="voice">Voice</label>
            <select
              id="voice"
              value={voice}
              onChange={(event) => setVoice(event.target.value)}
              disabled={busy}
            >
              {VOICES.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button className="primary" type="submit" disabled={busy || topic.trim().length === 0}>
          {busy ? "Generating…" : "Generate clip"}
        </button>

        {busy && (
          <div className="status" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>
              {stageMessage(elapsed)} {elapsed}s
            </span>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </form>

      {clip && (
        <section className="card" aria-label="Your clip">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- captions are burned into the video */}
          <video className="player" src={clip.url} controls playsInline autoPlay preload="auto" />

          <div className="actions">
            <a className="secondary" href={clip.url} download={clip.filename}>
              Save
            </a>
            {canShare && (
              <button type="button" className="secondary" onClick={share}>
                Share
              </button>
            )}
          </div>

          {clip.summary && (
            <>
              <ul className="script">
                {clip.summary.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
              <p className="meta">
                {clip.summary.seconds.toFixed(1)}s · script by{" "}
                {clip.summary.scriptSource === "llm" ? "your model" : "the built-in writer"} · voice
                by {clip.summary.voiceEngine}
              </p>
            </>
          )}
        </section>
      )}

      <details>
        <summary>Trigger a clip from somewhere else</summary>
        <p>
          The same endpoint answers a plain GET, so a bot or a shortcut can request a clip and get
          the mp4 straight back.
        </p>
        <pre>curl -L -o short.mp4 &quot;$ORIGIN/api/generate?topic=Why+small+habits+compound&quot;</pre>
      </details>

      <footer>
        Free voice from Edge TTS, video from ffmpeg. No account, no upload.
      </footer>
    </main>
  );
}
