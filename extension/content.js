// Reading Collector v0.2 —— 网页内标记 + 一键推送
// 设计要点：
//  · 不连本地服务，标完先在扩展存储里攒着
//  · 读完整篇点右下角「推送」→ 生成一个 JSON 下载到 Downloads
//  · 想法用网页内小浮层写，不用浏览器 prompt
//  · 点已有的高亮可以重开浮层改备注
(() => {
  if (window.__rcLoaded) return;
  window.__rcLoaded = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const KIND = { vocab: "🟢 生词", idea: "🟡 想法", fact: "🔵 事实" };
  const KEY = "rc.items";

  let enabled = false; // 阅读模式：默认关闭，只在 popup 里手动开
  let bar = null;
  let pop = null;
  let pending = null;

  const load = () => api.storage.local.get(KEY).then((o) => o[KEY] || []);
  const save = (items) => api.storage.local.set({ [KEY]: items });

  /* ---------- 文本偏移 ---------- */
  function isPageText(node) {
    const el = node.parentElement;
    if (!el) return false;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(el.tagName)) return false;
    if (el.closest(".rc-bar,.rc-pop,.rc-push,.rc-toast")) return false;
    return true;
  }

  function offsetOf(node, off) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isPageText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let total = 0, n;
    while ((n = w.nextNode())) {
      if (n === node) return total + off;
      total += n.data.length;
    }
    return -1;
  }

  function rangeFromOffsets(start, end) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isPageText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
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

  // 单块内包裹：只处理一个 range，避免跨块破坏排版
  function wrapRange(range, kind, id) {
    try {
      const mark = document.createElement("mark");
      mark.className = `rc-hl rc-${kind}`;
      mark.dataset.rcId = id;
      if (pageIsDark()) mark.classList.add("rc-dark");
      if (pageIsInverted()) mark.classList.add("rc-invert-fix");
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
    if (pick.trim().split(/\s+/).length < 6) {
      const idx = parts.indexOf(pick);
      if (idx >= 0 && parts[idx + 1]) pick = parts[idx + 1];
    }
    // 去掉混进来的小标题：取包含该词的最后一行
    if (pick.includes("\n")) {
      const lines = pick.split("\n").filter((l) => l.trim());
      const hit = lines.filter((l) => l.includes(text));
      if (hit.length) pick = hit[hit.length - 1];
    }
    return pick.replace(/\s+/g, " ").trim();
  }

  /* ---------- 深色 / 反色适配 ---------- */
  function pageIsInverted() {
    const f1 = getComputedStyle(document.documentElement).filter || "";
    const f2 = document.body ? getComputedStyle(document.body).filter || "" : "";
    return /invert\(/.test(f1) || /invert\(/.test(f2);
  }

  function pageIsDark() {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return true;
    } catch (e) {}
    const h = document.documentElement;
    if (h.classList.contains("skin-theme-clientpref-night") || h.classList.contains("night")) return true;
    if ((h.dataset.theme || "").toLowerCase() === "dark") return true;
    if (document.body) {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
        if (lum < 0.35) return true;
      }
    }
    return false;
  }

  function adaptTheme(el) {
    if (!el) return el;
    if (pageIsDark()) el.classList.add("rc-dark");
    if (pageIsInverted()) el.classList.add("rc-invert-fix");
    return el;
  }

  /* ---------- 浮层 ---------- */
  function removeBar() {
    if (bar) bar.remove();
    bar = null;
  }

  function toast(msg, bad) {
    const el = document.createElement("div");
    el.className = "rc-toast" + (bad ? " rc-toast--bad" : "");
    el.textContent = msg;
    adaptTheme(el);
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  function closePopover() {
    if (pop) pop.remove();
    pop = null;
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

    adaptTheme(pop);
    document.documentElement.appendChild(pop);
    const w = pop.offsetWidth || 280;
    const left = Math.max(8, Math.min(anchorRect.left + window.scrollX, window.innerWidth - w - 12));
    const top = anchorRect.top + window.scrollY - (pop.offsetHeight || 160) - 10;
    pop.style.left = left + "px";
    pop.style.top = Math.max(8, top) + "px";
    setTimeout(() => ta.focus(), 30);
  }

  /* ---------- 标记 ---------- */
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
    adaptTheme(bar);
    document.documentElement.appendChild(bar);
    if (pending && pending.rect) {
      bar.style.left = Math.max(8, pending.rect.left + window.scrollX) + "px";
      bar.style.top = Math.max(8, pending.rect.top + window.scrollY - 46) + "px";
    }
  }

  function spansBlocks(startNode) {
    // 选区起点和终点若不在同一个块级容器里，就视为跨段
    const range = rangeFromOffsets(pending.start, pending.end);
    if (!range) return true;
    const blockOf = (n) => {
      let el = n.nodeType === 1 ? n : n.parentElement;
      while (el && el !== document.body) {
        const d = getComputedStyle(el).display;
        if (d === "block" || d === "list-item" || d === "table" || d === "flex") return el;
        el = el.parentElement;
      }
      return document.body;
    };
    return blockOf(range.startContainer) !== blockOf(range.endContainer);
  }

  async function commit(kind) {
    if (!pending) return;
    if (spansBlocks()) {
      removeBar();
      toast("跨段落暂不支持，请一段一段标", true);
      return;
    }
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
    const items = await load();
    items.push(item);
    await save(items);
    pending = null;

    openPopover(
      mark.getBoundingClientRect(),
      item,
      async (note) => {
        const all = await load();
        const it = all.find((x) => x.id === id);
        if (it) it.note = note;
        await save(all);
        closePopover();
        toast("已保存 ✓");
        refreshPush();
      },
      async () => {
        const all = await load();
        await save(all.filter((x) => x.id !== id));
        document.querySelectorAll(`mark.rc-hl[data-rc-id="${id}"]`).forEach((m) => m.replaceWith(...m.childNodes));
        closePopover();
        toast("已删除");
        refreshPush();
      }
    );
    const inBlock = marksInSameBlock(mark);
    if (inBlock > 3) toast(`本段已标 ${inBlock} 个，建议先读完再补`);
    refreshPush();
  }

  function marksInSameBlock(el) {
    let b = el;
    while (b && b !== document.body) {
      const d = getComputedStyle(b).display;
      if (d === "block" || d === "list-item" || d === "table") break;
      b = b.parentElement;
    }
    return b ? b.querySelectorAll("mark.rc-hl").length : 0;
  }

  /* ---------- 点已有高亮 ---------- */
  document.addEventListener("click", async (e) => {
    const mark = e.target.closest && e.target.closest("mark.rc-hl");
    if (!mark) return;
    const id = mark.dataset.rcId;
    const all = await load();
    const item = all.find((x) => x.id === id);
    if (!item) return;
    openPopover(
      mark.getBoundingClientRect(),
      item,
      async (note) => {
        item.note = note;
        await save(all);
        closePopover();
        toast("已更新 ✓");
      },
      async () => {
        await save(all.filter((x) => x.id !== id));
        document.querySelectorAll(`mark.rc-hl[data-rc-id="${id}"]`).forEach((m) => m.replaceWith(...m.childNodes));
        closePopover();
        toast("已删除");
        refreshPush();
      }
    );
  });

  /* ---------- 选区 ---------- */
  document.addEventListener("mouseup", () => {
    setTimeout(() => {
      if (!enabled) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      // 没有选中文字（例如只是点了一下已有高亮）→ 不动浮层，否则会把它关掉
      if (!text || text.length > 400 || sel.rangeCount === 0) {
        removeBar();
        return;
      }
      closePopover(); // 有真实选区时，先收旧浮层再弹工具条
      const range = sel.getRangeAt(0);
      if (!document.body.contains(range.commonAncestorContainer)) return;
      const start = offsetOf(range.startContainer, range.startOffset);
      const end = offsetOf(range.endContainer, range.endOffset);
      if (start < 0 || end <= start) return;
      pending = { text, context: sentenceAround(text), start, end, rect: range.getBoundingClientRect() };
      buildBar();
    }, 10);
  });

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

  /* ---------- 恢复 ---------- */
  async function restore() {
    const all = await load();
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
  let pushBtn = null;

  async function refreshPush() {
    const all = await load();
    const n = all.filter((x) => !x.pushed && x.url === location.href).length;
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
      adaptTheme(pushBtn);
      document.documentElement.appendChild(pushBtn);
    }
    pushBtn.textContent = "推送 " + n + " 条 → Obsidian";
  }

  async function pushHistory(mine) {
    const key = "rc.history";
    const cur = (await api.storage.local.get(key))[key] || [];
    const kinds = { vocab: 0, idea: 0, fact: 0 };
    mine.forEach((m) => (kinds[m.kind] = (kinds[m.kind] || 0) + 1));
    cur.push({
      ts: new Date().toISOString(),
      url: location.href,
      title: document.title,
      count: mine.length,
      kinds,
    });
    await api.storage.local.set({ [key]: cur.slice(-500) });
  }

  async function doPush() {
    const all = await load();
    const mine = all.filter((x) => !x.pushed && x.url === location.href);
    if (!mine.length) return;
    const payload = {
      source: "reading-collector",
      version: "0.2",
      url: location.href,
      title: document.title,
      pushedAt: new Date().toISOString(),
      items: mine.map((x) => ({ id: x.id, kind: x.kind, text: x.text, context: x.context, note: x.note, ts: x.ts })),
    };
    try {
      const res = await api.runtime.sendMessage({ type: "download", payload });
      if (res && res.ok) {
        mine.forEach((m) => (m.pushed = true));
        await save(all);
        await pushHistory(mine);
        toast("已推送 " + mine.length + " 条 ✓");
        refreshPush();
      } else {
        toast("推送失败：" + ((res && res.error) || "未知"), true);
      }
    } catch (e) {
      toast("推送失败：" + e, true);
    }
  }

  restore();

  /* ---------- 阅读模式开关 ---------- */
  api.storage.local.get("rc.enabled").then((o) => {
    enabled = o["rc.enabled"] === true;
    if (!enabled) {
      removeBar();
      closePopover();
    }
  });

  api.storage.onChanged.addListener((ch) => {
    if (ch["rc.enabled"]) {
      enabled = ch["rc.enabled"].newValue === true;
      if (!enabled) {
        removeBar();
        closePopover();
      } else {
        toast("阅读模式已开启 ✓");
      }
    }
  });
})();
