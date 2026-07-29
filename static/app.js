"use strict";

/* =========================================================================
   ICP FILING INTELLIGENCE — 交互层
   ========================================================================= */

const QUERY_ENDPOINT = "/api/v1/query";
const MAX_BATCH_SIZE = 100;
const HISTORY_KEY = "icp-query-history";
const HISTORY_LIMIT = 30;
const SERVICE_NAMES = { 1: "网站", 6: "APP", 7: "小程序", 8: "快应用" };

const VIEW_META = {
  query:    { index: "01", title: "备案查询" },
  history:  { index: "02", title: "查询历史" },
  logs:     { index: "03", title: "运行日志" },
  docs:     { index: "04", title: "接口文档" },
  settings: { index: "05", title: "设置" }
};

const state = {
  view: "query",
  results: [],      // 最近一次查询的 QueryResult 列表
  raw: null,        // 最近一次的原始响应
  filter: "",
  queriedAt: null
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/* =========================================================================
   Lucide 图标（内联，无外部依赖）
   ========================================================================= */
const ICONS = {
  "shield-check": '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  "search": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "history": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  "terminal": '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  "braces": '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  "sliders": '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  "menu": '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  "trash": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  "globe": '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  "smartphone": '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
  "grid": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/><path d="M12 3v18"/>',
  "zap": '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  "corner-down-left": '<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>',
  "check": '<path d="M20 6 9 17l-5-5"/>',
  "x": '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "copy": '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "download": '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  "filter": '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  "eraser": '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  "activity": '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  "alert-triangle": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "wifi": '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  "external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>',
  "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  "circle-x": '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "clock": '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  "server": '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  "refresh": '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  "moon": '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'
};

function iconSvg(name) {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function hydrateIcons(root = document) {
  $$("[data-icon]", root).forEach((el) => {
    if (el.dataset.iconDone) return;
    el.innerHTML = iconSvg(el.dataset.icon);
    el.dataset.iconDone = "1";
  });
}

/* =========================================================================
   启动
   ========================================================================= */
document.addEventListener("DOMContentLoaded", () => {
  hydrateIcons();
  runBoot();
  initLite();
  initTheme();
  initCursor();
  initField();
  initReveal();
  initKinetic();
  initClock();
  initRail();
  initQueryConsole();
  initResultTools();
  initHistory();
  initLogStream();
  initDocs();
  initSettings();
  initMagnets();
  initRipples();
  syncRailIndicator();
});

/* =========================================================================
   轻量模式：关掉粒子场 / 极光 / 噪点三层环境特效
   ========================================================================= */
const LITE_KEY = "icp-lite";
let liteOn = false;

function initLite() {
  // 没选过时按机器判断：核少的默认关特效，省得一上来就卡
  let on = (navigator.hardwareConcurrency || 8) <= 4;
  try {
    const saved = localStorage.getItem(LITE_KEY);
    if (saved !== null) on = saved === "1";
  } catch { /* ignore */ }

  const box = $("#cfg-lite");
  const apply = (value) => {
    const wasLite = liteOn;
    liteOn = value;
    document.body.classList.toggle("is-lite", value);
    if (box) box.checked = value;
    // 轻量模式下 #field 是 display:none，量到的尺寸是 0。关掉时必须重建，
    // 否则 canvas 会一直停在隐藏时建的 0×0 尺寸，特效再也回不来。
    // （读 clientWidth 会强制一次重排，所以此处同步调用拿得到正确尺寸。）
    if (wasLite && !value) rebuildField();
  };
  apply(on);

  box?.addEventListener("change", () => {
    try { localStorage.setItem(LITE_KEY, box.checked ? "1" : "0"); } catch { /* ignore */ }
    apply(box.checked);
    toast(box.checked ? "已开启轻量模式" : "已恢复视觉特效", "info");
  });
}

/* =========================================================================
   主题（默认亮色；选择记在 localStorage，首帧前由 index.html 的内联脚本套用）
   ========================================================================= */
const THEME_KEY = "icp-theme";

function initTheme() {
  const button = $("#theme-toggle");
  if (!button) return;
  const icon = $("[data-icon]", button);

  const apply = (theme) => {
    const dark = theme === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute("aria-label", dark ? "切换浅色模式" : "切换深色模式");
    icon.dataset.icon = dark ? "moon" : "sun";
    icon.innerHTML = iconSvg(icon.dataset.icon);
    $('meta[name="theme-color"]')?.setAttribute("content", dark ? "#06070A" : "#F6F5F2");
    refreshField();   // 点阵基色跟着主题走，否则亮色下白点看不见
  };

  let current = "light";
  try { if (localStorage.getItem(THEME_KEY) === "dark") current = "dark"; } catch { /* ignore */ }
  apply(current);

  button.addEventListener("click", () => {
    current = current === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, current); } catch { /* ignore */ }
    apply(current);
    toast(current === "dark" ? "已切换到深色" : "已切换到浅色", "info");
  });
}

/* =========================================================================
   开场序列
   ========================================================================= */
