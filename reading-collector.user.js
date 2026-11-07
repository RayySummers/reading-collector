// ==UserScript==
// @name         Reading Collector
// @namespace    https://raysview.fun/reading-collector
// @version      0.3.0
// @description  选中文字 → 标记生词/想法/事实 → 网页内写注 → 一键推送到 Obsidian
// @author       Rayy Summers + Hari
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  if (window.__rcLoaded) return;
  window.__rcLoaded = true;

  const KIND = { vocab: "🟢 生词", idea: "🟡 想法", fact: "🔵 事实" };
  const KEY = "rc.items";
  const ENABLED = "rc.enabled";

  let enabled = GM_getValue(ENABLED, false);
  let bar = null;
  let pop = null;
  let pending = null;
  let pushBtn = null;
  let badge = null;

  const load = () => {
    try {
      return JSON.parse(GM_getValue(KEY, "[]")) || [];
    } catch (e) {
      return [];
    }
  };
  const save = (items) => GM_setValue(KEY, JSON.stringify(items));

  /* ---------- 文本偏移 ---------- */
  function isPageText(node) {
    const el = node.parentElement;
    if (!el) return false;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(el.tagName)) return false;
    if (el.closest(".rc-bar,.rc-pop,.rc-push,.rc-toast,.rc-badge")) return false;
    return true;
  }

  function walker() {
    return document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isPageText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
  }

  function offsetOf(node, off) {
    const w = walker();
    let total = 0, n;
    while ((n = w.nextNode())) {
      if (n === node) return total + off;
      total += n.data.length;
    }
    return -1;
  }

  function rangeFromOffsets(start, end) {
    const w = walker();
    let total = 0, n, startNode = null, startOff = 0, endNode = null, endOff = 0;
    while ((n = w.nextNode())) {
      const len = n.data.length;
      if (!startNode && total + len > start) {
        startNode = n;
        startOff = start - total;
      }
      if (!endNode && total + len >= end) {
        endNode = n;
        endOff = end - total;
        break;
      }
      total += len;
    }
    if (!startNode || !endNode) return null;
    const r = document.createRange();
    r.setStart(startNode, Math.max(0, startOff));
    r.setEnd(endNode, Math.max(0, endOff));
    return r;
  }

  function wrapRange(range, kind, id) {
    const mark = document.createElement("mark");
    mark.className = "rc-hl rc-" + kind;
    mark.dataset.rcId = id;
    try {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
      return mark;
    } catch (e) {
      return null;
    }
  }

  function sentenceAround(text) {
    const body = document.body.innerText || "";
    const i = body.indexOf(text);
    if (i < 0) return text;
    const seg = body.slice(Math.max(0, i - 600), i + text.length + 600);
    const parts = seg.split(/(?<=[.!?。！？])\s+/);
    let pick = parts.find((p) => p.includes(text)) || text;
    if (pick.includes("\n")) {
      const lines = pick.split("\n").filter((l) => l.trim());
      const hit = lines.filter((l) => l.includes(text));
      if (hit.length) pick = hit[hit.length - 1];
    }
    return pick.replace(/\s+/g, " ").trim();
  }

  /* ---------- 样式 ---------- */
  const CSS = `
  .rc-bar{position:absolute;z-index:2147483647;display:flex;gap:4px;padding:5px;border-radius:12px;
    background:#111113;box-shadow:0 8px 28px rgba(0,0,0,.35);font:13px/1.2 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .rc-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#f2f2f5;
    border-radius:8px;padding:6px 10px;cursor:pointer;white-space:nowrap;font:inherit}
  .rc-btn:hover{background:rgba(255,255,255,.16)}
  mark.rc-hl{border-radius:3px;padding:0 1px;cursor:pointer}
  mark.rc-vocab{background:#dcfce7;color:inherit}
  mark.rc-idea{background:#fef9c3;color:inherit}
  mark.rc-fact{background:#dbeafe;color:inherit}
  .rc-pop{position:absolute;z-index:2147483647;width:300px;background:#fff;color:#18181b;border-radius:12px;
    box-shadow:0 12px 36px rgba(0,0,0,.28);border:1px solid #e4e4e7;padding:12px;
    font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .rc-pop-head{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:8px}
  .rc-pop-x{border:none;background:none;cursor:pointer;font-size:13px;color:#a1a1aa}
  .rc-pop-quote{color:#52525b;font-size:12px;border-left:3px solid #e4e4e7;padding-left:8px;margin-bottom:8px;max-height:54px;overflow:auto}
  .rc-pop-note{width:100%;box-sizing:border-box;resize:vertical;border:1px solid #e4e4e7;border-radius:8px;padding:8px;font:inherit;color:#18181b}
  .rc-pop-actions{display:flex;justify-content:space-between;margin-top:8px}
  .rc-pop-actions button{border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer;border:1px solid #e4e4e7;background:#f6f6f7;color:#18181b}
  .rc-pop-actions .rc-pop-save{background:#111113;color:#fff;border-color:#111113}
  .rc-pop-actions .rc-pop-del{color:#b91c1c;border-color:#fecaca;background:#fef2f2}
  .rc-push{position:fixed;right:20px;bottom:20px;z-index:2147483647;border:none;border-radius:999px;padding:11px 16px;
    background:#111113;color:#fff;font:600 13px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    box-shadow:0 8px 28px rgba(0,0,0,.35);cursor:pointer}
  .rc-badge{position:fixed;left:16px;bottom:16px;z-index:2147483647;width:26px;height:26px;border-radius:999px;
    background:#22c55e;box-shadow:0 3px 10px rgba(0,0,0,.25);opacity:.55;cursor:pointer;
    font:700 12px/26px -apple-system,sans-serif;color:#fff;text-align:center}
  .rc-badge:hover{opacity:1}
  .rc-toast{position:fixed;right:20px;bottom:70px;z-index:2147483647;background:#111113;color:#fff;padding:9px 14px;
    border-radius:12px;font:14px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)}
  .rc-toast--bad{background:#7f1d1d}
  `;

  const style = document.createElement("style");
  style.textContent = CSS;
  document.documentElement.appendChild(style);

  /* ---------- UI ---------- */
  function removeBar() {
    if (bar) {
      bar.remove();
      bar = null;
    }
  }

  function closePopover() {
    if (pop) {
      pop.remove();
      pop = null;
    }
  }

  function toast(msg, bad) {
    const el = document.createElement("div");
    el.className = "rc-toast" + (bad ? " rc-toast--bad" : "");
    el.textContent = msg;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  function openPopover(anchorRect, item, onSave, onDelete) {
    closePopover();
    pop = document.createElement("div");
    pop.className = "rc-pop";
    pop.innerHTML =
      '<div class="rc-pop-head"><span class="rc-pop-kind"></span><button class="rc-pop-x" title="关闭">✕</button></div>' +
      '<div class="rc-pop-quote"></div>' +
      '<textarea class="rc-pop-note" rows="3" placeholder="写点什么（可留空）…"></textarea>' +
      '<div class="rc-pop-actions"><button class="rc-pop-del">删除</button><button class="rc-pop-save">保存 ⌘↵</button></div>';
    pop.querySelector(".rc-pop-kind").textContent = KIND[item.kind] || "";
    pop.querySelector(".rc-pop-quote").textContent = item.text.slice(0, 180);
    const ta = pop.querySelector(".rc-pop-note");
    ta.value = item.note || "";
    pop.querySelector(".rc-pop-x").addEventListener("click", closePopover);
    pop.querySelector(".rc-pop-save").addEventListener("click", () => onSave(ta.value));
    pop.querySelector(".rc-pop-del").addEventListener("click", () => onDelete());
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSave(ta.value);
      if (e.key === "Escape") closePopover();
    });
    document.documentElement.appendChild(pop);
    const w = pop.offsetWidth || 300;
    const left = Math.max(8, Math.min(anchorRect.left + window.scrollX, window.innerWidth - w - 12));
    const top = anchorRect.top + window.scrollY - (pop.offsetHeight || 170) - 10;
    pop.style.left = left + "px";
    pop.style.top = Math.max(8, top) + "px";
    setTimeout(() => ta.focus(), 30);
  }

  function buildBar() {
    removeBar();
    bar = document.createElement("div");
    bar.className = "rc-bar";
    ["vocab", "idea", "fact"].forEach((k) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rc-btn";
      b.textContent = KIND[k];
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => commit(k));
      bar.appendChild(b);
    });
    document.documentElement.appendChild(bar);
    if (pending && pending.rect) {
      bar.style.left = Math.max(8, pending.rect.left + window.scrollX) + "px";
      bar.style.top = Math.max(8, pending.rect.top + window.scrollY - 46) + "px";
    }
  }

  async function commit(kind) {
    if (!pending) return;
    const id = "rc" + Date.now().toString(36);
    const range = rangeFromOffsets(pending.start, pending.end);
    removeBar();
    if (!range) return;
    const mark = wrapRange(range, kind, id);
    if (!mark) return;
    const item = {
      id,
      url: location.href,
      title: document.title,
      kind,
      text: pending.text,
      context: pending.context,
      note: "",
      start: pending.start,
      end: pending.end,
      ts: new Date().toISOString(),
      pushed: false,
    };
    const items = load();
    items.push(item);
    save(items);
    pending = null;
    openPopover(
      mark.getBoundingClientRect(),
      item,
      (note) => {
        const all = load();
        const it = all.find((x) => x.id === id);
        if (it) it.note = note;
        save(all);
        closePopover();
        toast("已保存 ✓");
        refreshPush();
      },
      () => {
        save(load().filter((x) => x.id !== id));
        mark.replaceWith(...mark.childNodes);
        closePopover();
        toast("已删除");
        refreshPush();
      }
    );
    refreshPush();
  }

  document.addEventListener("click", (e) => {
    const mark = e.target.closest && e.target.closest("mark.rc-hl");
    if (!mark) return;
    const id = mark.dataset.rcId;
    const all = load();
    const item = all.find((x) => x.id === id);
    if (!item) return;
    openPopover(
      mark.getBoundingClientRect(),
      item,
      (note) => {
        item.note = note;
        save(all);
        closePopover();
        toast("已更新 ✓");
      },
      () => {
        save(all.filter((x) => x.id !== id));
        mark.replaceWith(...mark.childNodes);
        closePopover();
        toast("已删除");
        refreshPush();
      }
    );
  });

  /* ---------- 选区（鼠标 + 触屏） ---------- */
  function handleSelection() {
    if (!enabled || pop) return;
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!text || text.length > 400 || sel.rangeCount === 0) {
      removeBar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) return;
    const start = offsetOf(range.startContainer, range.startOffset);
    const end = offsetOf(range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return;
    pending = { text, context: sentenceAround(text), start, end, rect: range.getBoundingClientRect() };
    buildBar();
  }

  document.addEventListener("mouseup", () => setTimeout(handleSelection, 10));
  document.addEventListener("touchend", () => setTimeout(handleSelection, 350));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      removeBar();
      closePopover();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (bar && !bar.contains(e.target)) removeBar();
    if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest("mark.rc-hl"))) closePopover();
  });

  /* ---------- 恢复高亮 ---------- */
  function restore() {
    const all = load();
    for (const it of all) {
      if (it.pushed || it.url !== location.href) continue;
      if (document.querySelector('mark.rc-hl[data-rc-id="' + it.id + '"]')) continue;
      const r = rangeFromOffsets(it.start, it.end);
      if (!r) continue;
      const slice = document.body.textContent.slice(it.start, it.end).replace(/\s+/g, " ").trim();
      if (slice !== it.text.replace(/\s+/g, " ").trim()) continue;
      wrapRange(r, it.kind, it.id);
    }
    refreshPush();
  }

  /* ---------- 推送 ---------- */
  function refreshPush() {
    const n = load().filter((x) => !x.pushed && x.url === location.href).length;
    if (!n) {
      if (pushBtn) {
        pushBtn.remove();
        pushBtn = null;
      }
      return;
    }
    if (!pushBtn) {
      pushBtn = document.createElement("button");
      pushBtn.className = "rc-push";
      pushBtn.addEventListener("click", doPush);
      document.documentElement.appendChild(pushBtn);
    }
    pushBtn.textContent = "推送 " + n + " 条 → Obsidian";
  }

  function doPush() {
    const all = load();
    const mine = all.filter((x) => !x.pushed && x.url === location.href);
    if (!mine.length) return;
    const payload = {
      source: "reading-collector-userscript",
      version: "0.3.0",
      url: location.href,
      title: document.title,
      pushedAt: new Date().toISOString(),
      items: mine.map((x) => ({ id: x.id, kind: x.kind, text: x.text, context: x.context, note: x.note, ts: x.ts })),
    };
    const json = JSON.stringify(payload, null, 1);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = "reading-push-" + stamp + ".json";
    try {
      if (typeof GM_download === "function") {
        const blobUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        GM_download({ url: blobUrl, name, saveAs: false, onload: () => URL.revokeObjectURL(blobUrl) });
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      mine.forEach((m) => (m.pushed = true));
      save(all);
      toast("已推送 " + mine.length + " 条 ✓");
      refreshPush();
    } catch (e) {
      toast("推送失败：" + e, true);
    }
  }

  /* ---------- 开关 ---------- */
  function paintBadge() {
    if (!enabled) {
      if (badge) {
        badge.remove();
        badge = null;
      }
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "rc-badge";
      badge.textContent = "R";
      badge.title = "Reading Collector 已开启（点一下关闭）";
      badge.addEventListener("click", () => setEnabled(false));
      document.documentElement.appendChild(badge);
    }
  }

  function setEnabled(v) {
    enabled = v;
    GM_setValue(ENABLED, v);
    if (!v) {
      removeBar();
      closePopover();
      toast("阅读模式已关闭");
    } else {
      toast("阅读模式已开启 ✓");
    }
    paintBadge();
  }

  GM_registerMenuCommand("阅读模式：开/关", () => setEnabled(!enabled));

  paintBadge();
  restore();

  // 跨标签页同步开关
  window.addEventListener("storage", (e) => {
    if (e.key === "rc.enabled") {
      enabled = e.newValue === "true";
      paintBadge();
    }
  });
})();
