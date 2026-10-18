// 翻訳結果キャッシュ。リクエスト数が貴重なので、同じ文は二度と送らない。
// メモリ上の Map と browser.storage.local の二段構え。

const PREFIX = "tc:";
const MEMORY_LIMIT = 5000;

export async function cacheKey(text, source, target) {
  const data = new TextEncoder().encode(`${source}>${target}\n${text}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return PREFIX + hex.slice(0, 40);
}

export class TranslationCache {
  /** @param storage browser.storage.local 互換 (get/set/remove)。null ならメモリのみ */
  constructor(storage = null) {
    this.storage = storage;
    this.memory = new Map();
  }

  remember(key, value) {
    this.memory.delete(key);
    this.memory.set(key, value);
    if (this.memory.size > MEMORY_LIMIT) {
      this.memory.delete(this.memory.keys().next().value);
    }
  }

  async get(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    if (!this.storage) return undefined;
    const got = await this.storage.get(key);
    const value = got[key];
    if (typeof value === "string") {
      this.remember(key, value);
      return value;
    }
    return undefined;
  }

  async set(key, value) {
    this.remember(key, value);
    if (this.storage) await this.storage.set({ [key]: value });
  }

  async keys() {
    if (!this.storage) return [...this.memory.keys()];
    const all = await this.storage.get(null);
    return Object.keys(all).filter((k) => k.startsWith(PREFIX));
  }

  async count() {
    return (await this.keys()).length;
  }

  async clear() {
    const keys = await this.keys();
    this.memory.clear();
    if (this.storage && keys.length) await this.storage.remove(keys);
    return keys.length;
  }
}