function runBoot() {
  const boot = $("#boot");
  if (!boot) return;
  const seen = sessionStorage.getItem("icp-boot") === "1";
  if (seen || reduceMotion) { boot.remove(); return; }

  document.body.classList.add("is-booting");
  sessionStorage.setItem("icp-boot", "1");

  const bar = $("#boot-bar");
  const num = $("#boot-num");
  const started = performance.now();
  const total = 980;

  (function step(now) {
    const p = Math.min(1, (now - started) / total);
    const eased = 1 - Math.pow(1 - p, 3);
    bar.style.width = `${(eased * 100).toFixed(1)}%`;
    num.textContent = String(Math.round(eased * 100)).padStart(3, "0");
    if (p < 1) requestAnimationFrame(step);
    else {
      boot.classList.add("is-done");
      setTimeout(() => { boot.remove(); document.body.classList.remove("is-booting"); }, 1100);
    }
  })(started);
}

/* =========================================================================
   自定义光标（弹簧跟随）
   ========================================================================= */
function initCursor() {
  if (!finePointer || reduceMotion) return;
  const wrap = $("#cursor");
  const dot = $("#cursor-dot");
  const ring = $("#cursor-ring");
  if (!wrap) return;

  document.body.classList.add("has-cursor");
  const pos = { x: innerWidth / 2, y: innerHeight / 2 };
  const ringPos = { ...pos };
  const dotPos = { ...pos };
  let raf = 0;

  addEventListener("mousemove", (e) => {
    pos.x = e.clientX;
    pos.y = e.clientY;
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });

  const HOT = 'a, button, input, textarea, select, label, .history-card, .endpoint, [role="tab"]';
  addEventListener("mouseover", (e) => {
    const hot = e.target.closest(HOT);
    const text = e.target.closest("textarea, input[type=text], input[type=number], input[type=search]");
    wrap.classList.toggle("is-hot", Boolean(hot) && !text);
    wrap.classList.toggle("is-text", Boolean(text));
  }, { passive: true });

  function loop() {
    dotPos.x += (pos.x - dotPos.x) * 0.42;
    dotPos.y += (pos.y - dotPos.y) * 0.42;
    ringPos.x += (pos.x - ringPos.x) * 0.14;
    ringPos.y += (pos.y - ringPos.y) * 0.14;
    dot.style.transform = `translate(${dotPos.x}px, ${dotPos.y}px) translate(-50%, -50%)`;
    ring.style.transform = `translate(${ringPos.x}px, ${ringPos.y}px) translate(-50%, -50%)`;
    // 追平指针后停下，等下一次 mousemove 再启动——鼠标不动时不再占用每一帧
    const rest = Math.abs(pos.x - ringPos.x) + Math.abs(pos.y - ringPos.y)
               + Math.abs(pos.x - dotPos.x) + Math.abs(pos.y - dotPos.y);
    raf = rest < 0.3 ? 0 : requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
}

/* =========================================================================
   背景粒子场（点阵 + 指针斥力 + 查询脉冲）
   ========================================================================= */
let pulseField = () => {};
let refreshField = () => {};
let rebuildField = () => {};

function initField() {
  const canvas = $("#field");
  if (!canvas || reduceMotion) { if (canvas) canvas.remove(); return; }

  const ctx = canvas.getContext("2d", { alpha: true });
  // 刻意不用 devicePixelRatio：这层只是 1–3px 的柔和圆点，dpr=2 视觉上看不出差别，
  // 却让后备缓冲从 1920x1080（7.9MB）涨到 3840x2160（31.6MB），
  // 合成器每帧还要再传一份——这是「卡一卡」的主要来源。
  const SPACING = 58;
  const TAU = Math.PI * 2;
  const FRAME_MS = 1000 / 30;
  let dots = [];
  let w = 0, h = 0;
  const pointer = { x: -9999, y: -9999, tx: -9999, ty: -9999 };
  const pulses = [];
  let lastDraw = 0;
  let dirty = true;   // 画面是否需要重绘

  // 冷色点按 alpha 分桶批量绘制。逐点设置 fillStyle 会让浏览器为每个点解析一次
  // 颜色字符串，几百个点/帧时这是最大的单项开销；分桶后每帧只需几次。
  const COOL_STEPS = 24;
  const COOL_Q = 200;   // alpha 量化系数：桶号 = (alpha * COOL_Q) | 0
  let coolFills = [];
  const buckets = Array.from({ length: COOL_STEPS }, () => []);
  const embers = [];

  // 点阵基色取自 CSS 的 --dot-rgb，切主题时重算（亮色下白点在白底上看不见）
  function readDotColor() {
    const rgb = getComputedStyle(document.documentElement)
      .getPropertyValue("--dot-rgb").trim() || "190, 200, 214";
    coolFills = Array.from({ length: COOL_STEPS },
      (_, i) => `rgba(${rgb}, ${((i + 0.5) / COOL_Q).toFixed(4)})`);
  }
  refreshField = () => { readDotColor(); dirty = true; };
  rebuildField = build;
  readDotColor();

  function build() {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w;
    canvas.height = h;
    dots = [];
    const cols = Math.ceil(w / SPACING) + 1;
    const rows = Math.ceil(h / SPACING) + 1;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        // 抖动是按 seed 算的静态值，不随时间变——这样指针不动时每帧完全相同，
        // 才能整帧跳过。之前那个 Math.sin(time) 呼吸效果让每帧都不一样，永远没法跳。
        dots.push({ x: i * SPACING, y: j * SPACING, jitter: ((i * 13 + j * 7) % 100) * 0.01 });
      }
    }
    dirty = true;
  }

  addEventListener("resize", debounce(build, 180));
  addEventListener("mousemove", (e) => {
    pointer.tx = e.clientX;
    pointer.ty = e.clientY;
    dirty = true;
  }, { passive: true });
  addEventListener("mouseleave", () => {
    pointer.tx = -9999;
    pointer.ty = -9999;
    dirty = true;
  }, { passive: true });

  pulseField = (x, y) => {
    pulses.push({ x: x ?? w / 2, y: y ?? h / 2, r: 0 });
    if (pulses.length > 4) pulses.shift();
    dirty = true;
  };

  function frame(now) {
    // 单一循环、先续期：此前在 visibilitychange 里再起一条会导致每次切走再切回
    // 都多出一条并行循环，动画越跑越快、CPU 越吃越多。隐藏时浏览器自会暂停 rAF。
    requestAnimationFrame(frame);
    if (document.hidden || liteOn || now - lastDraw < FRAME_MS) return;

    // 指针缓动还没追平 / 有脉冲在扩散 / 有外部变更，才需要重画。
    // 都没有时整帧跳过——鼠标停住时这层的开销直接归零。
    const settling = Math.abs(pointer.tx - pointer.x) + Math.abs(pointer.ty - pointer.y) > 0.4;
    if (!dirty && !settling && !pulses.length) return;
    dirty = false;
    lastDraw = now;

    pointer.x += (pointer.tx - pointer.x) * 0.18;
    pointer.y += (pointer.ty - pointer.y) * 0.18;
    ctx.clearRect(0, 0, w, h);

    const diag = Math.hypot(w, h);
    for (let i = 0; i < pulses.length; i++) {
      pulses[i].r += 18;   // 帧率减半，步进加倍，脉冲扩散速度不变
      if (pulses[i].r > diag) pulses.splice(i--, 1);
    }

    for (const list of buckets) list.length = 0;
    embers.length = 0;

    for (const d of dots) {
      const dx = d.x - pointer.x;
      const dy = d.y - pointer.y;
      const dist = Math.hypot(dx, dy);
      const near = Math.max(0, 1 - dist / 260);

      let size = 0.9 + d.jitter * 0.5 + near * 2.2;
      let alpha = 0.1 + d.jitter * 0.07 + near * 0.55;

      let px = d.x, py = d.y;
      if (near > 0) {
        const push = near * near * 16;
        px += (dx / (dist || 1)) * push;
        py += (dy / (dist || 1)) * push;
      }

      let ember = near;
      for (const p of pulses) {
        const band = Math.abs(Math.hypot(d.x - p.x, d.y - p.y) - p.r);
        if (band < 60) {
          const k = (1 - band / 60) * Math.max(0, 1 - p.r / diag);
          alpha = Math.min(1, alpha + k * 0.8);
          size += k * 1.8;
          ember = Math.max(ember, k);
        }
      }

      if (ember > 0.04) {
        embers.push(px, py, size, alpha, ember);
      } else {
        const idx = Math.min(COOL_STEPS - 1, (alpha * 0.5 * COOL_Q) | 0);
        buckets[idx].push(px, py, size);
      }
    }

    for (let i = 0; i < COOL_STEPS; i++) {
      const list = buckets[i];
      if (!list.length) continue;
      ctx.fillStyle = coolFills[i];
      ctx.beginPath();
      for (let k = 0; k < list.length; k += 3) {
        const x = list[k], y = list[k + 1], r = list[k + 2];
        ctx.moveTo(x + r, y);   // 不 moveTo 会把上一段圆弧连成一条线
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
    }

    for (let k = 0; k < embers.length; k += 5) {
      const ember = embers[k + 4];
      ctx.fillStyle = `rgba(255, ${Math.round(95 + 60 * (1 - ember))}, ${Math.round(46 + 40 * (1 - ember))}, ${embers[k + 3]})`;
      ctx.beginPath();
      ctx.arc(embers[k], embers[k + 1], embers[k + 2], 0, TAU);
      ctx.fill();
    }
  }

  build();
  requestAnimationFrame(frame);
}

