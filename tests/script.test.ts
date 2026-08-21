import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanLine,
  countWords,
  hashTopic,
  subjectForm,
  templateScript,
  titleForm,
  wordsForDuration,
} from "../lib/script";

test("subjectForm lowercases an ordinary opening word", () => {
  assert.equal(subjectForm("Cold showers"), "cold showers");
  assert.equal(subjectForm("Why small habits compound"), "why small habits compound");
});

test("subjectForm leaves proper nouns and acronyms alone", () => {
  assert.equal(subjectForm("Why Rust is fast"), "Why Rust is fast");
  assert.equal(subjectForm("HTTP caching"), "HTTP caching");
});

test("subjectForm drops trailing punctuation", () => {
  assert.equal(subjectForm("Does fasting work?"), "does fasting work");
});

test("titleForm capitalises and tidies", () => {
  assert.equal(titleForm("  why  sleep matters. "), "Why sleep matters");
});

test("cleanLine strips labels, markdown and emoji", () => {
  assert.equal(cleanLine("**Hook:** Start here 🚀"), "Start here");
  assert.equal(cleanLine("1) Second line"), "Second line");
  assert.equal(cleanLine('"Quoted line"'), "Quoted line");
});

test("template script fits the word budget for a short clip", () => {
  const target = wordsForDuration(15);
  const script = templateScript("Why small habits compound", target);
  const words = countWords(script.lines.join(" "));

  assert.ok(words <= target * 1.15, `expected <= ${target * 1.15} words, got ${words}`);
  assert.ok(words >= target * 0.6, `expected >= ${target * 0.6} words, got ${words}`);
  assert.ok(script.lines.length >= 3);
});

test("template script grows for a longer clip", () => {
  const short = templateScript("Cold showers", wordsForDuration(15));
  const long = templateScript("Cold showers", wordsForDuration(30));
  assert.ok(countWords(long.lines.join(" ")) > countWords(short.lines.join(" ")));
});

test("template script mentions the topic and is deterministic", () => {
  const first = templateScript("Cold showers", wordsForDuration(20));
  const second = templateScript("Cold showers", wordsForDuration(20));

  assert.deepEqual(first.lines, second.lines);
  assert.ok(first.lines[0].includes("cold showers"));
});

test("different topics pick different angles", () => {
  const hooks = new Set(
    ["Cold showers", "Why small habits compound", "How sleep debt works", "Compound interest"].map(
      (topic) => templateScript(topic, 45).lines[0].replace(topic.toLowerCase(), ""),
    ),
  );
  assert.ok(hooks.size > 1);
});

test("hashTopic is stable and case-insensitive", () => {
  assert.equal(hashTopic("Cold Showers"), hashTopic("cold showers"));
});
