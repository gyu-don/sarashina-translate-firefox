import { translate as apiTranslate, ApiError } from "./api.js";
import { TranslationCache } from "./cache.js";
import { RateLimiter } from "./ratelimiter.js";
import { Scheduler, CancelledError } from "./scheduler.js";
import { DEFAULT_SETTINGS, loadSettings } from "./settings.js";

const { detect, opposite } = globalThis.SarashinaLang;

let settings = { ...DEFAULT_SETTINGS };
const limiter = new RateLimiter({ rpm: settings.rpm });
const cache = new TranslationCache(browser.storage.local);
const scheduler = new Scheduler({
  translateFn: (text, source, target) => apiTranslate({ apiKey: settings.apiKey, text, source, target }),
  limiter,
  cache,
});

async function reloadSettings() {
  settings = await loadSettings();
  limiter.setRpm(settings.rpm);
}
const ready = reloadSettings();
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) reloadSettings();
});

const NO_KEY = { status: 401, message: "Sarashina の APIキーが設定されていません" };

function errorInfo(err) {
  return { status: err && err.status !== undefined ? err.status : -1, message: (err && err.message) || String(err) };
}

/* ---------- コンテンツスクリプトとの接続（ページ翻訳） ---------- */

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "sarashina-page") return;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  let alive = true;
  let timer = null;

  const post = (msg) => {
    if (!alive) return;
    try {
      port.postMessage(msg);
    } catch {
      alive = false;
    }
  };

  const reportStatus = () => {
    const pending = scheduler.pendingFor(port);
    post({ type: "status", pending, waitMs: pending ? limiter.waitTime() : 0 });
    if (tabId !== null) {
      browser.browserAction.setBadgeText({ tabId, text: pending ? String(pending) : "" }).catch(() => {});
    }
    if (!pending && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "cancel") {
      scheduler.cancel(port);
      reportStatus();
      return;
    }
    if (msg.type !== "translate") return;
    await ready;
    if (!settings.apiKey) {
      post({ type: "error", ...NO_KEY });
      return;
    }
    for (const item of msg.items) {
      scheduler.translate(item.text, msg.source, msg.target, { owner: port }).then(
        (text) => post({ type: "result", id: item.id, text }),
        (err) => {
          if (err instanceof CancelledError) return;
          post({ type: "failed", id: item.id, ...errorInfo(err) });
        },
      );
    }
    if (!timer) timer = setInterval(reportStatus, 1000);
    setTimeout(reportStatus, 200);
  });

  port.onDisconnect.addListener(() => {
    alive = false;
    scheduler.cancel(port);
    if (timer) clearInterval(timer);
    if (tabId !== null) browser.browserAction.setBadgeText({ tabId, text: "" }).catch(() => {});
  });
});

/* ---------- タブ操作 ---------- */

async function ensureInjected(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { action: "ping" });
    if (res && res.ok) return;
  } catch {
    // 未注入
  }
  await browser.tabs.executeScript(tabId, { file: "/common/lang.js" });
  await browser.tabs.executeScript(tabId, { file: "/content/content.js" });
}

async function sendToTab(tabId, msg) {
  await ensureInjected(tabId);
  return browser.tabs.sendMessage(tabId, msg);
}

async function pageOptions(target) {
  await ready;
  return {
    target: target || settings.targetLang,
    showOriginalOnHover: settings.showOriginalOnHover,
  };
}

async function translateTab(tabId, target) {
  return sendToTab(tabId, { action: "translatePage", ...(await pageOptions(target)) });
}

async function toggleTab(tabId) {
  return sendToTab(tabId, { action: "toggle", ...(await pageOptions()) });
}

/** 言語を自動判定してテキストを翻訳する（選択範囲・ポップアップ用） */
async function translateFreeText(text, { source, target } = {}) {
  await ready;
  if (!settings.apiKey) throw new ApiError(NO_KEY.status, NO_KEY.message);
  const clean = text.trim();
  if (!clean) return { text: "", source, target };
  const src = source || detect(clean) || opposite(settings.targetLang);
  const tgt = target || opposite(src);
  const translated = await scheduler.translate(clean, src, tgt, { priority: true });
  return { text: translated, source: src, target: tgt };
}

