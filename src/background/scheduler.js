// 翻訳リクエストのスケジューラ。
//
// - 全タブ共通のキューに翻訳待ちセグメントを積む
// - レート制限の枠が空いた瞬間に、キューの先頭から 1 リクエストに収まるだけ詰めて送る
// - 番号が崩れて分解できなかったバッチは半分に割って再送する
// - 同じ文が複数箇所から要求されても 1 回しか送らない

import { DEFAULT_CHUNK_CHARS, buildChunk, chunkCost, cpLength, joinParts, parseChunk, splitLongText } from "./batch.js";
import { cacheKey } from "./cache.js";

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

const POLL_MS = 1000;
// 同時に投げ込まれたセグメントを 1 リクエストにまとめるための待ち時間
const GATHER_MS = 150;

export class Scheduler {
  constructor({
    translateFn,
    limiter,
    cache,
    chunkChars = DEFAULT_CHUNK_CHARS,
    maxInFlight = 2,
    maxAttempts = 4,
    gatherMs = GATHER_MS,
    sleep,
  }) {
    this.gatherMs = gatherMs;
    this.translateFn = translateFn;
    this.limiter = limiter;
    this.cache = cache;
    this.chunkChars = chunkChars;
    this.maxInFlight = maxInFlight;
    this.maxAttempts = maxAttempts;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.queue = []; // 送信待ちエントリ
    this.entries = new Map(); // key -> entry（送信待ち + 送信中）
    this.inFlight = 0;
    this.pumping = false;
    this.requestCount = 0;
    this.seq = 0;
  }

  /**
   * 1 セグメントを翻訳する。
   * @param {object} opts.owner キャンセル単位（タブのポートなど）
   * @param {boolean} opts.priority キューの先頭に積む（選択テキスト翻訳など）
   */
  async translate(text, source, target, { owner = null, priority = false, seq } = {}) {
    // ハッシュ計算を待つ間に順序が入れ替わらないよう、呼び出し順を先に記録する
    if (seq === undefined) seq = this.seq++;
    const key = await cacheKey(text, source, target);
    const cached = await this.cache.get(key);
    if (cached !== undefined) return cached;

    if (cpLength(text) > this.chunkChars) {
      const parts = splitLongText(text, this.chunkChars);
      const translated = await Promise.all(
        parts.map((p) => this.translate(p, source, target, { owner, priority, seq })),
      );
      const joined = joinParts(translated, target);
      await this.cache.set(key, joined);
      return joined;
    }

    return new Promise((resolve, reject) => {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = { key, text, source, target, seq, waiters: [], maxBatch: Infinity, attempts: 0 };
        this.entries.set(key, entry);
        if (priority) {
          this.queue.unshift(entry);
        } else {
          let i = this.queue.length;
          while (i > 0 && this.queue[i - 1].seq > seq) i--;
          this.queue.splice(i, 0, entry);
        }
      } else if (priority) {
        const i = this.queue.indexOf(entry);
        if (i > 0) {
          this.queue.splice(i, 1);
          this.queue.unshift(entry);
        }
      }
      entry.waiters.push({ resolve, reject, owner });
      this.pump();
    });
  }

  /** owner が待っているセグメントをすべて取り消す */
  cancel(owner) {
    for (const entry of [...this.entries.values()]) {
      const mine = entry.waiters.filter((w) => w.owner === owner);
      if (!mine.length) continue;
      entry.waiters = entry.waiters.filter((w) => w.owner !== owner);
      for (const w of mine) w.reject(new CancelledError());
      if (!entry.waiters.length) {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          this.entries.delete(entry.key);
        }
        // 送信中のものは結果をキャッシュに入れるため残しておく
      }
    }
  }

  /** owner が待っている（未完了の）セグメント数 */
  pendingFor(owner) {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.waiters.some((w) => w.owner === owner)) n++;
    }
    return n;
  }

  get queued() {
    return this.queue.length;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.inFlight < this.maxInFlight) {
        if (this.limiter.waitTime() > 0) {
          await this.sleep(Math.min(this.limiter.waitTime(), POLL_MS));
          continue;
        }
        await this.sleep(this.gatherMs);
        if (!this.queue.length) break;
        if (!this.limiter.tryAcquire()) {
          await this.sleep(Math.min(this.limiter.waitTime(), POLL_MS));
          continue;
        }
        const batch = this.takeBatch();
        this.inFlight++;
        this.run(batch).finally(() => {
          this.inFlight--;
          this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** キュー先頭と同じ言語ペアのエントリを、1 リクエストに収まるだけ取り出す */
  takeBatch() {
    const head = this.queue[0];
    const batch = [];
    let cost = 0;
    let limit = Infinity;
    for (let i = 0; i < this.queue.length; ) {
      const e = this.queue[i];
      if (e.source !== head.source || e.target !== head.target) {
        i++;
        continue;
      }
      const c = chunkCost(e.text, batch.length);
      const nextLimit = Math.min(limit, e.maxBatch);
      if (batch.length > 0 && (cost + c > this.chunkChars || batch.length + 1 > nextLimit)) break;
      batch.push(e);
      cost += c;
      limit = nextLimit;
      this.queue.splice(i, 1);
    }
    return batch;
  }

  requeue(batch) {
    // 送信中にキャンセルされたものは再送しない
    const alive = batch.filter((e) => {
      if (e.waiters.length > 0) return true;
      this.entries.delete(e.key);
      return false;
    });
    this.queue.unshift(...alive);
  }

  async run(batch) {
    const { source, target } = batch[0];
    let translated;
    try {
      this.requestCount++;
      translated = await this.translateFn(buildChunk(batch.map((e) => e.text)), source, target);
    } catch (err) {
      this.handleError(batch, err);
      return;
    }

    const parts = parseChunk(translated, batch.length);
    if (!parts) {
      // 番号が崩れた: バッチを半分にして再送
      const half = Math.ceil(batch.length / 2);
      for (const e of batch) e.maxBatch = Math.min(e.maxBatch, half);
      this.requeue(batch);
      return;
    }

    await Promise.all(
      batch.map(async (e, i) => {
        await this.cache.set(e.key, parts[i]);
        this.settle(e, (w) => w.resolve(parts[i]));
      }),
    );
  }

  handleError(batch, err) {
    const status = err && err.status;
    if (status === 429) {
      this.limiter.block(err.retryAfter);
      for (const e of batch) e.attempts++;
    } else if (err && err.retryable) {
      for (const e of batch) e.attempts++;
      this.limiter.block(Math.min(30, 2 ** batch[0].attempts));
    } else if (status === 400 && batch.length > 1) {
      // どれか 1 つが不正な可能性があるので分割して切り分ける
      const half = Math.ceil(batch.length / 2);
      for (const e of batch) e.maxBatch = Math.min(e.maxBatch, half);
      this.requeue(batch);
      return;
    } else {
      for (const e of batch) this.settle(e, (w) => w.reject(err));
      if (status === 401) this.failAll(err);
      return;
    }

    const retry = batch.filter((e) => e.attempts < this.maxAttempts * (status === 429 ? 3 : 1));
    for (const e of batch) {
      if (!retry.includes(e)) this.settle(e, (w) => w.reject(err));
    }
    this.requeue(retry);
  }

  settle(entry, fn) {
    this.entries.delete(entry.key);
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) fn(w);
  }

  failAll(err) {
    const queued = this.queue.splice(0);
    for (const e of queued) this.settle(e, (w) => w.reject(err));
  }
}
