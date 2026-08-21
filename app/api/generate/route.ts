/**
 * The one endpoint that matters: topic in, mp4 out.
 *
 *   GET  /api/generate?topic=Why%20small%20habits%20compound
 *   POST /api/generate  {"topic": "...", "seconds": 15, "voice": "..."}
 *
 * The response is the video itself, streamed so it is not subject to the 4.5 MB
 * cap on buffered function responses. A GET works from a browser address bar or
 * a one-line curl, which is all another bot needs to trigger a clip.
 */

import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { ClipError, createClip } from "@/lib/pipeline";
import { LIMITS } from "@/lib/options";
import type { ClipResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Hobby plans allow up to 300s; a clip normally lands well inside that. */
export const maxDuration = 300;

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 6 };
const recentRequests = new Map<string, number[]>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0].trim() || request.headers.get("x-real-ip") || "anonymous";
}

/**
 * Best-effort throttle. Function instances are recycled, so this is a speed
 * bump for a public URL rather than a guarantee.
 */
function isRateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (recentRequests.get(key) ?? []).filter((at) => now - at < RATE_LIMIT.windowMs);
  hits.push(now);
  recentRequests.set(key, hits);

  if (recentRequests.size > 500) {
    for (const [entry, times] of recentRequests) {
      if (times.every((at) => now - at >= RATE_LIMIT.windowMs)) recentRequests.delete(entry);
    }
  }

  return hits.length > RATE_LIMIT.maxRequests;
}

function slugify(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "short";
}

function videoResponse(result: ClipResult, download: boolean): Response {
  const workDir = path.dirname(result.file);
  const stream = createReadStream(result.file);
  // The clip only exists in a temp directory, so clean up once it is sent.
  const cleanup = () => {
    void rm(workDir, { recursive: true, force: true });
  };
  stream.once("close", cleanup);
  stream.once("error", cleanup);

  const filename = `${slugify(result.script.topic)}.mp4`;
  const summary = {
    topic: result.script.topic,
    title: result.script.title,
    lines: result.script.lines,
    scriptSource: result.script.source,
    voice: result.voice,
    palette: result.palette,
    voiceEngine: result.engine,
    seconds: result.duration,
    renderMs: result.renderMs,
  };

  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(result.bytes),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Clip-Duration": result.duration.toFixed(2),
      "X-Clip-Voice-Engine": result.engine,
      "X-Clip-Script-Source": result.script.source,
      // Headers must be latin-1, so the script travels base64 encoded.
      "X-Clip-Summary": Buffer.from(JSON.stringify(summary), "utf8").toString("base64"),
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function handle(
  request: Request,
  params: { topic: unknown; seconds?: unknown; voice?: unknown; palette?: unknown; download?: boolean },
): Promise<Response> {
  if (isRateLimited(clientKey(request))) {
    return errorResponse("Too many clips at once. Wait a minute and try again.", 429);
  }

  try {
    const result = await createClip({
      topic: String(params.topic ?? ""),
      seconds: params.seconds === undefined ? LIMITS.defaultSeconds : Number(params.seconds),
      voice: params.voice === undefined ? undefined : String(params.voice),
      palette: params.palette === undefined ? undefined : String(params.palette),
    });
    return videoResponse(result, Boolean(params.download));
  } catch (error) {
    if (error instanceof ClipError) return errorResponse(error.message, 400);
    const message = error instanceof Error ? error.message : "Something went wrong.";
    console.error("[shortclips] generate failed:", message);
    return errorResponse(message, 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  return handle(request, {
    topic: url.searchParams.get("topic"),
    seconds: url.searchParams.get("seconds") ?? undefined,
    voice: url.searchParams.get("voice") ?? undefined,
    palette: url.searchParams.get("palette") ?? undefined,
    download: url.searchParams.get("download") === "1",
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Send a JSON body like {\"topic\": \"...\"}.", 400);
  }
  return handle(request, {
    topic: body.topic,
    seconds: body.seconds,
    voice: body.voice,
    palette: body.palette,
    download: body.download === true,
  });
}