/* =========================================================================
   滚动揭示 / 动态标题
   ========================================================================= */
function initReveal() {
  const items = $$("[data-reveal]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (!entry.isIntersecting) return;
      entry.target.style.setProperty("--rd", `${Math.min(i, 5) * 70}ms`);
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: "0px 0px -8% 0px" });
  items.forEach((el) => io.observe(el));
}

function initKinetic() {
  $$("[data-kinetic]").forEach((el) => {
    const chars = [...el.dataset.kinetic];
    el.innerHTML = chars
      .map((c, i) => `<span class="kc"><i style="--d:${i * 65}ms">${escapeHtml(c)}</i></span>`)
      .join("");
  });

  // 眉题解码动画
  $$("[data-decode]").forEach((el) => {
    const target = el.textContent;
    setTimeout(() => scramble(el, target), 420);
  });
}

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/*";
function scramble(el, target) {
  if (reduceMotion) { el.textContent = target; return; }
  const chars = [...target];
  let frame = 0;
  clearInterval(el._scrambleTimer);
  el._scrambleTimer = setInterval(() => {
    frame++;
    el.textContent = chars
      .map((c, i) => (i < frame / 1.6 ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]))
      .join("");
    if (frame / 1.6 >= chars.length) {
      clearInterval(el._scrambleTimer);
      el.textContent = target;
    }
  }, 34);
}

function initClock() {
  const el = $("#clock");
  if (!el) return;
  const tick = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    el.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

/* =========================================================================
   导航
   ========================================================================= */
