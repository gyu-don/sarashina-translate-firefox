import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChunk,
  parseChunk,
  tagsPreserved,
  splitLongText,
  cpLength,
  normalizeSegment,
} from "../src/background/batch.js";

test("buildChunk / parseChunk round trip", () => {
  const segs = ["Hello world.", "Second <g1>line</g1>.", "Third"];
  const chunk = buildChunk(segs);
  assert.equal(chunk, "[1] Hello world.\n[2] Second <g1>line</g1>.\n[3] Third");
  assert.deepEqual(parseChunk("[1] こんにちは。\n[2] 2行目<g1>です</g1>。\n[3] 3つ目", 3), [
    "こんにちは。",
    "2行目<g1>です</g1>。",
    "3つ目",
  ]);
});

test("single segment is sent without markers", () => {
  assert.equal(buildChunk(["only"]), "only");
  assert.deepEqual(parseChunk("  だけ \n", 1), ["だけ"]);
});

test("parseChunk tolerates full-width brackets and blank lines", () => {
  assert.deepEqual(parseChunk("［1］ 一\n\n［2］ 二", 2), ["一", "二"]);
});

test("parseChunk falls back to line count when markers vanish", () => {
  assert.deepEqual(parseChunk("一\n二", 2), ["一", "二"]);
});

test("parseChunk rejects missing or reordered markers", () => {
  assert.equal(parseChunk("[1] 一\n[3] 三", 2), null);
  assert.equal(parseChunk("[2] 二\n[1] 一", 2), null);
  assert.equal(parseChunk("[1] 一 二", 2), null);
});

test("tagsPreserved", () => {
  assert.ok(tagsPreserved("Click <g1>here</g1> now", "<g1>ここ</g1>をクリック"));
  assert.ok(tagsPreserved("plain", "プレーン"));
  assert.ok(!tagsPreserved("Click <g1>here</g1>", "ここをクリック"));
  assert.ok(!tagsPreserved("Click <g1>here</g1>", "</g1>ここ<g1>"));
  assert.ok(!tagsPreserved("a <g1>b</g1>", "<g1>b</g1><g2>x</g2>"));
});

test("splitLongText keeps parts under the limit", () => {
  const sentence = "This is a sentence. ";
  const text = sentence.repeat(50);
  const parts = splitLongText(text, 100);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(cpLength(p) <= 100);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text.trim());
  const noBreak = "a".repeat(250);
  assert.deepEqual(splitLongText(noBreak, 100).map(cpLength), [100, 100, 50]);
});

test("cpLength counts code points", () => {
  assert.equal(cpLength("日本😀"), 3);
});

test("normalizeSegment", () => {
  assert.equal(normalizeSegment("  a\n\tb  "), "a b");
});
