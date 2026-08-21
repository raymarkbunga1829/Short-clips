import assert from "node:assert/strict";
import test from "node:test";

import { CAPTION_DEFAULTS, assColor, assTime, buildAss, escapeAss, groupWords, wrapText } from "../lib/captions";
import type { SpokenLine, WordTiming } from "../lib/types";

function line(words: [string, number, number][]): SpokenLine {
  const timings: WordTiming[] = words.map(([text, start, end]) => ({ text, start, end }));
  return {
    text: words.map(([text]) => text).join(" "),
    file: "line.mp3",
    trimStart: 0,
    trimEnd: 1,
    duration: 1,
    start: timings[0]?.start ?? 0,
    words: timings,
  };
}

test("chunks are capped by word count", () => {
  const cues = groupWords([
    line([
      ["one", 0, 0.3],
      ["two", 0.3, 0.6],
      ["three", 0.6, 0.9],
      ["four", 0.9, 1.2],
    ]),
  ]);

  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0].words.map((word) => word.text), ["one", "two", "three"]);
});

test("chunks are capped by character count", () => {
  const cues = groupWords([
    line([
      ["extraordinary", 0, 0.5],
      ["circumstances", 0.5, 1.0],
    ]),
  ]);
  assert.equal(cues.length, 2);
});

test("a long pause starts a new chunk", () => {
  const cues = groupWords([
    line([
      ["one", 0, 0.3],
      ["two", 2.0, 2.3],
    ]),
  ]);
  assert.equal(cues.length, 2);
});

test("chunks never overlap and never straddle a line", () => {
  const cues = groupWords([
    line([
      ["a", 0, 0.3],
      ["b", 0.3, 0.6],
    ]),
    line([
      ["c", 1.2, 1.5],
      ["d", 1.5, 1.8],
    ]),
  ]);

  assert.equal(cues.length, 2);
  for (let i = 0; i < cues.length - 1; i += 1) {
    assert.ok(cues[i].end <= cues[i + 1].start, "cues must not overlap");
  }
});

test("a chunk holds through a short pause but not indefinitely", () => {
  const [held] = groupWords([
    line([["a", 0, 0.3]]),
    line([["b", 0.6, 0.9]]),
  ]);
  assert.equal(held.end, 0.6, "should hold until the next chunk starts");

  const [dropped] = groupWords([
    line([["a", 0, 0.3]]),
    line([["b", 9, 9.3]]),
  ]);
  assert.equal(
    Number(dropped.end.toFixed(2)),
    Number((0.3 + CAPTION_DEFAULTS.maxHold).toFixed(2)),
    "should not linger through a long pause",
  );
});

test("assTime formats hours, minutes and centiseconds", () => {
  assert.equal(assTime(0), "0:00:00.00");
  assert.equal(assTime(61.5), "0:01:01.50");
  assert.equal(assTime(-3), "0:00:00.00");
});

test("assColor reverses the channels", () => {
  assert.equal(assColor("#FFD166"), "&H0066D1FF");
  assert.equal(assColor("#000000", 0x80), "&H80000000");
});

test("escapeAss neutralises override syntax", () => {
  assert.equal(escapeAss("a {b} \\c"), "a (b) /c");
});

test("wrapText wraps within the line budget", () => {
  assert.deepEqual(wrapText("one two three", 9, 2), ["one two", "three"]);
});

test("wrapText marks text it had to drop", () => {
  assert.deepEqual(wrapText("one two three four", 9, 2), ["one two", "three…"]);
  assert.equal(wrapText("alpha beta gamma delta epsilon", 11, 1)[0].endsWith("…"), true);
});

test("buildAss emits one event per word plus the title and bar", () => {
  const cues = groupWords([
    line([
      ["hello", 0.2, 0.6],
      ["world", 0.6, 1.0],
    ]),
  ]);
  const ass = buildAss({ cues, title: "A Title", duration: 5, accent: "#FFD166" });
  const events = ass.split("\n").filter((row) => row.startsWith("Dialogue:"));

  assert.equal(events.length, 4, "bar + title + two words");
  assert.ok(ass.includes("PlayResX: 1080"));
  assert.ok(ass.includes("PlayResY: 1920"));
  assert.ok(ass.includes("HELLO"), "captions are upper case");
  assert.ok(ass.includes("A Title"), "the title keeps its own case");
});