async function translateSelectionInTab(tabId, text) {
  if (!text) {
    const res = await sendToTab(tabId, { action: "getSelection" });
    text = res && res.text;
  }
  if (!text || !text.trim()) return;
  await sendToTab(tabId, { action: "selection", state: "loading", original: text });
  try {
    const result = await translateFreeText(text);
    await browser.tabs.sendMessage(tabId, { action: "selection", state: "done", original: text, ...result });
  } catch (err) {
    await browser.tabs.sendMessage(tabId, { action: "selection", state: "error", original: text, ...errorInfo(err) });
  }
}

/* ---------- ポップアップ・設定画面からのメッセージ ---------- */

const handlers = {
  async translateText({ text, source, target }) {
    return translateFreeText(text, { source, target });
  },
  async getTabState({ tabId }) {
    try {
      const res = await browser.tabs.sendMessage(tabId, { action: "getState" });
      return res || { injected: false };
    } catch {
      return { injected: false };
    }
  },
  async translateTab({ tabId, target }) {
    return translateTab(tabId, target);
  },
  async restoreTab({ tabId }) {
    return sendToTab(tabId, { action: "restore" });
  },
  async status() {
    await ready;
    return {
      hasKey: Boolean(settings.apiKey),
      rpm: limiter.rpm,
      used: limiter.used(),
      waitMs: limiter.waitTime(),
      queued: scheduler.queued,
      requests: scheduler.requestCount,
    };
  },
  async testKey({ apiKey }) {
    await limiter.acquire();
    const text = await apiTranslate({ apiKey, text: "Hello, world!", source: "en", target: "ja" });
    return { text };
  },
  async cacheCount() {
    return { count: await cache.count() };
  },
  async clearCache() {
    return { count: await cache.clear() };
  },
};

browser.runtime.onMessage.addListener((msg) => {
  const handler = handlers[msg.action];
  if (!handler) return undefined;
  return handler(msg).then(
    (value) => ({ ok: true, value }),
    (err) => ({ ok: false, error: errorInfo(err) }),
  );
});

/* ---------- コンテキストメニュー・ショートカット ---------- */

const menus = browser.menus || browser.contextMenus;
if (menus) {
  menus.removeAll().then(() => {
    menus.create({ id: "toggle-page", title: "Sarashina でこのページを翻訳 / 原文に戻す", contexts: ["page"] });
    menus.create({ id: "translate-selection", title: "Sarashina で「%s」を翻訳", contexts: ["selection"] });
  });
  menus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id === undefined) return;
    if (info.menuItemId === "toggle-page") toggleTab(tab.id).catch(console.error);
    if (info.menuItemId === "translate-selection") {
      translateSelectionInTab(tab.id, info.selectionText).catch(console.error);
    }
  });
}

if (browser.commands) {
  browser.commands.onCommand.addListener(async (command) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    if (command === "toggle-translation") toggleTab(tab.id).catch(console.error);
    if (command === "translate-selection") translateSelectionInTab(tab.id).catch(console.error);
  });
}

/* ---------- 常に翻訳するサイト ---------- */

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  await ready;
  let host;
  try {
    const url = new URL(tab.url);
    if (!/^https?:$/.test(url.protocol)) return;
    host = url.hostname;
  } catch {
    return;
  }
  if (!settings.alwaysTranslateHosts.includes(host)) return;
  const granted = await browser.permissions.contains({ origins: [`*://${host}/*`] });
  if (!granted) return;
  translateTab(tabId).catch((e) => console.warn("auto translate failed", e));
});

// ポップアップから権限を付与した直後に、そのサイトの開いているタブを翻訳する。
// （権限ダイアログでポップアップが閉じても動くよう背景ページ側で処理する）
browser.permissions.onAdded.addListener(async ({ origins = [] }) => {
  await reloadSettings();
  for (const origin of origins) {
    const m = origin.match(/^\*:\/\/([^/]+)\/\*$/);
    if (!m || !settings.alwaysTranslateHosts.includes(m[1])) continue;
    const tabs = await browser.tabs.query({ url: origin });
    for (const t of tabs) translateTab(t.id).catch((e) => console.warn("auto translate failed", e));
  }
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  await ready;
  if (!settings.apiKey) browser.runtime.openOptionsPage();
});
