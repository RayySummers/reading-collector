// Reading Collector popup：阅读开关 + 统计 + 热力图 + 最近推送
const api = typeof browser !== "undefined" ? browser : chrome;
const ITEMS = "rc.items";
const ENABLED = "rc.enabled";
const HISTORY = "rc.history";

const loadItems = () => api.storage.local.get(ITEMS).then((o) => o[ITEMS] || []);
const saveItems = (v) => api.storage.local.set({ [ITEMS]: v });
const loadEnabled = () => api.storage.local.get(ENABLED).then((o) => o[ENABLED] === true);
const saveEnabled = (v) => api.storage.local.set({ [ENABLED]: v });
const loadHistory = () => api.storage.local.get(HISTORY).then((o) => o[HISTORY] || []);

const toggle = document.getElementById("toggle");
const stateEl = document.getElementById("state");
const hintEl = document.getElementById("hint");

const dayKey = (d) => {
  const x = new Date(d);
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
};

function paint(on) {
  toggle.setAttribute("aria-checked", on ? "true" : "false");
  stateEl.textContent = on ? "开启" : "关闭";
  hintEl.textContent = on ? "划词后出现三个标记按钮" : "关闭时不在页面上响应划词";
}

/* 热力图：近 12 周，7 行（周一到周日）× 12 列 */
function renderHeat(history) {
  const counts = {};
  for (const h of history) {
    const k = dayKey(h.ts);
    counts[k] = (counts[k] || 0) + (h.count || 0);
  }
  const max = Math.max(1, ...Object.values(counts));
  const wrap = document.getElementById("heat");
  wrap.innerHTML = "";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // 对齐到本周一
  const dow = (today.getDay() + 6) % 7; // 周一=0
  const thisMonday = new Date(today);
  thisMonday.setDate(today.getDate() - dow);

  for (let w = 11; w >= 0; w--) {
    const colEl = document.createElement("div");
    colEl.className = "week";
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() - w * 7);
    for (let d = 0; d < 7; d++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + d);
      const cell = document.createElement("i");
      if (day > today) {
        cell.style.visibility = "hidden";
      } else {
        const n = counts[dayKey(day)] || 0;
        if (n > 0) {
          const ratio = n / max;
          cell.dataset.l = ratio > 0.75 ? "4" : ratio > 0.5 ? "3" : ratio > 0.25 ? "2" : "1";
        }
        if (dayKey(day) === dayKey(today)) cell.dataset.today = "1";
        cell.title = dayKey(day) + "：" + n + " 条";
      }
      colEl.appendChild(cell);
    }
    wrap.appendChild(colEl);
  }
}

function renderRecent(history) {
  const ul = document.getElementById("recent");
  ul.innerHTML = "";
  const latest = history.slice(-5).reverse();
  if (!latest.length) {
    ul.innerHTML = '<li class="empty">还没有推送记录</li>';
    return;
  }
  for (const h of latest) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "t";
    title.textContent = h.title || h.url || "未命名";
    title.title = h.title || h.url;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = new Date(h.ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) + " · " + (h.count || 0) + " 条";
    li.appendChild(title);
    li.appendChild(n);
    ul.appendChild(li);
  }
}

async function render() {
  const [on, items, history] = await Promise.all([loadEnabled(), loadItems(), loadHistory()]);
  paint(on);

  const today = dayKey(new Date());
  const sevenAgo = new Date();
  sevenAgo.setDate(sevenAgo.getDate() - 6);

  let todayCount = 0;
  let weekCount = 0;
  for (const h of history) {
    const d = new Date(h.ts);
    if (dayKey(d) === today) todayCount += h.count || 0;
    if (d >= sevenAgo) weekCount += h.count || 0;
  }
  document.getElementById("today").textContent = todayCount;
  document.getElementById("week").textContent = weekCount;

  renderHeat(history);
  renderRecent(history);

  // 未推送统计（保留在「清空」按钮的可用性判断里）
  const pending = items.filter((x) => !x.pushed);
  document.getElementById("clear").disabled = pending.length === 0;
}

toggle.addEventListener("click", async () => {
  const on = await loadEnabled();
  await saveEnabled(!on);
  paint(!on);
});

document.getElementById("clear").addEventListener("click", async () => {
  const items = await loadItems();
  await saveItems(items.filter((x) => x.pushed));
  await render();
});

render();
