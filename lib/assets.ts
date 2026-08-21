import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CAPTION_FONT_FILE = "Anton-Regular.ttf";
export const CAPTION_FONT_NAME = "Anton";

let cachedFontsDir: string | null = null;

function candidatePaths(): string[] {
  return [
    path.join(process.cwd(), "assets", "fonts", CAPTION_FONT_FILE),
    path.join(process.cwd(), "..", "assets", "fonts", CAPTION_FONT_FILE),
    path.join("/var/task", "assets", "fonts", CAPTION_FONT_FILE),
  ];
}

/**
 * Serverless runtimes ship with no system fonts, so libass is pointed at a
 * directory holding only the caption font. The file is copied to a writable
 * location because the deployment bundle itself may be read-only.
 */
export function ensureFontsDir(): string {
  if (cachedFontsDir) return cachedFontsDir;

  const source = candidatePaths().find((candidate) => existsSync(candidate));
  if (!source) {
    throw new Error(
      `Caption font ${CAPTION_FONT_FILE} is missing. It should live in assets/fonts/.`,
    );
  }

  const target = path.join(os.tmpdir(), "shortclips-fonts");
  mkdirSync(target, { recursive: true });
  const copied = path.join(target, CAPTION_FONT_FILE);
  if (!existsSync(copied)) copyFileSync(source, copied);

  cachedFontsDir = target;
  return target;
}