function initRail() {
  $$(".rail-item, .rail-brand").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (el.tagName === "A") e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  const toggle = $("#rail-toggle");
  toggle.addEventListener("click", () => {
    const open = $("#shell").classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  $("#rail-scrim").addEventListener("click", closeNav);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeNav(); });
  addEventListener("resize", debounce(syncRailIndicator, 150));

  $("#clear-history").addEventListener("click", () => {
    persistHistory([]);
    renderHistory();
    toast("查询历史已清空", "info");
  });
}

function closeNav() {
  $("#shell").classList.remove("nav-open");
  $("#rail-toggle").setAttribute("aria-expanded", "false");
}

function switchView(view) {
  if (!view || view === state.view) { closeNav(); return; }
  state.view = view;

  $$(".view").forEach((s) => s.classList.toggle("is-active", s.dataset.view === view));
  $$(".rail-item").forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });

  const meta = VIEW_META[view];
  if (meta) {
    $("#view-index").textContent = meta.index;
    scramble($("#view-title"), meta.title);
  }

  $("#clear-history").classList.toggle("hidden", view !== "history");
  if (view === "history") renderHistory();
  if (view === "docs") requestAnimationFrame(syncTabIndicator);

  syncRailIndicator();
  closeNav();
  window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}

function syncRailIndicator() {
  const indicator = $("#rail-indicator");
  const active = $(".rail-item.is-active");
  const nav = $(".rail-nav");
  if (!indicator || !active || !nav) return;
  indicator.style.setProperty("--y", `${active.offsetTop}px`);
  indicator.style.height = `${active.offsetHeight}px`;
}

/* =========================================================================
   查询控制台
   ========================================================================= */
function initQueryConsole() {
  const textarea = $("#keywords");
  const gutter = $("#gutter");
  const range = $("#concurrency");

  // 并发刻度
  const ticks = $(".dial-ticks");
  ticks.innerHTML = Array.from({ length: 10 }, () => "<i></i>").join("");
  const syncDial = () => {
    const value = Number(range.value);
    $("#concurrency-value").textContent = value;
    $$("i", ticks).forEach((tick, i) => tick.classList.toggle("on", i < value));
  };
  range.addEventListener("input", syncDial);
  syncDial();

  // 行号 + 模式识别
  const syncEditor = () => {
    const lines = textarea.value.split("\n");
    gutter.innerHTML = lines
      .map((line, i) => `<span class="${line.trim() ? "on" : ""}">${String(i + 1).padStart(2, "0")}</span>`)
      .join("");
    updateMode();
  };
  textarea.addEventListener("input", syncEditor);
  textarea.addEventListener("scroll", () => { gutter.scrollTop = textarea.scrollTop; }, { passive: true });
  textarea.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      $("#query-form").requestSubmit();
    }
  });
  syncEditor();

  $("#query-form").addEventListener("submit", submitQuery);
}

function updateMode() {
  const keywords = parseKeywords($("#keywords").value);
  const chip = $("#mode-chip");
  const batch = keywords.length > 1;
  const mode = batch ? "batch" : "single";

  $("#keyword-count").textContent = `${keywords.length} / ${MAX_BATCH_SIZE}`;
  $("#concurrency-block").style.opacity = batch ? "1" : ".45";

  if (chip.dataset.mode !== mode) {
    chip.dataset.mode = mode;
    chip.classList.add("bump");
    setTimeout(() => chip.classList.remove("bump"), 420);
  }
  $("#mode-text").textContent = batch ? `批量模式 · ${keywords.length} 条` : "单条模式";
}

