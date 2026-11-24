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
  const ANCHOR_LEN = 48; // 前后各存多少个字符做锚点
  const UI_SELECTOR = ".rc-bar,.rc-pop,.rc-push,.rc-toast,.rc-dock,.rc-pending,.rc-restore";

  let enabled = false; // 阅读模式：默认关闭，只在 popup 里手动开
  let bar = null;
  let pop = null;
  let pending = null;

  let dock = null;
  let pushBtn = null;
  let pendingBtn = null;
  let restorePanel = null;
  let pendingItems = [];
  let panelOpen = false;
  let restoreRun = null;
  let refreshSeq = 0;

  const load = () => api.storage.local.get(KEY).then((o) => o[KEY] || []);
  const save = (items) => api.storage.local.set({ [KEY]: items });

  /* ---------- URL 归一化 ---------- */
  // 同一篇文章常带不同的 ?utm_* / #section，比较前先去掉纯跟踪参数和页内锚点。
  // 但 /#/route 这类 hash 路由要保留，否则会把不同文章当成同一篇。
  const TRACKING_PARAM = /^(?:utm_[^&]*|ga_[^&]*|fbclid|gclid|dclid|yclid|mc_cid|mc_eid|igshid|spm|scm|ref_src|ref_url|_hsenc|_hsmi|vero_id|oly_enc_id|oly_anon_id)$/i;

  function normalizeUrl(href) {
    try {
      const u = new URL(href, location.href);
      const routeHash = /^#!?\//.test(u.hash) ? u.hash : "";
      u.hash = "";
      const pairs = [];
      u.searchParams.forEach((v, k) => {
        if (!TRACKING_PARAM.test(k)) pairs.push([k, v]);
      });
      pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
      u.search = "";
      const q = new URLSearchParams();
      pairs.forEach(([k, v]) => q.append(k, v));
      u.search = q.toString();
      u.hash = routeHash;
      return u.href;
    } catch (e) {
      return String(href || "").split("#")[0];
    }
  }

  function sameUrl(a, b) {
    if (!a || !b) return false;
    return a === b || normalizeUrl(a) === normalizeUrl(b);
  }

  /* ---------- 文本偏移 / 正文索引 ---------- */
  function isPageText(node) {
    const el = node.parentElement;
    if (!el) return false;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(el.tagName)) return false;
    if (el.closest(UI_SELECTOR)) return false;
    return true;
  }

  function pageTextIndex() {
    if (!document.body) return { nodes: [], text: "" };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (isPageText(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    const parts = [];
    let pos = 0, n;
    while ((n = w.nextNode())) {
      const len = n.data.length;
      if (!len) continue;
      nodes.push({ node: n, start: pos, end: pos + len });
      parts.push(n.data);
      pos += len;
    }
    return { nodes, text: parts.join("") };
  }

  function offsetIn(idx, node, off) {
    for (const t of idx.nodes) {
      if (t.node === node) return t.start + off;
    }
    return -1;
  }

  function rangeFromOffsets(start, end, idx) {
    idx = idx || pageTextIndex();
    if (start < 0 || end <= start || end > idx.text.length) return null;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    for (const t of idx.nodes) {
      if (!startNode && start >= t.start && start < t.end) {
        startNode = t.node;
        startOff = start - t.start;
      }
      if (end > t.start && end <= t.end) {
        endNode = t.node;
        endOff = end - t.start;
        break;
      }
    }
    if (!startNode || !endNode) return null;
    const r = document.createRange();
    try {
      r.setStart(startNode, Math.max(0, startOff));
      r.setEnd(endNode, Math.max(0, endOff));
    } catch (e) {
      return null;
    }
    return r;
  }

  function trimOffsets(full, start, end) {
    let s = Math.max(0, start), e = Math.min(full.length, end);
    while (s < e && /\s/.test(full[s])) s++;
    while (e > s && /\s/.test(full[e - 1])) e--;
    return { start: s, end: e, text: full.slice(s, e) };
  }

  function normalizeWs(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  // 归一化空白，同时保留每个归一化字符回到原文的索引，方便把匹配位置变回 Range。
  function normalizedIndex(full) {
    let text = "";
    const map = [];
    let space = false;
    for (let i = 0; i < full.length; i++) {
      const ch = full[i];
      if (/\s/.test(ch)) {
        if (!space) {
          text += " ";
          map.push(i);
          space = true;
        }
      } else {
        text += ch;
        map.push(i);
        space = false;
      }
    }
    let s = 0, e = text.length;
    while (s < e && text[s] === " ") s++;
    while (e > s && text[e - 1] === " ") e--;
    return { text: text.slice(s, e), map: map.slice(s, e), full };
  }

  function normalizedEndForMatch(nidx, start, len) {
    let end = nidx.map[start + len - 1] + 1;
    while (end < nidx.full.length && /\s/.test(nidx.full[end])) end++;
    return end;
  }

  function exactMatches(hay, needle) {
    const out = [];
    if (!needle) return out;
    let i = hay.indexOf(needle);
    while (i >= 0 && out.length < 200) {
      out.push(i);
      i = hay.indexOf(needle, i + 1);
    }
    return out;
  }

  /* ---------- 锚点匹配 ---------- */
  function commonSuffixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function commonPrefixLen(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function scoreCandidate(it, idx, start, end) {
    const prefix = normalizeWs(it.prefix);
    const suffix = normalizeWs(it.suffix);
    const context = normalizeWs(it.context);
    const before = normalizeWs(idx.text.slice(Math.max(0, start - 200), start));
    const after = normalizeWs(idx.text.slice(end, Math.min(idx.text.length, end + 200)));
    let score = 0;

    if (prefix) {
      const n = commonSuffixLen(prefix, before);
      score += Math.min(n, prefix.length) * 2;
      if (n === prefix.length) score += 40;
    }
    if (suffix) {
      const n = commonPrefixLen(suffix, after);
      score += Math.min(n, suffix.length) * 2;
      if (n === suffix.length) score += 40;
    }
    if (context) {
      const win = normalizeWs(idx.text.slice(Math.max(0, start - 400), Math.min(idx.text.length, end + 400)));
      if (win.includes(context)) score += 30;
      else {
        const head = context.slice(0, 40);
        const tail = context.slice(-40);
        if (head && win.includes(head)) score += 10;
        if (tail && win.includes(tail)) score += 10;
      }
    }
    // 只有上下文分相同的时候，才用旧偏移做最近邻排序。
    if (Number.isFinite(it.start)) score -= Math.min(50, Math.abs(start - it.start) / 400);
    return score;
  }

  function hasMarkConflict(range, id) {
    for (const m of document.querySelectorAll("mark.rc-hl")) {
      if (m.dataset.rcId !== id && range.intersectsNode(m)) return true;
    }
    return false;
  }

  function locateRange(it, idx, nidx) {
    const text = String(it.text || "");
    const ntext = normalizeWs(text);
    if (!ntext) return null;

    const cands = [];
    const seen = new Set();
    const add = (start, end) => {
      if (start < 0 || end <= start || end > idx.text.length) return;
      const k = start + ":" + end;
      if (seen.has(k)) return;
      seen.add(k);
      cands.push({ start, end });
    };

    // 1) 原文精确匹配
    for (const s of exactMatches(idx.text, text)) add(s, s + text.length);
    // 2) 空白归一化后匹配（页面重排可能改变换行/空格）
    for (const s of exactMatches(nidx.text, ntext)) {
      add(nidx.map[s], normalizedEndForMatch(nidx, s, ntext.length));
    }
    // 3) 旧偏移兜底：只有偏移处文字确实对得上才用，避免错标
    if (Number.isFinite(it.start) && Number.isFinite(it.end)) {
      const t = trimOffsets(idx.text, it.start, it.end);
      if (t.text && normalizeWs(t.text) === ntext) add(t.start, t.end);
    }
    if (!cands.length) return null;

    const base = Number.isFinite(it.start) ? it.start : 0;
    const scored = cands.map((c) => ({ ...c, score: scoreCandidate(it, idx, c.start, c.end) }));
    scored.sort((a, b) => b.score - a.score || Math.abs(a.start - base) - Math.abs(b.start - base));

    for (const c of scored) {
      const range = rangeFromOffsets(c.start, c.end, idx);
      if (!range) continue;
      if (!sameBlock(range)) continue;
      if (hasMarkConflict(range, it.id)) continue;
      return { start: c.start, end: c.end, range };
    }
    return null;
  }

  function makeAnchor(idx, start, end) {
    return {
      prefix: idx.text.slice(Math.max(0, start - ANCHOR_LEN), start),
      suffix: idx.text.slice(end, end + ANCHOR_LEN),
    };
  }

  /* ---------- 包裹 / 分块判断 ---------- */
  function blockOf(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      const d = getComputedStyle(el).display;
      if (d === "block" || d === "list-item" || d === "table" || d === "flex") return el;
      el = el.parentElement;
    }
    return document.body;
  }

  function sameBlock(range) {
    try {
      return blockOf(range.startContainer) === blockOf(range.endContainer);
    } catch (e) {
      return false;
    }
  }

  // 单块内包裹：只处理一个 range，避免跨块破坏排版；也不允许套在已有高亮里
  function wrapRange(range, kind, id) {
    try {
      if (document.querySelector('mark.rc-hl[data-rc-id="' + id + '"]')) return null;
      if (!sameBlock(range)) return null;
      for (const m of document.querySelectorAll("mark.rc-hl")) {
        if (m.dataset.rcId !== id && range.intersectsNode(m)) return null;
      }
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
    setTimeout(() => el.remove(), 1800);
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

  async function commit(kind) {
    if (!pending) return;
    const id = "rc" + Date.now().toString(36);
    const idx = pageTextIndex();
    let start = pending.start, end = pending.end;
    let range = rangeFromOffsets(start, end, idx);
    let text = pending.text;

    // 选区到点击之间页面若发生位移，用锚点再定位一次；定位不到就放弃，避免错标
    if (!range || normalizeWs(range.toString()) !== normalizeWs(text)) {
      const found = locateRange({ ...pending, id }, idx, normalizedIndex(idx.text));
      if (!found) {
        removeBar();
        toast("页面内容变了，找不到刚才选中的文字，请重新选择", true);
        return;
      }
      start = found.start;
      end = found.end;
      range = found.range;
    }
    removeBar();
    if (!range) return;

    const trimmed = trimOffsets(idx.text, start, end);
    if (!trimmed.text) return;
    if (trimmed.text.length > 400) {
      toast("选中的文字太长了，请分段标", true);
      return;
    }
    if (!sameBlock(range)) {
      toast("跨段落暂不支持，请一段一段标", true);
      return;
    }
    start = trimmed.start;
    end = trimmed.end;
    text = trimmed.text;
    range = rangeFromOffsets(start, end, idx);
    if (!range) return;

    const mark = wrapRange(range, kind, id);
    if (!mark) {
      toast("这段文字已经有标记了", true);
      return;
    }

    const anchor = makeAnchor(idx, start, end);
    const item = {
      id,
      url: location.href,
      urlKey: normalizeUrl(location.href),
      title: document.title,
      kind,
      text,
      context: pending.context,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      note: "",
      start,
      end,
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
      const rawSelection = sel ? sel.toString() : "";
      // 没有选中文字（例如只是点了一下已有高亮）→ 不动浮层，否则会把它关掉
      if (!rawSelection.trim() || sel.rangeCount === 0) {
        removeBar();
        return;
      }
      closePopover(); // 有真实选区时，先收旧浮层再弹工具条
      const range = sel.getRangeAt(0);
      if (!document.body.contains(range.commonAncestorContainer)) return;
      const idx = pageTextIndex();
      const startRaw = offsetIn(idx, range.startContainer, range.startOffset);
      const endRaw = offsetIn(idx, range.endContainer, range.endOffset);
      if (startRaw < 0 || endRaw <= startRaw) return;
      const t = trimOffsets(idx.text, startRaw, endRaw);
      if (!t.text) return;
      if (t.text.length > 400) {
        removeBar();
        toast("选中的文字太长了，请分段标", true);
        return;
      }
      const anchor = makeAnchor(idx, t.start, t.end);
      pending = {
        text: t.text,
        context: sentenceAround(t.text),
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        start: t.start,
        end: t.end,
        rect: range.getBoundingClientRect(),
      };
      buildBar();
    }, 10);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      removeBar();
      closePopover();
      closeRestorePanel();
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (bar && !bar.contains(e.target)) removeBar();
    if (pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest("mark.rc-hl"))) closePopover();
    if (restorePanel && !restorePanel.contains(e.target) && !(e.target.closest && e.target.closest(".rc-pending"))) {
      closeRestorePanel();
    }
  });

  /* ---------- 恢复 ---------- */
  async function restore() {
    if (restoreRun) return restoreRun;
    restoreRun = (async () => {
      let all;
      try {
        all = await load();
      } catch (e) {
        return;
      }
      const idx = pageTextIndex();
      const nidx = normalizedIndex(idx.text);
      for (const it of all) {
        if (it.pushed || !sameUrl(it.url, location.href)) continue;
        if (document.querySelector('mark.rc-hl[data-rc-id="' + it.id + '"]')) continue;
        const found = locateRange(it, idx, nidx);
        if (!found) continue;
        wrapRange(found.range, it.kind, it.id);
      }
      await refreshPush();
    })().finally(() => {
      restoreRun = null;
    });
    return restoreRun;
  }

  /* ---------- 待恢复入口 ---------- */
  function ensureDock() {
    if (!dock) {
      dock = document.createElement("div");
      dock.className = "rc-dock";
      adaptTheme(dock);
      document.documentElement.appendChild(dock);
    }
    return dock;
  }

  function closeRestorePanel() {
    panelOpen = false;
    if (pendingBtn) pendingBtn.setAttribute("aria-expanded", "false");
    if (restorePanel) restorePanel.remove();
    restorePanel = null;
  }

  async function removeItem(id) {
    const all = await load();
    await save(all.filter((x) => x.id !== id));
    document.querySelectorAll(`mark.rc-hl[data-rc-id="${id}"]`).forEach((m) => m.replaceWith(...m.childNodes));
    toast("已删除");
    await refreshPush();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制 ✓");
      return;
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.documentElement.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("已复制 ✓");
    } catch (e) {
      toast("复制失败，请手动选中", true);
    }
  }

  function revealItem(it) {
    const idx = pageTextIndex();
    const nidx = normalizedIndex(idx.text);
    const found = locateRange(it, idx, nidx);
    let range = found && found.range;
    if (!range) {
      const p = idx.text.indexOf(it.text);
      if (p >= 0) range = rangeFromOffsets(p, p + it.text.length, idx);
    }
    if (!range) {
      toast("页面上找不到这段文字", true);
      return;
    }
    const rect = range.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, rect.top + window.scrollY - 120), behavior: "smooth" });
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {}
    toast("已定位原文，可重新标记");
  }

  function pendingRow(it) {
    const row = document.createElement("div");
    row.className = "rc-restore-item";

    const meta = document.createElement("div");
    meta.className = "rc-restore-meta";
    const kind = document.createElement("span");
    kind.className = "rc-restore-kind";
    kind.textContent = KIND[it.kind] || "标记";
    meta.appendChild(kind);
    const time = document.createElement("span");
    time.className = "rc-restore-time";
    try {
      time.textContent = new Date(it.ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    } catch (e) {}
    meta.appendChild(time);
    row.appendChild(meta);

    const text = document.createElement("div");
    text.className = "rc-restore-text";
    text.textContent = it.text;
    row.appendChild(text);

    if (it.note) {
      const note = document.createElement("div");
      note.className = "rc-restore-note";
      note.textContent = "注：" + it.note;
      row.appendChild(note);
    } else if (it.context) {
      const ctx = document.createElement("div");
      ctx.className = "rc-restore-ctx";
      ctx.textContent = it.context;
      row.appendChild(ctx);
    }

    const actions = document.createElement("div");
    actions.className = "rc-restore-actions";
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "rc-restore-btn";
    locate.textContent = "定位";
    locate.title = "滚动到原文并选中，方便重新标记";
    locate.addEventListener("click", () => revealItem(it));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "rc-restore-btn";
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyText(it.text));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rc-restore-btn rc-restore-del";
    del.textContent = "删除";
    del.addEventListener("click", () => removeItem(it.id));
    actions.appendChild(locate);
    actions.appendChild(copy);
    actions.appendChild(del);
    row.appendChild(actions);

    return row;
  }

  function renderRestorePanel() {
    if (!panelOpen) return;
    if (!pendingItems.length) {
      closeRestorePanel();
      return;
    }
    const d = ensureDock();
    if (!restorePanel) {
      restorePanel = document.createElement("div");
      restorePanel.className = "rc-restore";
      restorePanel.setAttribute("role", "region");
      restorePanel.setAttribute("aria-label", "待恢复的标记");
      restorePanel.addEventListener("mousedown", (e) => e.stopPropagation());
      adaptTheme(restorePanel);
    }
    restorePanel.textContent = "";

    const head = document.createElement("div");
    head.className = "rc-restore-head";
    const title = document.createElement("strong");
    title.textContent = pendingItems.length + " 条标记待恢复";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rc-restore-x";
    close.title = "关闭";
    close.textContent = "✕";
    close.addEventListener("click", closeRestorePanel);
    head.appendChild(title);
    head.appendChild(close);
    restorePanel.appendChild(head);

    const tip = document.createElement("p");
    tip.className = "rc-restore-tip";
    tip.textContent = "页面结构变了，找不到这些标记的原文。它们不会计入推送；可以定位后重新标记，或复制/删除。";
    restorePanel.appendChild(tip);

    const list = document.createElement("div");
    list.className = "rc-restore-list";
    pendingItems.forEach((it) => list.appendChild(pendingRow(it)));
    restorePanel.appendChild(list);

    const foot = document.createElement("div");
    foot.className = "rc-restore-foot";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "rc-restore-btn";
    retry.textContent = "重试恢复";
    retry.addEventListener("click", () => restore());
    foot.appendChild(retry);
    restorePanel.appendChild(foot);

    if (d.firstChild !== restorePanel) d.insertBefore(restorePanel, d.firstChild);
  }

  function toggleRestorePanel() {
    if (panelOpen) {
      closeRestorePanel();
      return;
    }
    panelOpen = true;
    if (pendingBtn) pendingBtn.setAttribute("aria-expanded", "true");
    renderRestorePanel();
  }

  /* ---------- 推送 ---------- */
  async function refreshPush() {
    const seq = ++refreshSeq;
    let all;
    try {
      all = await load();
    } catch (e) {
      return;
    }
    if (seq !== refreshSeq) return;

    const mine = all.filter((x) => !x.pushed && sameUrl(x.url, location.href));
    const rendered = new Set(Array.from(document.querySelectorAll("mark.rc-hl"), (m) => m.dataset.rcId));
    const visible = mine.filter((x) => rendered.has(x.id));
    const missing = mine.filter((x) => !rendered.has(x.id));
    pendingItems = missing;

    if (!visible.length && !missing.length) {
      closeRestorePanel();
      if (dock) {
        dock.remove();
        dock = null;
      }
      pushBtn = null;
      pendingBtn = null;
      return;
    }

    const d = ensureDock();

    if (visible.length) {
      if (!pushBtn) {
        pushBtn = document.createElement("button");
        pushBtn.className = "rc-push";
        pushBtn.addEventListener("click", doPush);
        adaptTheme(pushBtn);
      }
      pushBtn.textContent = "推送 " + visible.length + " 条 → Obsidian";
      d.appendChild(pushBtn);
    } else if (pushBtn) {
      pushBtn.remove();
      pushBtn = null;
    }

    if (missing.length) {
      if (!pendingBtn) {
        pendingBtn = document.createElement("button");
        pendingBtn.className = "rc-pending";
        pendingBtn.type = "button";
        pendingBtn.setAttribute("aria-haspopup", "true");
        pendingBtn.addEventListener("click", toggleRestorePanel);
        adaptTheme(pendingBtn);
      }
      pendingBtn.textContent = "⚠ " + missing.length + " 条待恢复";
      pendingBtn.title = "这些标记在当前页面找不到原文，未计入推送；点击查看";
      pendingBtn.setAttribute("aria-expanded", panelOpen ? "true" : "false");
      if (pushBtn) d.insertBefore(pendingBtn, pushBtn);
      else d.appendChild(pendingBtn);
      renderRestorePanel();
    } else {
      if (pendingBtn) {
        pendingBtn.remove();
        pendingBtn = null;
      }
      closeRestorePanel();
    }
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
    const mine = all.filter((x) => !x.pushed && sameUrl(x.url, location.href));
    const rendered = new Set(Array.from(document.querySelectorAll("mark.rc-hl"), (m) => m.dataset.rcId));
    const visible = mine.filter((x) => rendered.has(x.id));
    const missing = mine.length - visible.length;
    if (!visible.length) {
      toast("没有可推送的高亮；待恢复条目未计入", true);
      refreshPush();
      return;
    }
    const payload = {
      source: "reading-collector",
      version: "0.2",
      url: location.href,
      title: document.title,
      pushedAt: new Date().toISOString(),
      items: visible.map((x) => ({ id: x.id, kind: x.kind, text: x.text, context: x.context, note: x.note, ts: x.ts })),
    };
    try {
      const res = await api.runtime.sendMessage({ type: "download", payload });
      if (res && res.ok) {
        visible.forEach((m) => (m.pushed = true));
        await save(all);
        await pushHistory(visible);
        toast("已推送 " + visible.length + " 条 ✓" + (missing ? "，" + missing + " 条待恢复未推送" : ""));
        refreshPush();
      } else {
        toast("推送失败：" + ((res && res.error) || "未知"), true);
      }
    } catch (e) {
      toast("推送失败：" + e, true);
    }
  }

  restore();
  window.addEventListener("load", () => restore());
  // 懒加载页面：load 之后可能还会补正文，给一次有界重试
  setTimeout(() => restore(), 1500);

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
