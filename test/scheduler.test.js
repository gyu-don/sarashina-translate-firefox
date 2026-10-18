import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, CancelledError } from "../src/background/scheduler.js";
import { RateLimiter } from "../src/background/ratelimiter.js";
import { TranslationCache } from "../src/background/cache.js";
import { buildChunk } from "../src/background/batch.js";
import { ApiError } from "../src/background/api.js";

// 疑似翻訳: 各行のマーカーを保ったまま "JA(...)" で包む
function fakeTranslate(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/^(\[\d+\] )?(.*)$/, (_, m, body) => `${m || ""}JA(${body})`))
    .join("\n");
}

function setup({ translateFn, rpm = 100, chunkChars } = {}) {
  const calls = [];
  const limiter = new RateLimiter({ rpm });
  const scheduler = new Scheduler({
    translateFn: async (text, s, t) => {
      calls.push(text);
      return translateFn ? translateFn(text, s, t, calls.length) : fakeTranslate(text);
    },
    limiter,
    cache: new TranslationCache(),
    chunkChars,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  return { scheduler, calls, limiter };
}

test("packs concurrent segments into one request", async () => {
  const { scheduler, calls } = setup();
  const results = await Promise.all(["one", "two", "three"].map((t) => scheduler.translate(t, "en", "ja")));
  assert.deepEqual(results, ["JA(one)", "JA(two)", "JA(three)"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], buildChunk(["one", "two", "three"]));
});

test("cache prevents repeated requests and duplicates are merged", async () => {
  const { scheduler, calls } = setup();
  await Promise.all([scheduler.translate("dup", "en", "ja"), scheduler.translate("dup", "en", "ja")]);
  await scheduler.translate("dup", "en", "ja");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "dup");
});

test("respects chunk size", async () => {
  const { scheduler, calls } = setup({ chunkChars: 30 });
  const segs = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"];
  const res = await Promise.all(segs.map((s) => scheduler.translate(s, "en", "ja")));
  assert.deepEqual(
    res,
    segs.map((s) => `JA(${s})`),
  );
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.ok(c.length <= 30, c);
});

test("splits batch in half when markers are broken", async () => {
  const { scheduler, calls } = setup({
    translateFn: (text) => (text.includes("\n") && text.split("\n").length > 2 ? "garbage" : fakeTranslate(text)),
  });
  const segs = ["a1", "a2", "a3", "a4"];
  const res = await Promise.all(segs.map((s) => scheduler.translate(s, "en", "ja")));
  assert.deepEqual(
    res,
    segs.map((s) => `JA(${s})`),
  );
  assert.equal(calls.length, 3); // 4件 → 失敗 → 2件 + 2件
});

test("long text is split and joined", async () => {
  const { scheduler, calls } = setup({ chunkChars: 50 });
  const text = "First sentence here. Second sentence here. Third sentence here.";
  const res = await scheduler.translate(text, "en", "ja");
  assert.ok(calls.length >= 1);
  assert.ok(res.startsWith("JA(First"));
  assert.ok(res.includes("JA(Third sentence here.)"), res);
});

test("retries after 429 using Retry-After", async () => {
  const { scheduler, calls, limiter } = setup({
    translateFn: (text, s, t, n) => {
      if (n === 1) throw new ApiError(429, "rate", "0.01");
      return fakeTranslate(text);
    },
  });
  limiter.block = function () {}; // テストでは待たない
  assert.equal(await scheduler.translate("x", "en", "ja"), "JA(x)");
  assert.equal(calls.length, 2);
});

test("401 rejects everything without retry", async () => {
  const { scheduler, calls } = setup({
    translateFn: () => {
      throw new ApiError(401, "bad key");
    },
  });
  const ps = ["a", "b"].map((t) => scheduler.translate(t, "en", "ja"));
  for (const p of ps) await assert.rejects(p, (e) => e.status === 401);
  assert.equal(calls.length, 1);
});

test("cancel rejects pending waiters and removes them from the queue", async () => {
  const { scheduler, calls } = setup({ rpm: 1 });
  const owner = {};
  await scheduler.translate("first", "en", "ja"); // 枠を使い切る
  const p = scheduler.translate("second", "en", "ja", { owner });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(scheduler.pendingFor(owner), 1);
  scheduler.cancel(owner);
  await assert.rejects(p, CancelledError);
  assert.equal(scheduler.queued, 0);
  assert.equal(calls.length, 1);
});

test("priority items jump the queue", async () => {
  const { scheduler, calls } = setup({ rpm: 1, chunkChars: 12 });
  await scheduler.translate("warmup", "en", "ja");
  const a = scheduler.translate("aaaaaaaa", "en", "ja");
  const b = scheduler.translate("bbbbbbbb", "en", "ja", { priority: true });
  // 枠がないので両方キューに残る
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(scheduler.queue[0].text, "bbbbbbbb");
  scheduler.cancel(null);
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(calls.length, 1);
});
