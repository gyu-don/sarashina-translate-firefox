"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULTS = { apiKey: "", targetLang: "ja", rpm: 6, showOriginalOnHover: true, alwaysTranslateHosts: [] };

async function load() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

let savedTimer = null;
async function save(patch) {
  const next = { ...(await load()), ...patch };
  await browser.storage.local.set({ settings: next });
  $("saved").textContent = "保存しました";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 1500);
  return next;
}

async function send(action, payload = {}) {
  const res = await browser.runtime.sendMessage({ action, ...payload });
  if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
  return res.value;
}

function renderHosts(hosts) {
  const ul = $("hosts");
  ul.textContent = "";
  $("no-hosts").hidden = hosts.length > 0;
  for (const host of hosts) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "削除";
    btn.addEventListener("click", async () => {
      const s = await load();
      const next = await save({ alwaysTranslateHosts: s.alwaysTranslateHosts.filter((h) => h !== host) });
      await browser.permissions.remove({ origins: [`*://${host}/*`] }).catch(() => {});
      renderHosts(next.alwaysTranslateHosts);
    });
    li.append(name, btn);
    ul.appendChild(li);
  }
}

async function refreshCache() {
  const { count } = await send("cacheCount");
  $("cache-count").textContent = `${count.toLocaleString()} 件の翻訳を保存中`;
}

async function init() {
  const s = await load();
  $("api-key").value = s.apiKey;
  $("target-lang").value = s.targetLang;
  $("hover").checked = s.showOriginalOnHover;
  $("rpm").value = s.rpm;
  renderHosts(s.alwaysTranslateHosts);
  refreshCache();
}

$("api-key").addEventListener("change", (e) => save({ apiKey: e.target.value.trim() }));
$("toggle-key").addEventListener("click", () => {
  const input = $("api-key");
  input.type = input.type === "password" ? "text" : "password";
  $("toggle-key").textContent = input.type === "password" ? "表示" : "隠す";
});
$("target-lang").addEventListener("change", (e) => save({ targetLang: e.target.value }));
$("hover").addEventListener("change", (e) => save({ showOriginalOnHover: e.target.checked }));
$("rpm").addEventListener("change", (e) => {
  const rpm = Math.max(1, Math.min(600, Math.floor(Number(e.target.value)) || DEFAULTS.rpm));
  e.target.value = rpm;
  save({ rpm });
});

$("test-key").addEventListener("click", async () => {
  const out = $("test-result");
  const apiKey = $("api-key").value.trim();
  out.className = "muted";
  if (!apiKey) {
    out.textContent = "APIキーを入力してください";
    return;
  }
  out.textContent = "テスト中…（レート制限の枠が空くまで待つことがあります）";
  $("test-key").disabled = true;
  try {
    await save({ apiKey });
    const { text } = await send("testKey", { apiKey });
    out.textContent = `成功: “Hello, world!” → “${text}”`;
    out.className = "ok";
  } catch (e) {
    out.textContent = `失敗: ${e.message}`;
    out.className = "err";
  } finally {
    $("test-key").disabled = false;
  }
});

$("clear-cache").addEventListener("click", async () => {
  const { count } = await send("clearCache");
  $("saved").textContent = `${count} 件のキャッシュを削除しました`;
  refreshCache();
});

init();
