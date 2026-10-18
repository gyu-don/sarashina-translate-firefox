// コンテンツスクリプトを Chromium 上で動かし、背景ページを疑似実装して動作を検証する。
// 実行: npm run test:e2e   （playwright が必要）
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(path.join(execSync("npm root -g").toString().trim(), "playwright")));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "..", "src");
const html = readFileSync(path.join(here, "page.html"), "utf8");
const lang = readFileSync(path.join(src, "common", "lang.js"), "utf8");
const content = readFileSync(path.join(src, "content", "content.js"), "utf8");

// 背景ページの代わり: 決まった文は自然な語順で、それ以外は「訳:」を付けて返す
const stub = `
window.__sent = [];
window.__sarashinaTestHooks = {};
const DICT = {
  "Click <g1>here</g1> to continue.": "続けるには<g1>ここ</g1>をクリックしてください。",
  "Run <g1>npm install</g1> before building.": "ビルドの前に<g1>npm install</g1>を実行してください。",
  "<g1>Bold</g1> second item": "2番目の<g1>太字</g1>項目",
};
const listeners = { msg: [], port: [] };
window.browser = {
  runtime: {
    connect() {
      const port = {
        onMessage: { addListener: (f) => listeners.port.push(f) },
        onDisconnect: { addListener() {} },
        postMessage(msg) {
          if (msg.type !== "translate") return;
          window.__sent.push(...msg.items.map((i) => i.text));
          setTimeout(() => {
            for (const it of msg.items) {
              const text = DICT[it.text] || "訳:" + it.text;
              listeners.port.forEach((f) => f({ type: "result", id: it.id, text }));
            }
            listeners.port.forEach((f) => f({ type: "status", pending: 0, waitMs: 0 }));
          }, 20);
        },
      };
      return port;
    },
    onMessage: { addListener: (f) => listeners.msg.push(f) },
  },
};
window.__send = (msg) => listeners.msg[0](msg);
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.route("http://test.local/", (r) => r.fulfill({ contentType: "text/html", body: html }));
await page.goto("http://test.local/");
await page.addScriptTag({ content: stub });
await page.addScriptTag({ content: lang });
await page.addScriptTag({ content: content });

const original = await page.evaluate(() => document.body.innerHTML);
const text = (id) => page.$eval(`#${id}`, (e) => e.textContent);
const wait = (ms) => page.waitForTimeout(ms);

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.log(`not ok - ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

await page.evaluate(() => window.__send({ action: "translatePage", target: "ja", showOriginalOnHover: true }));
await wait(400);

await check("simple paragraph is translated", async () => {
  assert.equal(await text("simple"), "訳:This is a simple paragraph.");
  assert.equal(await text("h"), "訳:Welcome to the test page");
});

await check("inline link keeps its element and order follows the translation", async () => {
  assert.equal(await text("link"), "続けるにはここをクリックしてください。");
  assert.equal(await text("a"), "ここ");
  assert.equal(await page.$eval("#a", (a) => a.href), "https://example.com/");
});

await check("code stays untouched in place", async () => {
  assert.equal(await text("code"), "ビルドの前にnpm installを実行してください。");
  assert.equal(await page.$eval("#code code", (c) => c.textContent), "npm install");
});

await check("text before a leading inline element is merged into it to keep reading order", async () => {
  assert.equal(await text("li2"), "2番目の太字項目");
  assert.equal(await page.$eval("#li2 b", (b) => b.textContent), "2番目の太字");
});

await check("Japanese, pre and notranslate are skipped", async () => {
  assert.equal(await text("ja"), "これは日本語の段落です。");
  assert.equal(await text("pre"), "Do not translate preformatted text.");
  assert.equal(await text("nt"), "Keep this sentence.");
});

await check("title is translated", async () => {
  assert.equal(await page.title(), "訳:Hello Title");
});

await check("off-screen paragraph is translated only after scrolling", async () => {
  assert.equal(await text("far"), "Far away paragraph text.");
  const sent = await page.evaluate(() => window.__sent);
  assert.ok(!sent.includes("Far away paragraph text."));
  await page.$eval("#far", (e) => e.scrollIntoView());
  await wait(400);
  assert.equal(await text("far"), "訳:Far away paragraph text.");
});

await check("dynamically added content is translated", async () => {
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.id = "dyn";
    p.textContent = "Added later.";
    document.getElementById("far").after(p);
  });
  await wait(1200);
  assert.equal(await text("dyn"), "訳:Added later.");
});

await check("page script rewriting a translated node is re-translated", async () => {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.getElementById("simple").firstChild.data = "Changed by page.";
  });
  await wait(1200);
  assert.equal(await text("simple"), "訳:Changed by page.");
});

await check("indicator is shown", async () => {
  assert.ok(await page.$("#sarashina-translate-ui"));
});

await check("restore brings back the original DOM", async () => {
  await page.evaluate(() => {
    document.getElementById("dyn").remove();
    window.__send({ action: "restore" });
  });
  await wait(100);
  const now = await page.evaluate(() => {
    const ui = document.getElementById("sarashina-translate-ui");
    if (ui) ui.remove();
    return document.body.innerHTML;
  });
  assert.equal(now.replace("Changed by page.", "This is a simple paragraph."), original);
  assert.equal(await page.title(), "Hello Title");
});

await check("re-translation uses page memory cache without new requests", async () => {
  const before = await page.evaluate(() => window.__sent.length);
  await page.evaluate(() => window.__send({ action: "translatePage", target: "ja", showOriginalOnHover: true }));
  await wait(50);
  assert.equal(await text("link"), "続けるにはここをクリックしてください。");
  assert.equal(await page.evaluate(() => window.__sent.length), before);
});

await check("assignTagged handles a link moved to the front", async () => {
  const res = await page.evaluate(() => {
    const p = document.createElement("p");
    p.innerHTML = "Please <a>download</a> the file now";
    const { collect, assignTagged } = window.__sarashinaTestHooks.internals;
    const out = [];
    collect(p, p, out);
    const piece = out[0];
    const map = assignTagged(piece, "<g1>ダウンロード</g1>してからファイルを開く");
    return { segment: piece.segment, parts: piece.slots.map((u) => map.get(u) || "") };
  });
  assert.equal(res.segment, "Please <g1>download</g1> the file now");
  assert.deepEqual(res.parts, ["", "ダウンロード", "してからファイルを開く"]);
});

await check("assignTagged keeps reading order when text precedes the link", async () => {
  const res = await page.evaluate(() => {
    const p = document.createElement("p");
    p.innerHTML = "<a>Download</a> the file";
    const { collect, assignTagged } = window.__sarashinaTestHooks.internals;
    const out = [];
    collect(p, p, out);
    const map = assignTagged(out[0], "ファイルを<g1>ダウンロード</g1>");
    return out[0].slots.map((u) => map.get(u) || "");
  });
  assert.deepEqual(res, ["ファイルをダウンロード", ""]);
});

await check("broken tags fall back to the first text node", async () => {
  const res = await page.evaluate(() => {
    const p = document.createElement("p");
    p.innerHTML = "Click <a>here</a> now";
    const { collect, assignTagged } = window.__sarashinaTestHooks.internals;
    const out = [];
    collect(p, p, out);
    const map = assignTagged(out[0], "今すぐここをクリック");
    return out[0].slots.map((u) => map.get(u) || "");
  });
  assert.deepEqual(res, ["今すぐここをクリック", "", ""]);
});

await browser.close();
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall e2e checks passed");
