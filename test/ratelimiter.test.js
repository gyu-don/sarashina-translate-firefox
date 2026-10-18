import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/background/ratelimiter.js";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("allows rpm requests per sliding window", () => {
  const c = clock();
  const rl = new RateLimiter({ rpm: 3, now: c.now });
  assert.ok(rl.tryAcquire());
  c.advance(10_000);
  assert.ok(rl.tryAcquire());
  assert.ok(rl.tryAcquire());
  assert.ok(!rl.tryAcquire());
  // 最初の 1 件がウィンドウを抜けるまで待つ
  assert.ok(Math.abs(rl.waitTime() - 50_300) < 5);
  c.advance(50_300);
  assert.ok(rl.tryAcquire());
  assert.equal(rl.used(), 3);
});

test("block() honours Retry-After", () => {
  const c = clock();
  const rl = new RateLimiter({ rpm: 6, now: c.now });
  rl.block("12");
  assert.equal(rl.waitTime(), 12_300);
  assert.ok(!rl.tryAcquire());
  c.advance(12_300);
  assert.ok(rl.tryAcquire());
  rl.block(null);
  assert.equal(rl.waitTime(), 60_300);
});
