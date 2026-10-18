// 複数セグメントを 1 リクエストにまとめる／結果を分解するための純粋関数群。
//
// Sarashina Translate API は 1 リクエスト 1 テキスト・最大 5,000 コードポイント、
// かつ 6 RPM と厳しいので、ページ内の段落を
//
//   [1] 1つ目の段落
//   [2] 2つ目の段落
//
// のような番号付き行にまとめて送り、返ってきた訳文を番号で切り分ける。

export const API_MAX_CHARS = 5000;
// 番号マーカーぶんの余裕を残したリクエスト本文の目安
export const DEFAULT_CHUNK_CHARS = 4500;

const TAG_RE = /<\/?g(\d+)>/g;

/** Unicode コードポイント数（API の文字数カウント仕様と同じ） */
export function cpLength(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** 改行を含むと行単位の分解が壊れるので、セグメント内の空白類は 1 つにまとめる */
export function normalizeSegment(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** セグメント列を 1 リクエスト用テキストに組み立てる */
export function buildChunk(segments) {
  if (segments.length === 1) return segments[0];
  return segments.map((s, i) => `[${i + 1}] ${s}`).join("\n");
}

/** buildChunk したときの長さ（実際に組み立てずに見積もる） */
export function chunkCost(segment, index) {
  return cpLength(segment) + String(index + 1).length + 4; // "[n] " + "\n"
}

/**
 * 訳文を count 個に分解する。番号が揃わなければ null。
 * 番号が欠けたり重複したりした場合は呼び出し側でバッチを分割して再送する。
 */
export function parseChunk(translated, count) {
  if (count === 1) return [translated.trim()];

  const marker = /(?:^|\n)[ \t　]*[[［](\d+)[\]］][ \t　]?/g;
  const found = [];
  let m;
  while ((m = marker.exec(translated)) !== null) {
    found.push({ id: Number(m[1]), start: m.index, end: marker.lastIndex });
  }
  if (found.length === count && found.every((f, i) => f.id === i + 1)) {
    return found.map((f, i) => {
      const stop = i + 1 < found.length ? found[i + 1].start : translated.length;
      return translated.slice(f.end, stop).trim();
    });
  }

  // マーカーが消えても行数が一致していればそれを採用する
  const lines = translated
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (found.length === 0 && lines.length === count) return lines;
  return null;
}

/** セグメントに含まれるインライン要素タグ <gN>…</gN> の ID 一覧 */
export function tagIds(segment) {
  const ids = new Set();
  for (const m of segment.matchAll(TAG_RE)) ids.add(m[1]);
  return [...ids].sort();
}

/** 訳文が原文と同じタグを 1 組ずつ保持しているか */
export function tagsPreserved(source, translated) {
  const ids = tagIds(source);
  for (const id of ids) {
    const open = translated.split(`<g${id}>`).length - 1;
    const close = translated.split(`</g${id}>`).length - 1;
    if (open !== 1 || close !== 1) return false;
    if (translated.indexOf(`<g${id}>`) > translated.indexOf(`</g${id}>`)) return false;
  }
  return tagIds(translated).join() === ids.join();
}

/**
 * 1 リクエストに収まらない長文を文の切れ目で分割する。
 * タグ付きセグメントはコンテンツスクリプト側で短く保っているので、ここではタグを考慮しない。
 */
export function splitLongText(text, limit = DEFAULT_CHUNK_CHARS) {
  if (cpLength(text) <= limit) return [text];
  const sentences = text.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’」』)]*\s*|$)/g) || [text];
  const parts = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if (cpLength(cur) + cpLength(s) <= limit) {
      cur += s;
      continue;
    }
    push();
    if (cpLength(s) <= limit) {
      cur = s;
      continue;
    }
    // 1 文が上限を超える場合はコードポイント単位で強制的に切る
    const cps = [...s];
    for (let i = 0; i < cps.length; i += limit) {
      parts.push(
        cps
          .slice(i, i + limit)
          .join("")
          .trim(),
      );
    }
  }
  push();
  return parts.filter((p) => p.length > 0);
}

/** 分割翻訳した結果を連結する。日本語は空白なしで繋ぐ。 */
export function joinParts(parts, target) {
  return parts.join(target === "ja" ? "" : " ");
}
