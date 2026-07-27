"use strict";

const state = { queryMode: "single", currentView: "query" };
const QUERY_ENDPOINTS = {
  single: "/api/v1/query",
  batch: "/api/v1/query/batch"
};
const MAX_BATCH_SIZE = 100;

const VIEW_META = {
  history: { title: "查询历史", desc: "本地保存的最近查询，点击任意一条可快速重查" },
  logs: { title: "运行日志", desc: "查询过程的实时日志，SSE 推送，可切换详细 (DEBUG)" },
  docs: { title: "接口文档", desc: "请求调用方式与返回数据格式说明" },
  settings: { title: "设置", desc: "配置代理、节流与重试，保存即时生效（仅本机使用）" }
};
const MODE_META = {
  single: { title: "单条查询", desc: "输入域名、应用名或主办单位名称即可查询备案状态" },
  batch: { title: "批量查询", desc: "每行一个查询词，自动去重，最多 100 条，可设并发" }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  bindQueryControls();
  bindSidebarNav();
  bindNavToggle();
  bindApiExamples();
  bindCopyButtons();
  updateKeywordCount();
  renderHistory();
  bindLogStream();
  bindSettings();
  $("#clear-history").addEventListener("click", () => { persistHistory([]); renderHistory(); });
});

/* ---------- View switching ---------- */
function bindSidebarNav() {
  $$('.nav-item, .brand').forEach((el) => el.addEventListener("click", (event) => {
    if (el.tagName === "A") event.preventDefault();
    switchView(el.dataset.view, el.dataset.mode);
  }));
}

