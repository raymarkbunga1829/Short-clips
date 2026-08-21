/**
 * Locating and running the ffmpeg binary.
 *
 * On Vercel the binary comes from the bundled `ffmpeg-static` package. Files
 * uploaded with a function do not always keep their executable bit, so it is
 * repaired (or the binary is copied somewhere writable) on first use.
 */

import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Kept out of the bundle via serverExternalPackages, so the path it reports
// still points at the real binary at runtime.
import ffmpegStatic from "ffmpeg-static";

export class FfmpegError extends Error {}

let cachedBinary: string | null = null;

function fromPackage(): string | null {
  const value = ffmpegStatic as unknown as string | null;
  return value && existsSync(value) ? value : null;
}

function makeExecutable(binary: string): string {
  try {
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {
    // Ignored: fall through to fixing permissions.
  }

  try {
    chmodSync(binary, 0o755);
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {
    // Ignored: the bundle is read-only, so copy it somewhere we control.
  }

  const target = path.join(os.tmpdir(), "shortclips-bin", "ffmpeg");
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) {
    copyFileSync(binary, target);
    chmodSync(target, 0o755);
  }
  return target;
}

export function resolveFfmpeg(): string {
  if (cachedBinary) return cachedBinary;

  const override = process.env.SHORTCLIPS_FFMPEG_PATH;
  const candidate = override && existsSync(override) ? override : fromPackage();

  // Falling back to the PATH keeps `npm run dev` working on a machine that
  // already has ffmpeg installed.
  cachedBinary = candidate ? makeExecutable(candidate) : "ffmpeg";
  return cachedBinary;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export function runFfmpeg(args: string[], options: RunOptions = {}): Promise<void> {
  const binary = resolveFfmpeg();

  return new Promise((resolve, reject) => {
    // The binary is chosen at runtime. Without this hint the bundler traces the
    // entire project into the function; the files it actually needs are listed
    // in outputFileTracingIncludes instead.
    const child = spawn(/* turbopackIgnore: true */ binary, [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      ...args,
    ], {
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new FfmpegError(`ffmpeg timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : null;

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(new FfmpegError(`Could not start ffmpeg (${binary}): ${error.message}`));
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split("\n").slice(-8).join("\n");
      reject(new FfmpegError(`ffmpeg exited with code ${code}${tail ? `:\n${tail}` : ""}`));
    });
  });
}

/** Escapes a value used inside a filtergraph option, where ':' and '\' are syntax. */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
