import assert from "node:assert/strict";
import test from "node:test";

import { unescapeXml } from "../lib/edge-tts";
import { escapeFilterValue } from "../lib/ffmpeg";
import { mp3Duration } from "../lib/mp3";
import { clampSeconds, normaliseTopic, speakingRate } from "../lib/pipeline";
import { buildFilterGraph, gradientInput } from "../lib/render";
import { PALETTES, pickPalette } from "../lib/palettes";
import { chunkText, estimateWords } from "../lib/voice";

/**
 * A valid MPEG-2 Layer III frame header: 48 kbps, 24 kHz, mono, no padding,
 * which works out to 144 bytes carrying 576 samples.
 */
function mp3Frames(count: number, withId3 = false): Buffer {
  const frame = Buffer.alloc(144);
  frame[0] = 0xff;
  frame[1] = 0xf3;
  frame[2] = 0x64;
  frame[3] = 0xc0;

  const frames = Buffer.concat(Array.from({ length: count }, () => frame));
  if (!withId3) return frames;

  const tag = Buffer.alloc(10 + 32);
  tag.write("ID3", 0, "ascii");
  tag[9] = 32; // synchsafe size of the payload that follows the 10 byte header
  return Buffer.concat([tag, frames]);
}

test("mp3Duration sums frames", () => {
  assert.equal(mp3Duration(mp3Frames(100)), (100 * 576) / 24000);
});

test("mp3Duration skips an ID3 tag", () => {
  assert.equal(mp3Duration(mp3Frames(50, true)), (50 * 576) / 24000);
});

test("mp3Duration returns zero for junk", () => {
  assert.equal(mp3Duration(Buffer.from("not audio at all")), 0);
});

test("estimateWords covers the whole line without overlapping", () => {
  const words = estimateWords("alpha be c", 3);
  assert.equal(words.length, 3);
  assert.equal(Number(words[0].offset.toFixed(6)), 0);

  const last = words[words.length - 1];
  assert.equal(Number((last.offset + last.duration).toFixed(6)), 3);
  assert.ok(words[0].duration > words[2].duration, "longer words get more time");
});

test("chunkText splits on sentence boundaries", () => {
  const chunks = chunkText("One sentence here. Another sentence follows.", 25);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 25));
});

test("clampSeconds keeps requests inside the supported range", () => {
  assert.equal(clampSeconds(15), 15);
  assert.equal(clampSeconds(120), 30);
  assert.equal(clampSeconds(1), 10);
  assert.equal(clampSeconds("nonsense"), 16);
});

test("normaliseTopic collapses whitespace and rejects bad input", () => {
  assert.equal(normaliseTopic("  why   habits  work "), "why habits work");
  assert.throws(() => normaliseTopic("   "));
  assert.throws(() => normaliseTopic("x".repeat(200)));
});

test("speakingRate speeds up a script that would overrun", () => {
  const fast = speakingRate(90, 15, 5);
  const slow = speakingRate(20, 30, 3);

  assert.ok(Number.parseInt(fast, 10) > 20, `expected a big speed-up, got ${fast}`);
  assert.ok(Number.parseInt(slow, 10) < 0, `expected a slow-down, got ${slow}`);
  assert.match(fast, /^[+-]\d+%$/);
});

test("palettes are picked deterministically and can be forced", () => {
  assert.equal(pickPalette("Cold showers").id, pickPalette("Cold showers").id);
  assert.equal(pickPalette("anything", "ember").id, "ember");
  assert.equal(pickPalette("anything", "not-a-palette").id, pickPalette("anything").id);
  assert.ok(PALETTES.length > 1);
});

test("the gradient source is sized for a vertical clip", () => {
  const spec = gradientInput(PALETTES[0], 12.5);
  assert.ok(spec.startsWith("gradients=s=1080x1920"));
  assert.ok(spec.includes("d=12.500"));
  assert.ok(spec.includes("0x060B17"), "colours use ffmpeg's 0xRRGGBB form");
});

test("the filter graph joins every line with silence between them", () => {
  const graph = buildFilterGraph({
    lines: [
      { trimStart: 0.1, trimEnd: 2.1 },
      { trimStart: 0.2, trimEnd: 1.2 },
    ],
    leadIn: 0.35,
    gap: 0.2,
    duration: 4,
    assFile: "captions.ass",
    fontsDir: "/tmp/fonts",
  });

  // lead-in, two lines and one gap between them
  assert.ok(graph.includes("concat=n=4:v=0:a=1[speech]"));
  assert.ok(graph.includes("atrim=start=0.100:end=2.100"));
  assert.ok(graph.includes("atrim=start=0.200:end=1.200"));
  assert.ok(graph.includes("d=0.350"), "lead-in silence");
  assert.ok(graph.includes("d=0.200"), "gap silence");
  assert.ok(graph.includes("ass=captions.ass:fontsdir=/tmp/fonts"));
  assert.ok(graph.includes("[video]") && graph.includes("[audio]"));
});

test("filter values escape the characters that are syntax", () => {
  assert.equal(escapeFilterValue("C:\\fonts"), "C\\:\\\\fonts");
});

test("word metadata is unescaped before it reaches the captions", () => {
  assert.equal(unescapeXml("rock &amp; roll"), "rock & roll");
  assert.equal(unescapeXml("&lt;tags&gt;"), "<tags>");
  assert.equal(unescapeXml("it&apos;s &quot;fine&quot;"), "it's \"fine\"");
  assert.equal(unescapeXml("caf&#233;"), "café");
  // Decoding must not leave a second round of entities behind.
  assert.equal(unescapeXml("&amp;lt;"), "&lt;");
});