function switchView(view, mode) {
  if (!view) return;
  state.currentView = view;

  if (view === "query" && mode) setQueryMode(mode);

  $$('.view').forEach((section) => section.classList.toggle("hidden", section.dataset.view !== view));

  $$('.nav-item').forEach((item) => {
    const active = item.dataset.view === view && (!item.dataset.mode || item.dataset.mode === state.queryMode);
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const meta = view === "query" ? MODE_META[state.queryMode] : VIEW_META[view];
  if (meta) {
    $("#view-title").textContent = meta.title;
    $("#view-desc").textContent = meta.desc;
  }

  $("#clear-history").classList.toggle("hidden", view !== "history");
  if (view === "history") renderHistory();

  closeNav();
}

function setQueryMode(mode) {
  state.queryMode = mode;
  $$('[data-query-pane]').forEach((pane) => {
    pane.classList.toggle("pane-off", pane.dataset.queryPane !== mode);
  });
  clearFeedback();
}

/* ---------- Mobile drawer ---------- */
function bindNavToggle() {
  const toggle = $("#nav-toggle");
  toggle.addEventListener("click", () => {
    const open = $(".app-shell").classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  $("#sidebar-scrim").addEventListener("click", closeNav);
}

function closeNav() {
  $(".app-shell").classList.remove("nav-open");
  $("#nav-toggle").setAttribute("aria-expanded", "false");
}

/* ---------- Query controls ---------- */
function bindQueryControls() {
  const range = $("#concurrency");
  range.addEventListener("input", () => {
    $("#concurrency-value").textContent = range.value;
  });
  $("#batch-keywords").addEventListener("input", updateKeywordCount);
  $("#query-form").addEventListener("submit", submitQuery);
}

async function submitQuery(event) {
  event.preventDefault();
  const buttons = $$('#query-form button[type="submit"]');
  let path;
  let payload;

  if (state.queryMode === "single") {
    const keyword = $("#single-keyword").value.trim();
    if (!keyword) return setFeedback("请输入域名、应用名或主办单位名称。", "error");
    path = QUERY_ENDPOINTS.single;
    payload = { keyword, service_type: Number($("#single-service-type").value) };
  } else {
    const keywords = parseKeywords($("#batch-keywords").value);
    if (!keywords.length) return setFeedback("请至少输入一个查询词。", "error");
    if (keywords.length > MAX_BATCH_SIZE) return setFeedback(`单次批量查询最多支持 ${MAX_BATCH_SIZE} 条。`, "error");
    path = QUERY_ENDPOINTS.batch;
    payload = {
      keywords,
      service_type: Number($("#batch-service-type").value),
      concurrency: Number($("#concurrency").value)
    };
  }

  setButtonsLoading(buttons, true);
  const loadingText = state.queryMode === "batch"
    ? `正在以 ${payload.concurrency} 个并发查询 ${payload.keywords.length} 条数据…`
    : "正在连接工信部备案系统，请稍候…";
  setFeedback(loadingText, "loading");

  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok && !data.data) throw new Error(extractError(data));

    if (state.queryMode === "single") renderResults([data.data], { elapsed_ms: data.data?.elapsed_ms });
    else renderResults(data.results || [], data);

    const failed = state.queryMode === "single" ? !data.data?.success : data.failed > 0;
    setFeedback(failed ? "查询已完成，部分请求未成功。" : "查询完成。", failed ? "error" : "success");

    saveHistory(state.queryMode === "single"
      ? { mode: "single", keyword: payload.keyword, service_type: payload.service_type }
      : { mode: "batch", keywords: payload.keywords, service_type: payload.service_type });
  } catch (error) {
    setFeedback(`请求失败：${error.message}`, "error");
  } finally {
    setButtonsLoading(buttons, false);
  }
}

function renderResults(results, meta = {}) {
  const body = $("#result-body");
  const rows = [];
  let foundKeywords = 0;
  let empty = 0;
  let failed = 0;
  let recordCount = 0;

  results.forEach((result) => {
    if (!result?.success) {
      failed++;
      rows.push(resultRow(result, null, "error", result?.error || "上游服务请求失败"));
      return;
    }
    const records = Array.isArray(result.records) ? result.records : [];
    if (!result.found || !records.length) {
      empty++;
      rows.push(resultRow(result, null, "empty", "未查询到备案信息"));
      return;
    }
    foundKeywords++;
    recordCount += records.length;
    records.forEach((record) => rows.push(resultRow(result, record, "ok", "已备案")));
  });

  body.innerHTML = rows.join("") || '<tr><td colspan="8" class="empty-cell">暂无查询结果</td></tr>';
  $("#result-summary").innerHTML = [
    `<span class="summary-pill">查询词 ${results.length}</span>`,
    `<span class="summary-pill">已备案 ${foundKeywords}</span>`,
    `<span class="summary-pill">备案记录 ${recordCount}</span>`,
    empty ? `<span class="summary-pill">未备案 ${empty}</span>` : "",
    failed ? `<span class="summary-pill danger">失败 ${failed}</span>` : "",
    meta.elapsed_ms != null ? `<span class="summary-pill">耗时 ${meta.elapsed_ms} ms</span>` : ""
  ].filter(Boolean).join("");
  $("#result-panel").classList.remove("hidden");
}

function resultRow(result, record, status, statusText) {
  const licence = record ? (record.serviceLicence || record.mainLicence || "—") : "—";
  const message = status === "error"
    ? `<span title="${escapeHtml(statusText)}">${escapeHtml(shorten(statusText, 30))}</span>`
    : "—";
  return `<tr>
    <td><strong>${escapeHtml(result?.keyword || "—")}</strong></td>
    <td><span class="status-tag ${status}">${escapeHtml(statusText)}</span></td>
    <td>${record ? escapeHtml(record.domain || "—") : message}</td>
    <td>${record ? escapeHtml(record.unitName || "—") : "—"}</td>
    <td>${record ? escapeHtml(record.nature || "—") : "—"}</td>
    <td class="licence">${escapeHtml(licence)}</td>
    <td>${record ? escapeHtml(record.updateTime || "—") : "—"}</td>
    <td>${Number.isFinite(result?.elapsed_ms) ? `${result.elapsed_ms} ms` : "—"}</td>
  </tr>`;
}

function parseKeywords(value) {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function updateKeywordCount() {
  const count = parseKeywords($("#batch-keywords").value).length;
  const counter = $("#keyword-count");
  counter.textContent = `${count} / ${MAX_BATCH_SIZE}`;
  counter.classList.toggle("over-limit", count > MAX_BATCH_SIZE);
}

function setButtonsLoading(buttons, loading) {
  buttons.forEach((button) => {
    button.disabled = loading;
    button.classList.toggle("is-loading", loading);
  });
}

function setFeedback(message, type = "") {
  const feedback = $("#query-feedback");
  feedback.textContent = message;
  feedback.className = `query-feedback ${type}`.trim();
}

function clearFeedback() { setFeedback(""); }

/* ---------- Run log (SSE) ---------- */
function bindLogStream() {
  const body = $("#log-body");
  const empty = $("#log-empty");
  const status = $("#log-status");
  const dot = $("#log-live-dot");
  const verbose = $("#log-verbose");
  const autoscroll = $("#log-autoscroll");
  const MAX_LINES = 2000;
  const seenIds = new Set();  // 基于唯一 ID 去重

  const atTop = () => body.scrollTop < 40;
  const scrollToTop = () => { body.scrollTop = 0; };

  verbose.addEventListener("change", () => {
    body.classList.toggle("show-debug", verbose.checked);
    if (autoscroll.checked) scrollToTop();
  });
  $("#log-clear").addEventListener("click", () => {
    $$('#log-body .log-line').forEach((line) => line.remove());
    empty.classList.remove("hidden");
    seenIds.clear();
  });

  function appendLog(item) {
    if (!item || !item.id) return;

    // 基于唯一 ID 去重（SSE 重连、多次加载都能防重）
    if (seenIds.has(item.id)) return;
    seenIds.add(item.id);

    // 限制内存：超过 3000 条时，清理最旧的 1000 条
    if (seenIds.size > 3000) {
      const oldest = Array.from(seenIds).slice(0, 1000);
      oldest.forEach(id => seenIds.delete(id));
    }

    empty.classList.add("hidden");
    const follow = autoscroll.checked && atTop();
    const line = document.createElement("div");
    line.className = `log-line lv-${item.level}`;
    line.dataset.id = item.id;
    line.innerHTML =
      `<span class="log-time">${fmtLogTime(item.ts)}</span>` +
      `<span class="log-badge">${escapeHtml(item.level)}</span>` +
      `<span class="log-name" title="${escapeHtml(item.logger)}">${escapeHtml(shortLoggerName(item.logger))}</span>` +
      `<span class="log-msg">${escapeHtml(item.msg)}</span>`;

    // 最新日志插入到顶部
    body.insertBefore(line, body.firstChild);

    if (follow) {
      scrollToTop();
    } else {
      // 未跟随时补偿滚动位置，避免视图跳动
      body.scrollTop += line.offsetHeight;
    }

    // 超限时删除最旧的（底部）
    const lines = body.querySelectorAll(".log-line");
    if (lines.length > MAX_LINES) {
      for (let i = MAX_LINES; i < lines.length; i++) {
        lines[i].remove();
      }
    }
  }

  function setStatus(name, text) {
    status.dataset.state = name;
    status.querySelector("span").textContent = text;
    if (dot) dot.classList.toggle("live", name === "open");
  }

  (function connect() {
    let source;
    try {
      source = new EventSource("/api/v1/logs/stream");
    } catch {
      setStatus("error", "无法连接");
      return;
    }
    source.onopen = () => setStatus("open", "已连接");
    source.onmessage = (event) => {
      try { appendLog(JSON.parse(event.data)); } catch { /* 忽略心跳/坏帧 */ }
    };
    source.onerror = () => setStatus("error", "连接断开，自动重连…");  // EventSource 会自动重连
  })();
}

function fmtLogTime(ts) {
  const date = new Date((ts || 0) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shortLoggerName(name) {
  const text = String(name || "");
  return text.length > 15 ? `…${text.slice(-14)}` : text;
}

/* ---------- Settings (proxy / throttle) ---------- */
function bindSettings() {
  const form = $("#settings-form");
  if (!form) return;
  loadConfig();
  form.addEventListener("submit", saveConfig);
  $("#test-proxy").addEventListener("click", testProxy);
}

async function testProxy() {
  const button = $("#test-proxy");
  const el = $("#test-result");
  button.disabled = true;
  el.innerHTML = '<span class="summary-pill">测试中…（测试当前运行配置，如动态API会实时提取）</span>';
  try {
    const res = await fetch("/api/v1/config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})  // 发送空对象，后端会测试当前运行配置
    });
    const data = await res.json();
    if (data.ok) {
      el.innerHTML = [
        `<span class="summary-pill pill-ok">✓ 连通</span>`,
        `<span class="summary-pill">出口 IP：${escapeHtml(data.exit_ip || "?")}</span>`,
        `<span class="summary-pill">代理：${escapeHtml(data.proxy || "直连")}</span>`,
        `<span class="summary-pill">${data.elapsed_ms} ms</span>`
      ].join("");
    } else {
      el.innerHTML = `<span class="summary-pill danger">✗ 失败：${escapeHtml(data.error || "未知错误")}</span>`;
    }
  } catch (error) {
    el.innerHTML = `<span class="summary-pill danger">✗ 请求失败：${escapeHtml(error.message)}</span>`;
  } finally {
    button.disabled = false;
  }
}

async function loadConfig() {
  try {
    const res = await fetch("/api/v1/config");
    if (res.ok) fillConfig(await res.json());
  } catch { /* ignore */ }
}

function fillConfig(cfg) {
  if (!cfg) return;
  $("#cfg-proxies").value = (cfg.proxies || []).join("\n");
  $("#cfg-api").value = cfg.api_url || "";
  $("#cfg-auth").value = cfg.auth || "";
  $("#cfg-interval").value = cfg.min_interval ?? 0.8;
  $("#cfg-retries").value = cfg.max_retries ?? 3;
  $("#cfg-ttl").value = cfg.api_ttl ?? 10;
  $("#cfg-blacklist-threshold").value = cfg.blacklist_threshold ?? 3;
  $("#cfg-blacklist-duration").value = cfg.blacklist_duration ?? 300;
  renderConfigStatus(cfg.status);
}

function renderConfigStatus(status) {
  const el = $("#settings-status");
  if (!status) { el.innerHTML = ""; return; }
  el.innerHTML = [
    `<span class="summary-pill">${status.enabled ? "代理已启用" : "直连（未启用代理）"}</span>`,
    `<span class="summary-pill">当前：${escapeHtml(status.current || "直连")}</span>`,
    `<span class="summary-pill">切换 ${status.rotations || 0} 次</span>`
  ].join("");
}

async function saveConfig(event) {
  event.preventDefault();
  const button = $('#settings-form button[type="submit"]');
  const payload = {
    proxies: $("#cfg-proxies").value,
    api_url: $("#cfg-api").value.trim(),
    auth: $("#cfg-auth").value.trim(),
    min_interval: Number($("#cfg-interval").value),
    max_retries: Number($("#cfg-retries").value),
    api_ttl: Number($("#cfg-ttl").value),
    blacklist_threshold: Number($("#cfg-blacklist-threshold").value),
    blacklist_duration: Number($("#cfg-blacklist-duration").value)
  };
  setButtonsLoading([button], true);
  setConfigFeedback("正在保存…", "loading");
  try {
    const res = await fetch("/api/v1/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fillConfig(await res.json());
    setConfigFeedback("已保存，立即生效。", "success");
  } catch (error) {
    setConfigFeedback(`保存失败：${error.message}`, "error");
  } finally {
    setButtonsLoading([button], false);
  }
}

function setConfigFeedback(message, type) {
  const el = $("#settings-feedback");
  el.textContent = message;
  el.className = `query-feedback ${type || ""}`.trim();
}

/* ---------- Query history (localStorage) ---------- */
const HISTORY_KEY = "icp-query-history";
const HISTORY_LIMIT = 30;
const SERVICE_NAMES = { 1: "网站", 6: "APP", 7: "小程序", 8: "快应用" };

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function persistHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function historySig(entry) {
  return entry.mode === "single"
    ? `s|${entry.service_type}|${entry.keyword}`
    : `b|${entry.service_type}|${(entry.keywords || []).join("\n")}`;
}

function saveHistory(entry) {
  const list = loadHistory().filter((item) => historySig(item) !== historySig(entry));
  list.unshift({ ...entry, ts: Date.now() });
  persistHistory(list.slice(0, HISTORY_LIMIT));
  if (state.currentView === "history") renderHistory();
  else updateHistoryCount();
}

function updateHistoryCount() {
  const count = loadHistory().length;
  $("#history-count").textContent = count ? `(${count})` : "";
}

function renderHistory() {
  const list = loadHistory();
  updateHistoryCount();
  const bodyEl = $("#history-body");
  const empty = $("#history-empty");
  const panel = $("#history-table-panel");

  if (!list.length) {
    bodyEl.innerHTML = "";
    panel.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  panel.classList.remove("hidden");
  bodyEl.innerHTML = list.map((entry, index) => historyRowHtml(entry, index)).join("");
  $$('#history-body tr[data-idx]').forEach((row) => row.addEventListener("click", () => {
    applyHistory(loadHistory()[Number(row.dataset.idx)]);
  }));
}

function historyRowHtml(entry, index) {
  const isSingle = entry.mode === "single";
  const keywords = entry.keywords || [];
  const label = isSingle
    ? (entry.keyword || "—")
    : `${keywords[0] || "—"}${keywords.length > 1 ? ` 等 ${keywords.length} 条` : ""}`;
  return `<tr data-idx="${index}">
    <td><strong>${escapeHtml(label)}</strong></td>
    <td>${isSingle ? "单条" : "批量"}</td>
    <td>${SERVICE_NAMES[entry.service_type] || "网站"}</td>
    <td class="history-time-cell">${relTime(entry.ts)}</td>
    <td class="history-redo"><span>重查</span><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></td>
  </tr>`;
}

function applyHistory(entry) {
  if (!entry) return;
  if (entry.mode === "single") {
    switchView("query", "single");
    $("#single-keyword").value = entry.keyword || "";
    $("#single-service-type").value = String(entry.service_type || 1);
    const form = $("#query-form");
    if (form.requestSubmit) form.requestSubmit();
    else submitQuery(new Event("submit", { cancelable: true }));
  } else {
    switchView("query", "batch");
    $("#batch-keywords").value = (entry.keywords || []).join("\n");
    $("#batch-service-type").value = String(entry.service_type || 1);
    updateKeywordCount();
  }
}

function relTime(ts) {
  if (!ts) return "";
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

/* ---------- API examples ---------- */
const API_HOST = location.origin;

const API_SNIPPETS = {
  curl: `# 单条查询
curl -X POST ${API_HOST}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{"keyword": "baidu.com", "service_type": 1}'

# 批量查询（自动去重，可设并发）
curl -X POST ${API_HOST}/api/v1/query/batch \\
  -H "Content-Type: application/json" \\
  -d '{"keywords": ["baidu.com", "qq.com"], "service_type": 1, "concurrency": 3}'`,
  python: `import requests

BASE = "${API_HOST}/api/v1"

# 单条查询
r = requests.post(f"{BASE}/query", json={
    "keyword": "baidu.com",
    "service_type": 1,          # 1 网站 6 APP 7 小程序 8 快应用
})
print(r.json())

# 批量查询
r = requests.post(f"{BASE}/query/batch", json={
    "keywords": ["baidu.com", "qq.com"],
    "service_type": 1,
    "concurrency": 3,           # 并发 1-10
})
print(r.json())`,
  js: `const BASE = "${API_HOST}/api/v1";

// 单条查询
const one = await fetch(\`\${BASE}/query\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ keyword: "baidu.com", service_type: 1 }),
});
console.log(await one.json());

// 批量查询
const batch = await fetch(\`\${BASE}/query/batch\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ keywords: ["baidu.com", "qq.com"], service_type: 1, concurrency: 3 }),
});
console.log(await batch.json());`
};

function bindApiExamples() {
  const view = $("#api-code");
  if (!view) return;
  const render = (lang) => { view.textContent = API_SNIPPETS[lang] || ""; };
  $$('[data-lang]').forEach((tab) => tab.addEventListener("click", () => {
    $$('[data-lang]').forEach((item) => {
      const active = item === tab;
      item.classList.toggle("active", active);
      item.setAttribute("aria-selected", String(active));
    });
    render(tab.dataset.lang);
  }));
  render("curl");
}

function bindCopyButtons() {
  $$('.copy-btn[data-copy]').forEach((button) => button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    const text = target.textContent;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      flashCopied(button);
    } catch {
      fallbackCopy(text);
      flashCopied(button);
    }
  }));
}

function fallbackCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try { document.execCommand("copy"); } catch { /* ignore */ }
  document.body.removeChild(area);
}

function flashCopied(button) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = "已复制";
  button.classList.add("copied");
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.textContent = original;
    button.classList.remove("copied");
  }, 1500);
}

function extractError(data) {
  if (typeof data?.detail === "string") return data.detail;
  if (Array.isArray(data?.detail)) return data.detail.map((item) => item.msg).join("；");
  return data?.data?.error || "服务器返回了异常响应";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function shorten(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
