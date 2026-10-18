// スライディングウィンドウ方式のレートリミッタ。
// 任意の 60 秒間で rpm 回以下に抑えれば、サーバー側の固定ウィンドウ判定にも必ず収まる。

const SAFETY_MARGIN_MS = 300;

export class RateLimiter {
  constructor({ rpm = 6, windowMs = 60_000, now = Date.now, sleep } = {}) {
    this.rpm = rpm;
    this.windowMs = windowMs;
    this.now = now;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.stamps = [];
    this.blockedUntil = 0;
  }

  setRpm(rpm) {
    this.rpm = Math.max(1, Math.floor(rpm) || 1);
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
  }

  /** 次にリクエストできるまでの待ち時間 (ms)。0 なら即座に送れる。 */
  waitTime() {
    this.prune();
    const now = this.now();
    let wait = Math.max(0, this.blockedUntil - now);
    if (this.stamps.length >= this.rpm) {
      const oldest = this.stamps[this.stamps.length - this.rpm];
      wait = Math.max(wait, oldest + this.windowMs - now + SAFETY_MARGIN_MS);
    }
    return wait;
  }

  /** 直近ウィンドウ内の使用回数 */
  used() {
    this.prune();
    return this.stamps.length;
  }

  /** 今すぐ送れるなら 1 回分を消費して true */
  tryAcquire() {
    if (this.waitTime() > 0) return false;
    this.stamps.push(this.now());
    return true;
  }

  /** 枠が空くまで待ってから 1 回分を消費する */
  async acquire() {
    for (;;) {
      const wait = this.waitTime();
      if (wait <= 0) {
        this.stamps.push(this.now());
        return;
      }
      await this.sleep(wait);
    }
  }

  /** 429 を受けたら Retry-After 秒だけ全体を止める */
  block(seconds) {
    // Retry-After が無い・読めない場合は 1 ウィンドウぶん待つ
    const sec = Number(seconds) > 0 ? Number(seconds) : this.windowMs / 1000;
    const ms = sec * 1000 + SAFETY_MARGIN_MS;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}
