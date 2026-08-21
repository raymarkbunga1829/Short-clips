/**
 * The video itself: one ffmpeg pass that builds an animated gradient
 * background, joins the narration clips, burns in the captions and encodes an
 * mp4 that phones can play inline.
 */

import path from "node:path";

import { escapeFilterValue, runFfmpeg } from "./ffmpeg";
import type { Palette } from "./palettes";
import type { Narration } from "./types";

export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
};

/** ffmpeg's colour parser prefers 0xRRGGBB over CSS-style hashes. */
function ffColor(hex: string): string {
  return `0x${hex.replace("#", "").toUpperCase()}`;
}

export function gradientInput(palette: Palette, duration: number): string {
  const [c0, c1, c2] = palette.colors;
  return [
    "gradients",
    `=s=${VIDEO.width}x${VIDEO.height}`,
    `:c0=${ffColor(c0)}:c1=${ffColor(c1)}:c2=${ffColor(c2)}`,
    ":n=3",
    `:type=${palette.type}`,
    ":x0=0:y0=0",
    `:x1=${VIDEO.width}:y1=${VIDEO.height}`,
    ":speed=0.004",
    `:d=${duration.toFixed(3)}`,
    `:r=${VIDEO.fps}`,
  ].join("");
}

export interface GraphLine {
  /** Seconds of the source clip to keep, dropping the voice's padding. */
  trimStart: number;
  trimEnd: number;
}

export interface GraphOptions {
  lines: GraphLine[];
  leadIn: number;
  gap: number;
  duration: number;
  assFile: string;
  fontsDir: string;
  /** Sample rate of the narration clips, which the silences must match. */
  speechRate?: number;
}

/**
 * Silences are generated inside the graph rather than as extra inputs, so the
 * whole clip is one ffmpeg invocation with no intermediate files.
 */
export function buildFilterGraph(options: GraphOptions): string {
  const rate = options.speechRate ?? 24000;
  const format = `aformat=sample_fmts=s16:sample_rates=${rate}:channel_layouts=mono`;
  const parts: string[] = [];
  const order: string[] = [];

  parts.push(`anullsrc=r=${rate}:cl=mono:d=${options.leadIn.toFixed(3)},${format}[lead]`);
  order.push("[lead]");

  for (let index = 0; index < options.lines.length; index += 1) {
    const line = options.lines[index];
    // Input 0 is the generated background, so the audio inputs start at 1.
    parts.push(
      `[${index + 1}:a]atrim=start=${line.trimStart.toFixed(3)}:end=${line.trimEnd.toFixed(3)},` +
        `asetpts=N/SR/TB,${format}[v${index}]`,
    );
    order.push(`[v${index}]`);
    if (index < options.lines.length - 1) {
      parts.push(`anullsrc=r=${rate}:cl=mono:d=${options.gap.toFixed(3)},${format}[g${index}]`);
      order.push(`[g${index}]`);
    }
  }

  parts.push(`${order.join("")}concat=n=${order.length}:v=0:a=1[speech]`);

  // The voice comes back quieter than phone speakers want, so lift it and cap
  // the peaks rather than clipping them.
  const fadeOut = Math.max(options.duration - 0.45, 0.1);
  parts.push(
    `[speech]aresample=44100,volume=5dB,alimiter=limit=0.95:level=disabled,apad,` +
      `atrim=0:${options.duration.toFixed(3)},asetpts=N/SR/TB,` +
      `afade=t=out:st=${fadeOut.toFixed(3)}:d=0.45[audio]`,
  );

  parts.push(
    "[0:v]eq=brightness=-0.05:saturation=1.08,vignette=PI/4," +
      // No fade from black: the first frame doubles as the poster in the
      // player, so it needs to show the background and title straight away.
      `ass=${escapeFilterValue(options.assFile)}:fontsdir=${escapeFilterValue(options.fontsDir)},` +
      "format=yuv420p[video]",
  );

  return parts.join(";");
}

export interface RenderOptions {
  narration: Narration;
  palette: Palette;
  assFile: string;
  fontsDir: string;
  workDir: string;
  outFile: string;
  leadIn: number;
  gap: number;
  timeoutMs?: number;
}

export async function renderVideo(options: RenderOptions): Promise<string> {
  const { narration } = options;
  const duration = narration.totalDuration;

  const graph = buildFilterGraph({
    lines: narration.lines.map((line) => ({
      trimStart: line.trimStart,
      trimEnd: line.trimEnd,
    })),
    leadIn: options.leadIn,
    gap: options.gap,
    duration,
    // ffmpeg runs with the work directory as its cwd, so relative names avoid
    // any path escaping problems inside the filtergraph.
    assFile: path.basename(options.assFile),
    fontsDir: options.fontsDir,
  });

  const args = [
    "-f", "lavfi",
    "-i", gradientInput(options.palette, duration),
    ...narration.lines.flatMap((line) => ["-i", path.basename(line.file)]),
    "-filter_complex", graph,
    "-map", "[video]",
    "-map", "[audio]",
    "-t", duration.toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "25",
    "-profile:v", "high",
    "-level", "4.0",
    "-pix_fmt", "yuv420p",
    "-r", String(VIDEO.fps),
    "-g", String(VIDEO.fps * 2),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-movflags", "+faststart",
    path.basename(options.outFile),
  ];

  await runFfmpeg(args, { cwd: options.workDir, timeoutMs: options.timeoutMs ?? 180_000 });
  return options.outFile;
}
