"use strict";

const { detect } = globalThis.SarashinaLang;
const $ = (id) => document.getElementById(id);

let tab = null;
let host = null;
let settings = null;

async function send(action, payload = {}) {
  const res = await browser.runtime.sendMessage({ action, ...payload });
  if (!res) throw new Error("背景ページから応答がありません");
  if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
  return res.value;
}

async function loadSettings() {
  const { settings: s } = await browser.storage.local.get("settings");
  return { targetLang: "ja", alwaysTranslateHosts: [], apiKey: "", ...(s || {}) };
}

async function saveSettings(patch) {
  settings = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ settings });
}

function openOptions(e) {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
}

async function refreshPage() {
  if (!tab || !host) return;
  const st = await send("getTabState", { tabId: tab.id }).catch(() => ({ injected: false }));
  const translated = st.injected && st.mode === "translated";
  $("translate").hidden = translated;
  $("restore").hidden = !translated;
  if (translated) $("target").value = st.target;
  let text = "";
  if (translated) {
    text = st.pending > 0 ? `翻訳中… 残り ${st.pending} 件` : `翻訳済み ${st.done}/${st.total}`;
    if (st.error) text += ` ／ エラー: ${st.error}`;
  }
  $("page-status").textContent = text;
}

async function refreshQuota() {
  const st = await send("status").catch(() => null);
  if (!st) return;
  $("no-key").hidden = st.hasKey;
  const wait = Math.ceil(st.waitMs / 1000);
  $("quota").textContent =
    `API 利用: 直近1分 ${st.used}/${st.rpm} 回` +
    (wait > 0 ? ` ・ 次の枠まで ${wait} 秒` : "") +
    (st.queued ? ` ・ 待機 ${st.queued} 件` : "");
}

function showError(err) {
  $("page-status").textContent = `エラー: ${err.message}`;
  $("page-status").classList.add("err");
}

async function init() {
  settings = await loadSettings();
  $("target").value = settings.targetLang;

  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    if (/^https?:$/.test(url.protocol)) host = url.hostname;
    else if (url.protocol === "file:") host = "";
  } catch {
    host = null;
  }

  if (host === null) {
    $("translate").disabled = true;
    $("always-row").hidden = true;
    $("page-unsupported").hidden = false;
  } else if (!host) {
    $("always-row").hidden = true;
  } else {
    $("host").textContent = host;
    $("always").checked = settings.alwaysTranslateHosts.includes(host);
  }

  await Promise.all([refreshPage(), refreshQuota()]);
  setInterval(() => {
    refreshPage();
    refreshQuota();
  }, 1000);
}

$("open-options").addEventListener("click", openOptions);
$("open-options-2").addEventListener("click", openOptions);

$("translate").addEventListener("click", async () => {
  $("page-status").classList.remove("err");
  const target = $("target").value;
  try {
    await saveSettings({ targetLang: target });
    await send("translateTab", { tabId: tab.id, target });
    await refreshPage();
  } catch (e) {
    showError(e);
  }
});

$("restore").addEventListener("click", async () => {
  try {
    await send("restoreTab", { tabId: tab.id });
    await refreshPage();
  } catch (e) {
    showError(e);
  }
});

$("target").addEventListener("change", async () => {
  const target = $("target").value;
  await saveSettings({ targetLang: target });
  // 翻訳中なら新しい方向で翻訳し直す
  if (!$("restore").hidden) {
    await send("translateTab", { tabId: tab.id, target }).catch(showError);
    await refreshPage();
  }
});

$("always").addEventListener("change", (e) => {
  const origins = [`*://${host}/*`];
  if (e.target.checked) {
    // permissions.request はユーザー操作の直後に同期的に呼ぶ必要がある。
    // 権限ダイアログでポップアップが閉じることがあるので、サイトの登録を先に済ませ、
    // 許可後の翻訳開始は背景ページ（permissions.onAdded）に任せる。
    const request = browser.permissions.request({ origins });
    loadSettings()
      .then((s) => saveSettings({ alwaysTranslateHosts: [...new Set([...s.alwaysTranslateHosts, host])] }))
      .then(() => request)
      .then(async (granted) => {
        if (granted) return refreshPage();
        e.target.checked = false;
        const s = await loadSettings();
        await saveSettings({ alwaysTranslateHosts: s.alwaysTranslateHosts.filter((h) => h !== host) });
      });
  } else {
    loadSettings().then(async (s) => {
      await saveSettings({ alwaysTranslateHosts: s.alwaysTranslateHosts.filter((h) => h !== host) });
      await browser.permissions.remove({ origins }).catch(() => {});
    });
  }
});

function updateDirection() {
  const lang = detect($("text").value);
  $("direction").textContent = lang === "ja" ? "日本語 → 英語" : lang === "en" ? "英語 → 日本語" : "";
}
$("text").addEventListener("input", updateDirection);
$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("translate-text").click();
});

$("translate-text").addEventListener("click", async () => {
  const text = $("text").value.trim();
  if (!text) return;
  const btn = $("translate-text");
  const out = $("result");
  btn.disabled = true;
  out.hidden = false;
  out.classList.remove("err");
  out.textContent = "翻訳中…";
  try {
    const res = await send("translateText", { text });
    out.textContent = res.text;
  } catch (e) {
    out.textContent = e.message;
    out.classList.add("err");
  } finally {
    btn.disabled = false;
  }
});

init().catch((e) => showError(e));
