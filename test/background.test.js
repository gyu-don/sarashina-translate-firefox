// background.js を偽の browser API と偽の Sarashina API で動かす結合テスト
import { test } from "node:test";
import assert from "node:assert/strict";
import "../src/common/lang.js";

const store = { settings: { apiKey: "test-key", rpm: 6 } };
const listeners = {};
const on = (name) => ({ addListener: (f) => (listeners[name] = f) });
globalThis.browser = {
  storage: {
    local: {
      async get(k) {
        if (k === null) return { ...store };
        return k in store ? { [k]: store[k] } : {};
      },
      async set(o) {
        Object.assign(store, o);
      },
      async remove(keys) {
        for (const k of keys) delete store[k];
      },
    },
    onChanged: on("storageChanged"),
  },
  runtime: { onConnect: on("connect"), onMessage: on("message"), onInstalled: on("installed"), openOptionsPage() {} },
  browserAction: { setBadgeText: async () => {} },
  tabs: { onUpdated: on("tabUpdated"), query: async () => [] },
  permissions: { contains: async () => false, onAdded: on("permAdded") },
};

const requests = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url, auth: init.headers.Authorization, body });
  const translated = body.text
    .split("\n")
    .map((l) => l.replace(/^(\[\d+\] )?(.*)$/, (_, m, t) => `${m || ""}【${t}】`))
    .join("\n");
  return new Response(JSON.stringify({ translated_text: translated }), { status: 200 });
};

await import("../src/background/background.js");

function connectPort(tabId = 1) {
  const received = [];
  const port = {
    name: "sarashina-page",
    sender: { tab: { id: tabId } },
    postMessage: (m) => received.push(m),
    onMessage: on("portMessage"),
    onDisconnect: on("portDisconnect"),
  };
  listeners.connect(port);
  return { port, received, send: (m) => listeners.portMessage(m) };
}

test("page segments are batched into a single API request", async () => {
  const { received, send } = connectPort();
  await send({
    type: "translate",
    source: "en",
    target: "ja",
    items: [
      { id: 1, text: "Hello." },
      { id: 2, text: "Click <g1>here</g1>." },
      { id: 3, text: "Bye." },
    ],
  });
  await new Promise((r) => setTimeout(r, 400));
  const results = received.filter((m) => m.type === "result").sort((a, b) => a.id - b.id);
  assert.deepEqual(
    results.map((r) => r.text),
    ["【Hello.】", "【Click <g1>here</g1>.】", "【Bye.】"],
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.sarashina.ai/v1/translate");
  assert.equal(requests[0].auth, "Bearer test-key");
  assert.deepEqual(Object.keys(requests[0].body).sort(), ["source_lang", "target_lang", "text"]);
  assert.equal(requests[0].body.text, "[1] Hello.\n[2] Click <g1>here</g1>.\n[3] Bye.");
  listeners.portDisconnect();
});

test("translateText auto-detects direction and uses the persistent cache", async () => {
  const before = requests.length;
  const res = await listeners.message({ action: "translateText", text: "こんにちは" }, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { text: "【こんにちは】", source: "ja", target: "en" });
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).body.source_lang, "ja");
  // 2 回目はキャッシュから
  await listeners.message({ action: "translateText", text: "こんにちは" }, {});
  assert.equal(requests.length, before + 1);
  assert.ok(Object.keys(store).some((k) => k.startsWith("tc:")));
});

test("status reports quota usage", async () => {
  const res = await listeners.message({ action: "status" }, {});
  assert.equal(res.ok, true);
  assert.equal(res.value.hasKey, true);
  assert.equal(res.value.rpm, 6);
  assert.equal(res.value.used, requests.length);
});

test("missing api key is reported to the page without calling the API", async () => {
  store.settings = { apiKey: "" };
  await listeners.storageChanged({ settings: {} }, "local");
  await new Promise((r) => setTimeout(r, 10));
  const before = requests.length;
  const { received, send } = connectPort(2);
  await send({ type: "translate", source: "en", target: "ja", items: [{ id: 1, text: "Unseen text." }] });
  assert.equal(received[0].type, "error");
  assert.equal(requests.length, before);
});
