// ページ翻訳コンテンツスクリプト。背景ページから必要になったときだけ注入される。
//
// ページを「ピース」（ブロック要素直下の、インライン要素を含む一続きのテキスト）に分け、
// 画面に入ったピースだけを背景ページへ送る。インライン要素は <g1>…</g1> の形で
// 訳文中の位置を保たせ、既存のテキストノードの中身だけを書き換える（DOM 構造は変えない）。

(() => {
  "use strict";
  if (window.__sarashinaTranslate) return;
  window.__sarashinaTranslate = true;

  const { needsTranslation, opposite } = globalThis.SarashinaLang;

  /* ---------- 要素の分類 ---------- */

  // 文中に現れて、テキストの一部として訳すインライン要素
  const INLINE = new Set(
    (
      "a abbr acronym b bdi bdo big cite data del dfn em font i ins label mark nobr q rb rp rt ruby " +
      "s small span strike strong sub sup time tt u var"
    ).split(" "),
  );
  // 文中の位置は保つが中身は訳さない要素
  const ATOMIC = new Set(["code", "kbd", "samp"]);
  // テキストを持たない文中要素（ピースを分断しない）
  const VOID = new Set(["img", "wbr", "picture", "svg", "i-icon", "source"]);
  // ピースを分断する要素
  const BREAK = new Set(["br", "hr"]);
  // 中を見ない要素
  const SKIP = new Set(
    (
      "script style noscript template textarea input select option optgroup datalist pre math " +
      "canvas iframe frame object embed video audio map head title"
    ).split(" "),
  );

  const MAX_PIECE_CHARS = 1200;
  const UI_HOST_ID = "sarashina-translate-ui";

  function isNoTranslate(el) {
    if (el.id === UI_HOST_ID) return true;
    if (el.translate === false) return true; // translate="no"（継承込み）
    if (el.classList && el.classList.contains("notranslate")) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isPureInline(el) {
    const all = el.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) {
      const name = all[i].localName;
      if (all[i].closest("svg") && all[i].closest("svg") !== all[i]) continue; // svg の中身
      if (INLINE.has(name) || ATOMIC.has(name) || VOID.has(name)) {
        if (isNoTranslate(all[i])) return false;
        continue;
      }
      return false;
    }
    return true;
  }

  function textNodesOf(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && n.parentElement.closest("svg") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  const normalize = (s) => s.replace(/\s+/g, " ").trim();

  /* ---------- ピースの抽出 ---------- */

  let seq = 0;
  let target = "ja";

  function collect(root, host, out) {
    let units = [];
    let size = 0;
    const flush = () => {
      if (units.length) {
        const piece = makePiece(host, units);
        if (piece) out.push(piece);
      }
      units = [];
      size = 0;
    };
    const add = (unit) => {
      const len = unit.raw.length;
      if (size + len > MAX_PIECE_CHARS && units.some((u) => u.kind !== "space")) flush();
      units.push(unit);
      size += len;
    };

    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.data.trim()) {
          if (units.length) units.push({ kind: "space", node, raw: " " });
          continue;
        }
        add({ kind: "text", node, textNodes: [node], raw: node.data });
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node;
      const name = el.localName;
      if (SKIP.has(name) || isNoTranslate(el)) {
        flush();
        continue;
      }
      if (BREAK.has(name)) {
        flush();
        continue;
      }
      if (VOID.has(name)) continue;
      if (ATOMIC.has(name) && isPureInline(el)) {
        if (el.textContent.trim()) add({ kind: "atomic", node: el, textNodes: [], raw: el.textContent });
        continue;
      }
      if (INLINE.has(name) && isPureInline(el)) {
        const textNodes = textNodesOf(el);
        const raw = textNodes.map((t) => t.data).join("");
        if (raw.trim()) add({ kind: "inline", node: el, textNodes, raw });
        continue;
      }
      flush();
      collect(el, el, out);
      if (el.shadowRoot) collect(el.shadowRoot, el, out);
    }
    flush();
  }

  function makePiece(parent, units) {
    while (units.length && units[units.length - 1].kind === "space") units.pop();
    const slots = units.filter((u) => u.kind !== "space");
    const writable = slots.filter((u) => u.kind !== "atomic");
    if (!writable.length) return null;

    const plain = normalize(units.map((u) => u.raw).join(""));
    if (!needsTranslation(plain, target)) return null;

    let segment;
    let tagged = false;
    if (slots.length === 1) {
      segment = plain;
    } else {
      tagged = true;
      let k = 0;
      segment = normalize(
        units
          .map((u) => {
            if (u.kind === "space" || u.kind === "text") return u.raw;
            u.tag = ++k;
            return `<g${k}>${u.raw}</g${k}>`;
          })
          .join(""),
      );
    }
    return {
      id: ++seq,
      parent,
      units,
      slots,
      writable,
      segment,
      tagged,
      original: plain,
      state: "pending",
      originals: new Map(),
    };
  }

  /* ---------- 訳文の書き戻し ---------- */

  const written = new WeakMap(); // textNode -> 書き込んだ値

  function parseTagged(text) {
    const items = [];
    const re = /<g(\d+)>([\s\S]*?)<\/g\1>/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) items.push({ plain: text.slice(last, m.index) });
      items.push({ tag: Number(m[1]), text: m[2] });
      last = re.lastIndex;
    }
    if (last < text.length) items.push({ plain: text.slice(last) });
    const strip = (s) => s.replace(/<\/?g\d+>/g, "");
    return items
      .map((it) => (it.plain !== undefined ? { plain: strip(it.plain) } : { tag: it.tag, text: strip(it.text) }))
      .filter((it) => it.plain === undefined || it.plain.length > 0);
  }

  /**
   * 訳文の各断片をどのテキストノードに入れるかを決める。
   * DOM 構造を変えずに語順の入れ替わりを吸収するため、訳文の並びに沿って
   * 「まだ使っていない後ろのテキストスロット」へ順に詰めていく。
   */
  function assignTagged(piece, translated) {
    const items = parseTagged(translated);
    const slots = piece.slots;
    const tagSlot = new Map();
    slots.forEach((u, i) => u.tag && tagSlot.set(u.tag, i));

    const seen = items.filter((it) => it.tag !== undefined).map((it) => it.tag);
    const valid =
      seen.length === tagSlot.size && new Set(seen).size === seen.length && seen.every((t) => tagSlot.has(t));
    const assign = new Map();
    if (!valid) {
      // タグが崩れた場合: 訳文全体を先頭のテキストに入れる
      const whole = normalize(translated.replace(/<\/?g\d+>/g, ""));
      const first = piece.writable.find((u) => u.kind === "text") || piece.writable[0];
      assign.set(first, whole);
      return assign;
    }

    const append = (unit, text) => assign.set(unit, (assign.get(unit) || "") + text);
    const remainingTags = new Set(seen);
    let cursor = 0;
    let last = null;
    let pending = "";
    for (const it of items) {
      if (it.tag !== undefined) {
        remainingTags.delete(it.tag);
        const s = tagSlot.get(it.tag);
        const unit = slots[s];
        if (unit.kind === "inline") {
          append(unit, pending + it.text);
          pending = "";
          last = unit;
        }
        cursor = Math.max(cursor, s + 1);
        continue;
      }
      // 後で出てくるタグのスロットを飛び越えない範囲で、次のテキストスロットを探す
      let found = -1;
      for (let i = cursor; i < slots.length; i++) {
        if (slots[i].tag && remainingTags.has(slots[i].tag)) break;
        if (slots[i].kind === "text") {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        append(slots[found], pending + it.plain);
        pending = "";
        cursor = found + 1;
        last = slots[found];
      } else if (last) {
        append(last, it.plain);
      } else {
        pending += it.plain;
      }
    }
    if (pending) append(piece.writable[0], pending);
    return assign;
  }

  function writeText(piece, node, value) {
    if (!piece.originals.has(node)) piece.originals.set(node, node.data);
    node.data = value;
    written.set(node, value);
  }

  function applyTranslation(piece, translated) {
    if (!piece.tagged) {
      const unit = piece.writable[0];
      const [first, ...rest] = unit.textNodes;
      const orig = piece.originals.has(first) ? piece.originals.get(first) : first.data;
      const lead = unit.textNodes.length === 1 ? orig.match(/^\s*/)[0] : "";
      const trail = unit.textNodes.length === 1 ? orig.match(/\s*$/)[0] : "";
      writeText(piece, first, lead + translated + trail);
      for (const n of rest) writeText(piece, n, "");
    } else {
      const assign = assignTagged(piece, translated);
      for (const unit of piece.writable) {
        const value = assign.get(unit) || "";
        unit.textNodes.forEach((n, i) => writeText(piece, n, i === 0 ? value : ""));
      }
    }
    piece.state = "done";
    piece.translated = translated;
  }

  function restorePiece(piece) {
    for (const [node, orig] of piece.originals) {
      // ページ側が書き換えたノードはそのままにする
      if (written.get(node) === node.data) node.data = orig;
      written.delete(node);
    }
    piece.originals.clear();
    piece.state = "restored";
  }

  /* ---------- 状態 ---------- */

  const state = {
    mode: "original", // original | translated
    pieces: new Map(), // id -> piece
    segCache: new Map(), // segment -> translation（ページ内メモリキャッシュ）
    port: null,
    pending: 0,
    waitMs: 0,
    failed: 0,
    error: null,
    showOriginalOnHover: true,
    title: null,
  };

  let io = null;
  let mo = null;
  const observed = new Map(); // 監視対象要素 -> Set<piece>
  let byParent = new WeakMap(); // 親要素 -> Set<piece>（原文ツールチップ用）

  function getPort() {
    if (state.port) return state.port;
    const port = browser.runtime.connect({ name: "sarashina-page" });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      if (state.port === port) state.port = null;
      // 未完了のものは表示中なら再送できるように戻す
      for (const p of state.pieces.values()) {
        if (p.state === "queued") {
          p.state = "pending";
          observePiece(p);
        }
      }
    });
    state.port = port;
    return port;
  }

  function onPortMessage(msg) {
    if (msg.type === "result") {
      if (msg.id === "title") {
        if (state.mode === "translated" && state.title) {
          state.title.translated = msg.text;
          state.segCache.set(state.title.original, msg.text);
          document.title = msg.text;
        }
        return;
      }
      const piece = state.pieces.get(msg.id);
      if (!piece) return;
      state.segCache.set(piece.segment, msg.text);
      if (piece.state === "queued" && state.mode === "translated") {
        withoutObserver(() => applyTranslation(piece, msg.text));
      }
    } else if (msg.type === "failed") {
      const piece = state.pieces.get(msg.id);
      if (piece && piece.state === "queued") piece.state = "failed";
      state.failed++;
      state.error = msg.message;
      ui.update();
    } else if (msg.type === "error") {
      state.error = msg.message;
      for (const p of state.pieces.values()) if (p.state === "queued") p.state = "failed";
      ui.update();
    } else if (msg.type === "status") {
      state.pending = msg.pending;
      state.waitMs = msg.waitMs;
      ui.update();
    }
  }

  /* ---------- 表示中のピースだけを送る ---------- */

  const toSend = new Set();
  let sendTimer = null;

  function request(piece) {
    if (piece.state !== "pending") return;
    const hit = state.segCache.get(piece.segment);
    if (hit !== undefined) {
      withoutObserver(() => applyTranslation(piece, hit));
      return;
    }
    piece.state = "queued";
    toSend.add(piece);
    if (!sendTimer) sendTimer = setTimeout(flushSend, 80);
  }

  function flushSend() {
    sendTimer = null;
    const items = [];
    for (const p of toSend) if (p.state === "queued") items.push({ id: p.id, text: p.segment });
    toSend.clear();
    if (!items.length) return;
    getPort().postMessage({ type: "translate", items, source: opposite(target), target });
    state.pending += items.length;
    ui.update();
  }

  function observeTarget(el) {
    // display: contents の要素は IntersectionObserver で検知できないので祖先を見る
    let cur = el;
    while (cur && cur !== document.body && cur.getClientRects().length === 0) {
      if (getComputedStyle(cur).display !== "contents") break;
      cur = cur.parentElement;
    }
    return cur || el;
  }

  function observePiece(piece) {
    const el = observeTarget(piece.parent);
    let set = observed.get(el);
    if (!set) {
      set = new Set();
      observed.set(el, set);
      io.observe(el);
    }
    set.add(piece);
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const set = observed.get(entry.target);
      observed.delete(entry.target);
      io.unobserve(entry.target);
      if (set) for (const p of set) request(p);
    }
  }

  function addPieces(root) {
    const found = [];
    collect(root, root.nodeType === Node.ELEMENT_NODE ? root : document.body, found);
    for (const p of found) {
      state.pieces.set(p.id, p);
      if (!byParent.has(p.parent)) byParent.set(p.parent, new Set());
      byParent.get(p.parent).add(p);
      const hit = state.segCache.get(p.segment);
      if (hit !== undefined) withoutObserver(() => applyTranslation(p, hit));
      else observePiece(p);
    }
    return found.length;
  }

  /* ---------- 動的に変化するページへの追従 ---------- */

  function withoutObserver(fn) {
    fn();
    if (mo) mo.takeRecords();
  }

  const dirty = new Set();
  let dirtyTimer = null;

  function blockRootOf(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el !== document.body && INLINE.has(el.localName)) el = el.parentElement;
    return el;
  }

  function onMutations(records) {
    for (const r of records) {
      const t = r.target;
      const el = t.nodeType === Node.ELEMENT_NODE ? t : t.parentElement;
      if (!el || (ui.host && (el === ui.host || ui.host.contains(el)))) continue;
      if (r.type === "characterData" && written.get(t) === t.data) continue;
      if (r.type === "childList" && r.addedNodes.length === 0) continue;
      const root = blockRootOf(t);
      if (root) dirty.add(root);
    }
    if (dirty.size && !dirtyTimer) dirtyTimer = setTimeout(flushDirty, 500);
  }

  function flushDirty() {
    dirtyTimer = null;
    if (state.mode !== "translated") return dirty.clear();
    const roots = [...dirty].filter((r) => r.isConnected);
    dirty.clear();
    const top = roots.filter((r) => !roots.some((o) => o !== r && o.contains(r)));
    withoutObserver(() => {
      for (const root of top) {
        for (const p of [...state.pieces.values()]) {
          if (!p.parent.isConnected) {
            state.pieces.delete(p.id);
            continue;
          }
          if (root.contains(p.parent)) {
            if (p.state === "done") restorePiece(p);
            p.state = "stale";
            state.pieces.delete(p.id);
            if (byParent.has(p.parent)) byParent.get(p.parent).delete(p);
          }
        }
        addPieces(root);
      }
    });
    ui.update();
  }

  /* ---------- ページ全体の翻訳・復元 ---------- */

  function translatePage(opts) {
    if (state.mode === "translated" && opts.target === target) return;
    if (state.mode === "translated") restorePage();
    target = opts.target;
    state.showOriginalOnHover = opts.showOriginalOnHover;
    state.mode = "translated";
    state.error = null;
    state.failed = 0;
    state.segCache = state.segCache.size && state.segTarget === target ? state.segCache : new Map();
    state.segTarget = target;

    io = new IntersectionObserver(onIntersect, { rootMargin: "600px 0px 600px 0px" });
    addPieces(document.body);

    const title = normalize(document.title || "");
    if (title && needsTranslation(title, target)) {
      state.title = { original: document.title, translated: null };
      const hit = state.segCache.get(document.title);
      if (hit) document.title = hit;
      else
        getPort().postMessage({
          type: "translate",
          items: [{ id: "title", text: title }],
          source: opposite(target),
          target,
        });
    }

    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    ui.show();
    ui.update();
  }

  function restorePage() {
    if (state.mode !== "translated") return;
    if (state.port) state.port.postMessage({ type: "cancel" });
    if (mo) mo.disconnect();
    if (io) io.disconnect();
    mo = io = null;
    observed.clear();
    toSend.clear();
    for (const p of state.pieces.values()) if (p.state === "done") restorePiece(p);
    state.pieces.clear();
    byParent = new WeakMap();
    if (state.title) {
      if (state.title.translated && document.title === state.title.translated) document.title = state.title.original;
      state.title = null;
    }
    state.mode = "original";
    state.pending = 0;
    hover.hide();
    ui.update();
  }

  function stats() {
    let done = 0;
    let total = 0;
    for (const p of state.pieces.values()) {
      total++;
      if (p.state === "done") done++;
    }
    return { done, total };
  }

  /* ---------- 画面右下のインジケータ ---------- */

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
    .wrap { --bg: #ffffff; --fg: #1d2733; --muted: #5b6b7c; --line: #d5dde6; --accent: #2f5d8a; --accent-fg: #fff; --err: #b3261e; }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg: #1f2630; --fg: #e8edf3; --muted: #a2b0bf; --line: #3a4553; --accent: #7fb2e5; --accent-fg: #0d1a26; --err: #ff8a80; }
    }
    .badge { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
      padding: 6px 8px 6px 12px; border-radius: 999px; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      box-shadow: 0 4px 16px rgba(0,0,0,.18); font-size: 13px; line-height: 1.4; max-width: calc(100vw - 32px); }
    .badge.err { border-color: var(--err); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
    .busy .dot { animation: pulse 1s ease-in-out infinite; }
    .err .dot { background: var(--err); }
    @keyframes pulse { 50% { opacity: .3; } }
    .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .err .msg { white-space: normal; }
    button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 999px; font-size: 12px; color: var(--accent); border: 1px solid var(--line); }
    button:hover { background: var(--line); }
    button.x { padding: 3px 7px; border: none; color: var(--muted); }
    .tip { position: fixed; z-index: 2147483647; max-width: min(480px, calc(100vw - 32px)); padding: 8px 10px; border-radius: 8px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(0,0,0,.2);
      font-size: 13px; line-height: 1.5; pointer-events: none; white-space: pre-wrap; }
    .tip .label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 2px; }
    .bubble { position: fixed; z-index: 2147483647; width: min(420px, calc(100vw - 32px)); padding: 10px 12px; border-radius: 10px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); box-shadow: 0 8px 28px rgba(0,0,0,.22); font-size: 14px; line-height: 1.6; }
    .bubble .head { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .bubble .body { white-space: pre-wrap; max-height: 40vh; overflow: auto; }
    .bubble .body.err { color: var(--err); }
    .bubble .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; }
  `;

  const ui = {
    host: null,
    root: null,
    badge: null,
    hidden: false,
    ensure() {
      if (this.host && this.host.isConnected) return;
      this.host = document.createElement("div");
      this.host.id = UI_HOST_ID;
      this.host.setAttribute("translate", "no");
      this.root = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      const wrap = document.createElement("div");
      wrap.className = "wrap";
      this.root.append(style, wrap);
      this.wrap = wrap;
      (document.body || document.documentElement).appendChild(this.host);
    },
    show() {
      this.hidden = false;
      this.ensure();
    },
    update() {
      if (state.mode !== "translated") {
        if (this.badge) this.badge.remove();
        this.badge = null;
        return;
      }
      if (this.hidden) return;
      this.ensure();
      if (!this.badge) {
        this.badge = document.createElement("div");
        this.badge.className = "badge";
        this.badge.innerHTML =
          '<span class="dot"></span><span class="msg"></span>' +
          '<button class="orig" title="原文に戻す">原文</button><button class="x" title="閉じる">✕</button>';
        this.badge.querySelector(".orig").addEventListener("click", () => restorePage());
        this.badge.querySelector(".x").addEventListener("click", () => {
          this.hidden = true;
          this.badge.remove();
          this.badge = null;
        });
        this.wrap.appendChild(this.badge);
      }
      const { done, total } = stats();
      let text;
      let cls = "badge";
      if (state.error && state.pending === 0) {
        text = `翻訳エラー: ${state.error}`;
        cls += " err";
      } else if (state.pending > 0) {
        cls += " busy";
        const wait = Math.ceil(state.waitMs / 1000);
        text = `翻訳中… 残り ${state.pending} 件` + (wait > 1 ? `（API 枠待ち ${wait} 秒）` : "");
      } else if (total === 0 && !state.title) {
        text = "翻訳が必要なテキストは見つかりませんでした";
      } else {
        text = `翻訳済み ${done}/${total}` + (done < total ? "（スクロールで続きを翻訳）" : "");
      }
      this.badge.className = cls;
      this.badge.querySelector(".msg").textContent = text;
    },
  };

  /* ---------- マウスオーバーで原文を表示 ---------- */

  const hover = {
    tip: null,
    timer: null,
    current: null,
    hide() {
      clearTimeout(this.timer);
      this.current = null;
      if (this.tip) this.tip.remove();
      this.tip = null;
    },
    findPieces(el) {
      for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
        const set = byParent.get(cur);
        const ps = set ? [...set].filter((p) => p.state === "done") : [];
        if (ps.length) return { el: cur, pieces: ps };
        if (!INLINE.has(cur.localName)) return null;
      }
      return null;
    },
    onOver(ev) {
      if (state.mode !== "translated" || !state.showOriginalOnHover) return;
      const t = ev.target;
      if (!(t instanceof Element) || t === ui.host) return;
      const found = hover.findPieces(t);
      if (!found) return hover.hide();
      if (hover.current === found.el) return;
      hover.hide();
      hover.current = found.el;
      hover.timer = setTimeout(() => hover.show(found), 700);
    },
    show({ el, pieces }) {
      ui.ensure();
      const tip = document.createElement("div");
      tip.className = "tip";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = "原文";
      tip.append(label, document.createTextNode(pieces.map((p) => p.original).join("\n")));
      ui.wrap.appendChild(tip);
      const r = el.getBoundingClientRect();
      const h = tip.offsetHeight;
      const top = r.bottom + 6 + h < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6);
      tip.style.top = `${top}px`;
      tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8))}px`;
      this.tip = tip;
    },
  };
  document.addEventListener("mouseover", (e) => hover.onOver(e), { passive: true });
  window.addEventListener("scroll", () => hover.hide(), { passive: true });

  /* ---------- 選択テキストの翻訳結果 ---------- */

  const bubble = {
    el: null,
    close() {
      if (this.el) this.el.remove();
      this.el = null;
    },
    show(msg) {
      ui.ensure();
      if (!this.el) {
        const sel = window.getSelection();
        let rect = null;
        if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) rect = { left: 16, bottom: 16, top: 16 };
        const el = document.createElement("div");
        el.className = "bubble";
        el.innerHTML =
          '<div class="head"><span class="dir"></span><button class="x" title="閉じる">✕</button></div>' +
          '<div class="body"></div><div class="actions"><button class="copy">コピー</button></div>';
        el.querySelector(".x").addEventListener("click", () => this.close());
        el.querySelector(".copy").addEventListener("click", () => {
          navigator.clipboard.writeText(el.querySelector(".body").textContent).catch(() => {});
        });
        el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 436))}px`;
        el.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 160))}px`;
        ui.wrap.appendChild(el);
        this.el = el;
      }
      const body = this.el.querySelector(".body");
      const dir = this.el.querySelector(".dir");
      const copy = this.el.querySelector(".copy");
      body.classList.toggle("err", msg.state === "error");
      if (msg.state === "loading") {
        dir.textContent = "Sarashina 翻訳";
        body.textContent = "翻訳中…";
        copy.hidden = true;
      } else if (msg.state === "error") {
        body.textContent = msg.message;
        copy.hidden = true;
      } else {
        dir.textContent = msg.source === "ja" ? "日本語 → 英語" : "英語 → 日本語";
        body.textContent = msg.text;
        copy.hidden = false;
      }
    },
  };
  document.addEventListener(
    "mousedown",
    (e) => {
      if (bubble.el && e.composedPath && !e.composedPath().includes(bubble.el)) bubble.close();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") bubble.close();
  });

  /* ---------- 背景ページからのメッセージ ---------- */

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg.action) {
      case "ping":
        return Promise.resolve({ ok: true });
      case "getState": {
        const { done, total } = stats();
        return Promise.resolve({
          injected: true,
          mode: state.mode,
          target,
          pending: state.pending,
          done,
          total,
          error: state.error,
        });
      }
      case "translatePage":
        translatePage(msg);
        return Promise.resolve({ ok: true, mode: state.mode });
      case "restore":
        restorePage();
        return Promise.resolve({ ok: true, mode: state.mode });
      case "toggle":
        if (state.mode === "translated") restorePage();
        else translatePage(msg);
        return Promise.resolve({ ok: true, mode: state.mode });
      case "getSelection":
        return Promise.resolve({ text: String(window.getSelection() || "") });
      case "selection":
        bubble.show(msg);
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  });

  // テスト用に内部関数を公開（拡張機能としての動作には影響しない）
  if (window.__sarashinaTestHooks) {
    window.__sarashinaTestHooks.internals = { collect, assignTagged, parseTagged, state, translatePage, restorePage };
  }
})();