function parseKeywords(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function serviceType() {
  return Number($('input[name="service-type"]:checked').value);
}

async function submitQuery(event) {
  event.preventDefault();
  const button = $("#submit-btn");
  const console_ = $(".console");
  const keywords = parseKeywords($("#keywords").value);

  if (!keywords.length) {
    setFeedback("请至少输入一个查询词。", "error");
    toast("请至少输入一个查询词", "bad");
    return;
  }
  if (keywords.length > MAX_BATCH_SIZE) {
    setFeedback(`单次批量查询最多支持 ${MAX_BATCH_SIZE} 条。`, "error");
    toast(`最多支持 ${MAX_BATCH_SIZE} 条`, "bad");
    return;
  }

  const isBatch = keywords.length > 1;
  const type = serviceType();
  const concurrency = Number($("#concurrency").value);
  const payload = isBatch
    ? { keywords, service_type: type, concurrency }
    : { keyword: keywords[0], service_type: type };

  button.disabled = true;
  button.classList.add("is-loading");
  console_.classList.add("is-busy");
  $("#submit-text").textContent = "查询中";
  setFeedback(
    isBatch ? `正在以 ${concurrency} 个并发查询 ${keywords.length} 条数据…` : "正在连接工信部备案系统，请稍候…",
    "loading"
  );

  const rect = button.getBoundingClientRect();
  pulseField(rect.left + rect.width / 2, rect.top + rect.height / 2);

  try {
    const response = await fetch(QUERY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok && !data.data) throw new Error(extractError(data));

    state.raw = data;
    state.queriedAt = new Date();
    state.filter = "";
    $("#result-filter").value = "";
    state.results = isBatch ? (data.results || []) : [data.data];

    renderResults();
    renderStats(isBatch ? data : { elapsed_ms: data.data?.elapsed_ms });

    const failed = isBatch ? data.failed > 0 : !data.data?.success;
    setFeedback(failed ? "查询已完成，部分请求未成功。" : "查询完成。", failed ? "error" : "success");
    toast(failed ? "查询完成，存在失败项" : "查询完成", failed ? "bad" : "ok");

    keywords.forEach((keyword) => saveHistory({ keyword, service_type: type }));
  } catch (error) {
    setFeedback(`请求失败：${error.message}`, "error");
    toast(`请求失败：${shorten(error.message, 40)}`, "bad");
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
    console_.classList.remove("is-busy");
    $("#submit-text").textContent = "立即查询";
  }
}

/* =========================================================================
   结果渲染
   ========================================================================= */
function flatRows() {
  const rows = [];
  state.results.forEach((result) => {
    if (!result?.success) {
      rows.push({ result, record: null, status: "error", text: result?.error || "上游服务请求失败" });
      return;
    }
    const records = Array.isArray(result.records) ? result.records : [];
    if (!result.found || !records.length) {
      rows.push({ result, record: null, status: "empty", text: "未查询到备案信息" });
      return;
    }
    records.forEach((record) => rows.push({ result, record, status: "ok", text: "已备案" }));
  });
  return rows;
}

function renderResults() {
  const panel = $("#result-panel");
  const body = $("#result-body");
  const all = flatRows();
  const needle = state.filter.trim().toLowerCase();
  const rows = needle
    ? all.filter((row) => rowText(row).toLowerCase().includes(needle))
    : all;

  body.innerHTML = rows.length
    ? rows.map((row, i) => rowHtml(row, i)).join("")
    : '<tr><td colspan="8" class="empty-cell">没有匹配的结果</td></tr>';

  const time = state.queriedAt
    ? state.queriedAt.toLocaleTimeString("zh-CN", { hour12: false })
    : "";
  $("#result-foot").textContent = `显示 ${rows.length} / ${all.length} 行${time ? ` · 查询于 ${time}` : ""}`;
  panel.classList.remove("hidden");
  panel.classList.add("in");
}

function rowText(row) {
  const r = row.record || {};
  return [row.result?.keyword, r.domain, r.unitName, r.nature, r.serviceLicence, r.mainLicence, row.text]
    .filter(Boolean).join(" ");
}

function rowHtml(row, index) {
  const { result, record, status, text } = row;
  const licence = record ? (record.serviceLicence || record.mainLicence || "—") : "—";
  const detail = record
    ? escapeHtml(record.domain || "—")
    : `<span title="${escapeHtml(text)}">${escapeHtml(shorten(text, 34))}</span>`;
  return `<tr class="row-in" style="--d:${Math.min(index, 18) * 32}ms">
    <td><strong>${escapeHtml(result?.keyword || "—")}</strong></td>
    <td><span class="status-tag ${status}">${escapeHtml(status === "error" ? "失败" : text)}</span></td>
    <td>${detail}</td>
    <td>${record ? escapeHtml(record.unitName || "—") : "—"}</td>
    <td>${record ? escapeHtml(record.nature || "—") : "—"}</td>
    <td class="licence">${escapeHtml(licence)}</td>
    <td class="num">${record ? escapeHtml(record.updateTime || "—") : "—"}</td>
    <td class="num ta-r">${Number.isFinite(result?.elapsed_ms) ? `${result.elapsed_ms}ms` : "—"}</td>
  </tr>`;
}

function renderStats(meta = {}) {
  const stats = $("#stats");
  let found = 0, records = 0;
  state.results.forEach((result) => {
    const list = Array.isArray(result?.records) ? result.records : [];
    if (result?.success && result.found && list.length) { found++; records += list.length; }
  });
  const values = [state.results.length, found, records, meta.elapsed_ms ?? 0];
  stats.classList.remove("hidden");
  stats.classList.add("in");
  $$("strong", stats).forEach((el, i) => countUp(el, values[i]));
}

function countUp(el, target) {
  const from = Number(el.dataset.count || 0);
  el.dataset.count = String(target);
  if (reduceMotion || from === target) { el.textContent = String(target); return; }
  const duration = 720;
  const started = performance.now();
  cancelAnimationFrame(el._countRaf);
  const step = (now) => {
    const p = Math.min(1, (now - started) / duration);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = String(Math.round(from + (target - from) * eased));
    if (p < 1) el._countRaf = requestAnimationFrame(step);
  };
  el._countRaf = requestAnimationFrame(step);
}

function initResultTools() {
  $("#result-filter").addEventListener("input", debounce((e) => {
    state.filter = e.target.value;
    renderResults();
  }, 140));

  $("#export-csv").addEventListener("click", () => {
    const rows = flatRows();
    if (!rows.length) return toast("暂无可导出的结果", "bad");
    const head = ["查询词", "状态", "域名/说明", "主办单位", "单位性质", "备案号", "审核时间", "耗时(ms)"];
    const lines = [head, ...rows.map((row) => {
      const r = row.record || {};
      return [
        row.result?.keyword || "",
        row.status === "error" ? "失败" : row.text,
        r.domain || (row.record ? "" : row.text),
        r.unitName || "",
        r.nature || "",
        r.serviceLicence || r.mainLicence || "",
        r.updateTime || "",
        Number.isFinite(row.result?.elapsed_ms) ? row.result.elapsed_ms : ""
      ];
    })].map((cells) => cells.map(csvCell).join(",")).join("\r\n");

    download(`icp-query-${stamp()}.csv`, "﻿" + lines, "text/csv;charset=utf-8");
    toast("CSV 已导出", "ok");
  });

  $("#copy-json").addEventListener("click", async () => {
    if (!state.raw) return toast("暂无可复制的数据", "bad");
    await copyText(JSON.stringify(state.raw, null, 2));
    toast("JSON 已复制到剪贴板", "ok");
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* =========================================================================
   查询历史
   ========================================================================= */
function initHistory() { renderHistory(); }

function loadHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function persistHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function saveHistory(entry) {
  const sig = (item) => `${item.service_type}|${item.keyword}`;
  const list = loadHistory().filter((item) => sig(item) !== sig(entry));
  list.unshift({ ...entry, mode: "single", ts: Date.now() });
  persistHistory(list.slice(0, HISTORY_LIMIT));
  if (state.view === "history") renderHistory();
  else updateHistoryCount();
}

function updateHistoryCount() {
  const count = loadHistory().length;
  $("#history-count").textContent = count ? String(count) : "";
}

function renderHistory() {
  const list = loadHistory();
  const grid = $("#history-grid");
  const empty = $("#history-empty");
  updateHistoryCount();

  if (!list.length) {
    grid.innerHTML = "";
    grid.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  grid.classList.remove("hidden");
  grid.innerHTML = list.map((entry, i) => `
    <button class="history-card" type="button" data-idx="${i}" style="--d:${Math.min(i, 12) * 45}ms">
      <span class="history-top">
        <span class="history-type">${escapeHtml(SERVICE_NAMES[entry.service_type] || "网站")}</span>
        <span class="history-time">${relTime(entry.ts)}</span>
      </span>
      <span class="history-key">${escapeHtml(entry.keyword || "—")}</span>
      <span class="history-go">重新查询 ${iconSvg("arrow-right")}</span>
    </button>`).join("");

  $$(".history-card", grid).forEach((card) => {
    card.addEventListener("click", () => applyHistory(loadHistory()[Number(card.dataset.idx)]));
    if (finePointer) {
      let rect = null, raf = 0, mx = 0, my = 0;
      card.addEventListener("mouseenter", () => { rect = card.getBoundingClientRect(); }, { passive: true });
      card.addEventListener("mouseleave", () => { rect = null; }, { passive: true });
      card.addEventListener("mousemove", (e) => {
        if (!rect) rect = card.getBoundingClientRect();
        mx = e.clientX;
        my = e.clientY;
        if (raf) return;   // 同 initMagnets：避免每次 mousemove 触发同步重排
        raf = requestAnimationFrame(() => {
          raf = 0;
          card.style.setProperty("--mx", `${mx - rect.left}px`);
          card.style.setProperty("--my", `${my - rect.top}px`);
        });
      }, { passive: true });
    }
  });
}

function applyHistory(entry) {
  if (!entry) return;
  switchView("query");
  $("#keywords").value = entry.keyword || "";
  const radio = $(`input[name="service-type"][value="${entry.service_type || 1}"]`);
  if (radio) radio.checked = true;
  $("#keywords").dispatchEvent(new Event("input"));
  setTimeout(() => $("#query-form").requestSubmit(), 240);
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

/* =========================================================================
   运行日志（SSE）
   ========================================================================= */
function initLogStream() {
  const body = $("#log-body");
  const empty = $("#log-empty");
  const status = $("#log-status");
  const chip = $("#stream-chip");
  const chipText = $("#stream-text");
  const dot = $("#log-live-dot");
  const verbose = $("#log-verbose");
  const autoscroll = $("#log-autoscroll");
  const filterInput = $("#log-filter");
  const MAX_LINES = 600;   // 600 行约 3000 个 DOM 节点；原来的 2000 行会常驻 1 万个
  const seen = new Set();
  let needle = "";

  const atTop = () => body.scrollTop < 40;
  const toTop = () => { body.scrollTop = 0; };

  verbose.addEventListener("change", () => {
    body.classList.toggle("show-debug", verbose.checked);
    if (autoscroll.checked) toTop();
  });

  filterInput.addEventListener("input", debounce(() => {
    needle = filterInput.value.trim().toLowerCase();
    $$(".log-line", body).forEach((line) => {
      line.classList.toggle("filtered", Boolean(needle) && !line.dataset.text.includes(needle));
    });
  }, 130));

  $("#log-clear").addEventListener("click", () => {
    $$(".log-line", body).forEach((line) => line.remove());
    empty.classList.remove("hidden");
    seen.clear();
  });

  function append(item) {
    if (!item || !item.id || seen.has(item.id)) return;
    seen.add(item.id);
    if (seen.size > 1200) [...seen].slice(0, 600).forEach((id) => seen.delete(id));

    empty.classList.add("hidden");
    const follow = autoscroll.checked && atTop();
    const line = document.createElement("div");
    const text = `${item.level} ${item.logger} ${item.msg}`.toLowerCase();
    line.className = `log-line lv-${item.level}`;
    line.dataset.text = text;
    if (needle && !text.includes(needle)) line.classList.add("filtered");
    line.innerHTML =
      `<span class="log-time">${fmtLogTime(item.ts)}</span>` +
      `<span class="log-badge">${escapeHtml(item.level)}</span>` +
      `<span class="log-name" title="${escapeHtml(item.logger)}">${escapeHtml(shortLogger(item.logger))}</span>` +
      `<span class="log-msg">${escapeHtml(item.msg)}</span>`;

    body.insertBefore(line, body.firstChild);
    if (follow) toTop();
    else body.scrollTop += line.offsetHeight;

    const lines = body.querySelectorAll(".log-line");
    if (lines.length > MAX_LINES) {
      for (let i = MAX_LINES; i < lines.length; i++) lines[i].remove();
    }
  }

  function setStatus(name, text) {
    status.dataset.state = name;
    status.querySelector("span").textContent = text;
    chip.dataset.state = name;
    chipText.textContent = name === "open" ? "实时连接" : name === "error" ? "连接断开" : "连接中";
    dot.classList.toggle("live", name === "open");
  }

  try {
    const source = new EventSource("/api/v1/logs/stream");
    source.onopen = () => setStatus("open", "已连接");
    source.onmessage = (event) => {
      try { append(JSON.parse(event.data)); } catch { /* 忽略心跳/坏帧 */ }
    };
    source.onerror = () => setStatus("error", "连接断开，自动重连…");  // EventSource 自动重连
  } catch {
    setStatus("error", "无法连接");
  }
}

function fmtLogTime(ts) {
  const date = new Date((ts || 0) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function shortLogger(name) {
  const text = String(name || "");
  return text.length > 15 ? `…${text.slice(-14)}` : text;
}

/* =========================================================================
   接口文档
   ========================================================================= */
const API_HOST = location.origin;

const API_SNIPPETS = {
  curl: `# 统一查询接口（推荐）- 单条查询
curl -X POST ${API_HOST}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{"keyword": "baidu.com", "service_type": 1}'

# 统一查询接口（推荐）- 批量查询
curl -X POST ${API_HOST}/api/v1/query \\
  -H "Content-Type: application/json" \\
  -d '{"keywords": ["baidu.com", "qq.com"], "service_type": 1, "concurrency": 3}'`,
  python: `import requests

BASE = "${API_HOST}/api/v1"

# 统一查询接口（推荐）- 单条查询
r = requests.post(f"{BASE}/query", json={
    "keyword": "baidu.com",
    "service_type": 1,          # 1 网站 6 APP 7 小程序 8 快应用
})
print(r.json())

# 统一查询接口（推荐）- 批量查询
r = requests.post(f"{BASE}/query", json={
    "keywords": ["baidu.com", "qq.com"],
    "service_type": 1,
    "concurrency": 3,           # 并发 1-10
})
print(r.json())`,
  js: `const BASE = "${API_HOST}/api/v1";

// 统一查询接口（推荐）- 单条查询
const one = await fetch(\`\${BASE}/query\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ keyword: "baidu.com", service_type: 1 }),
});
console.log(await one.json());

// 统一查询接口（推荐）- 批量查询
const batch = await fetch(\`\${BASE}/query\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ keywords: ["baidu.com", "qq.com"], service_type: 1, concurrency: 3 }),
});
console.log(await batch.json());`
};

function initDocs() {
  const view = $("#api-code");
  if (view) {
    const render = (lang) => { view.textContent = API_SNIPPETS[lang] || ""; };
    $$(".code-tab").forEach((tab) => tab.addEventListener("click", () => {
      $$(".code-tab").forEach((item) => {
        const active = item === tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", String(active));
      });
      render(tab.dataset.lang);
      syncTabIndicator();
    }));
    render("curl");
  }

  $$(".copy-btn[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    await copyText(target.textContent);
    const label = $("span", button);
    const original = label.textContent;
    label.textContent = "已复制";
    clearTimeout(button._timer);
    button._timer = setTimeout(() => { label.textContent = original; }, 1500);
    toast("已复制到剪贴板", "ok");
  }));

  addEventListener("resize", debounce(syncTabIndicator, 150));
}

function syncTabIndicator() {
  const indicator = $("#tab-indicator");
  const active = $(".code-tab.is-active");
  if (!indicator || !active || !active.offsetWidth) return;
  indicator.style.setProperty("--x", `${active.offsetLeft}px`);
  indicator.style.setProperty("--w", `${active.offsetWidth}px`);
}

/* =========================================================================
   设置
   ========================================================================= */
function initSettings() {
  const form = $("#settings-form");
  if (!form) return;
  loadConfig();
  form.addEventListener("submit", saveConfig);
  $("#test-proxy").addEventListener("click", testProxy);
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
  const chips = [
    chipHtml(status.enabled ? "server" : "wifi", status.enabled ? "代理已启用" : "直连（未启用代理）"),
    chipHtml("globe", `当前 ${escapeHtml(status.current || "直连")}`),
    chipHtml("refresh", `切换 ${status.rotations || 0} 次`)
  ];
  if (status.blacklisted?.length) {
    chips.push(chipHtml("alert-triangle", `黑名单 ${status.blacklisted.length}`, "bad"));
  }
  el.innerHTML = chips.join("");
}

function chipHtml(icon, text, tone = "") {
  return `<span class="chip ${tone}">${iconSvg(icon)}<span>${text}</span></span>`;
}

// 数字项留空或填了非法值时返回 undefined —— JSON.stringify 会丢掉该字段，后端
// 按“仅更新提供的项”保持原值。否则 Number("") === 0 会静默把节流间隔、黑名单
// 有效期归零（等于关掉限流与黑名单），而重试次数、黑名单阈值则会撞上 ge=1 校验。
function numField(selector) {
  const raw = $(selector).value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

async function saveConfig(event) {
  event.preventDefault();
  const button = $('#settings-form button[type="submit"]');
  const payload = {
    proxies: $("#cfg-proxies").value,
    api_url: $("#cfg-api").value.trim(),
    auth: $("#cfg-auth").value.trim(),
    min_interval: numField("#cfg-interval"),
    max_retries: numField("#cfg-retries"),
    api_ttl: numField("#cfg-ttl"),
    blacklist_threshold: numField("#cfg-blacklist-threshold"),
    blacklist_duration: numField("#cfg-blacklist-duration")
  };
  button.disabled = true;
  button.classList.add("is-loading");
  setConfigFeedback("正在保存…", "loading");
  try {
    const res = await fetch("/api/v1/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data ? extractError(data) : `HTTP ${res.status}`);
    fillConfig(data);
    setConfigFeedback("已保存，立即生效。", "success");
    toast("配置已保存并生效", "ok");
  } catch (error) {
    setConfigFeedback(`保存失败：${error.message}`, "error");
    toast(`保存失败：${shorten(error.message, 40)}`, "bad");
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

async function testProxy() {
  const button = $("#test-proxy");
  const el = $("#test-result");
  button.disabled = true;
  el.innerHTML = chipHtml("clock", "测试中…（使用当前运行配置，动态 API 会实时提取）");
  try {
    const res = await fetch("/api/v1/config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})  // 空对象：测试当前运行配置
    });
    const data = await res.json();
    if (data.ok) {
      el.innerHTML = [
        chipHtml("circle-check", "连通", "ok"),
        chipHtml("globe", `出口 IP ${escapeHtml(data.exit_ip || "?")}`),
        chipHtml("server", `代理 ${escapeHtml(data.proxy || "直连")}`),
        chipHtml("clock", `${data.elapsed_ms} ms`)
      ].join("");
      toast("代理连通", "ok");
    } else {
      el.innerHTML = chipHtml("circle-x", escapeHtml(shorten(data.error || "未知错误", 90)), "bad");
      toast("代理测试失败", "bad");
    }
  } catch (error) {
    el.innerHTML = chipHtml("circle-x", `请求失败：${escapeHtml(error.message)}`, "bad");
    toast("代理测试请求失败", "bad");
  } finally {
    button.disabled = false;
  }
}

function setConfigFeedback(message, type) {
  const el = $("#settings-feedback");
  el.textContent = message;
  el.className = `feedback inline ${type || ""}`.trim();
}

/* =========================================================================
   微交互：磁性按钮 / 涟漪
   ========================================================================= */
function initMagnets() {
  if (!finePointer || reduceMotion) return;
  $$(".btn-magnet").forEach((el) => {
    let rect = null, raf = 0, mx = 0, my = 0;
    // rect 只在进入时取一次：在 mousemove 里调 getBoundingClientRect 会强制同步
    // 重排，而且读到的是已被 transform 位移后的盒子，会自我反馈。
    el.addEventListener("mouseenter", () => { rect = el.getBoundingClientRect(); }, { passive: true });
    el.addEventListener("mousemove", (e) => {
      if (!rect) rect = el.getBoundingClientRect();
      mx = e.clientX;
      my = e.clientY;
      if (raf) return;   // 每帧最多写一次 transform
      raf = requestAnimationFrame(() => {
        raf = 0;
        const dx = mx - (rect.left + rect.width / 2);
        const dy = my - (rect.top + rect.height / 2);
        el.style.transform = `translate(${dx * 0.16}px, ${dy * 0.28}px)`;
      });
    }, { passive: true });
    el.addEventListener("mouseleave", () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      rect = null;
      el.style.transform = "";
    }, { passive: true });
  });
}

function initRipples() {
  document.addEventListener("pointerdown", (e) => {
    const button = e.target.closest(".btn");
    if (!button || reduceMotion) return;
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    button.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  });
}

/* =========================================================================
   Toast
   ========================================================================= */
function toast(message, tone = "info") {
  const stack = $("#toasts");
  if (!stack) return;
  const icon = tone === "ok" ? "circle-check" : tone === "bad" ? "circle-x" : "info";
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.innerHTML = `${iconSvg(icon)}<span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 400);
  }, 3200);
  while (stack.children.length > 4) stack.firstElementChild.remove();
}

/* =========================================================================
   工具
   ========================================================================= */
function setFeedback(message, type = "") {
  const el = $("#query-feedback");
  el.textContent = message;
  el.className = `feedback ${type}`.trim();
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text);
  } catch { /* 回退 */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0;";
  document.body.appendChild(area);
  area.select();
  try { document.execCommand("copy"); } catch { /* ignore */ }
  area.remove();
}

function extractError(data) {
  if (typeof data?.detail === "string") return data.detail;
  if (Array.isArray(data?.detail)) return data.detail.map(detailLine).join("；");
  return data?.data?.error || "服务器返回了异常响应";
}

// FastAPI 422 的 detail 项形如 { loc: ["body", "max_retries"], msg: "..." }，
// 带上字段名才知道是哪一项没通过校验。
function detailLine(item) {
  const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : "";
  return field ? `${field}：${item.msg}` : String(item?.msg ?? "");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function shorten(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
