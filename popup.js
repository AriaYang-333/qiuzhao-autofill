// popup.js — 单页长页面：简历PDF → 详细文档 → 档案 → 作品集 → 反馈
// 支持多份简历（最多3份，可改名/复制）、学历合并到教育经历、作品集自动带入、反馈静默提交（不动用户东西）。

const PLUGIN_VERSION = "0.7.0";

const $ = (id) => document.getElementById(id);
let currentProfile = null;

// 全局错误捕获：任何运行时错误都显示到「问题反馈」区的状态栏，方便定位
window.addEventListener("error", (ev) => {
  try {
    const el = document.getElementById("feedbackStatus");
    if (el) el.textContent = "运行时出错：" + (ev.message || "未知错误") + "（" + String(ev.filename || "").split("/").pop() + ":" + ev.lineno + "）";
  } catch (e) {}
});
window.addEventListener("unhandledrejection", (ev) => {
  try {
    const el = document.getElementById("feedbackStatus");
    if (el) el.textContent = "异步出错：" + ((ev.reason && ev.reason.message) || String(ev.reason || "未知错误"));
  } catch (e) {}
});

// 开发者模式闸门：调试区（.dev-only / #section-debug）只对开发者可见。
// 判定方式（任一满足即为开发者）：
//   ① file:// 直接打开预览（开发时常用）
//   ② localhost 本地托管
//   ③ URL 带 ?dev=1（如 chrome-extension://<id>/popup.html?dev=1）
//   ④ localStorage.rfa_dev === '1'（在弹窗里按 F12 控制台执行 localStorage.rfa_dev='1' 即可常开）
// 普通用户（已安装的扩展、不带参数）→ body 无 .dev → 调试区被 CSS 隐藏。
function applyDevGate() {
  try {
    const isDev =
      /^file:\/\//.test(location.protocol) ||
      location.hostname === "localhost" || location.hostname.startsWith("127.") ||
      /[?&]dev=1\b/.test(location.search) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("rfa_dev") === "1");
    document.body.classList.toggle("dev", !!isDev);
  } catch (e) {}
}
applyDevGate();

const DATA_TOKEN = "resume-autofill-2026"; // 与 data/apps-script 里的 APP_TOKEN 保持一致，防止他人乱发数据
// v0.8.13（08-21）：匿名使用统计改发【我们自己的后端】/api/analytics（国内可直连；原 Google 表格 script.google.com 被墙，
// 真实用户收不到数据，弃用）。保留 opts.dataEndpoint 可自定义覆盖。
const DATA_ENDPOINT = "https://get-offer-web-9g31.onrender.com/api/analytics";
const UPDATE_INFO_URL = ""; // 可选：放 version.json 的公开 HTTPS 地址（如 GitHub Pages），用于顶部"!"更新提示

// 生成一个随机、匿名、仅本机存储的安装ID，用于统计"独立用户数"（绝不关联任何人）
function getInstallId() {
  return new Promise(async (resolve) => {
    const r = await getStorage("installId");
    if (r.installId) return resolve(r.installId);
    let id = "i_" + Math.random().toString(36).slice(2, 10);
    try { id = "i_" + crypto.randomUUID().slice(0, 12); } catch (e) {}
    await setStorage({ installId: id });
    resolve(id);
  });
}

// 匿名使用数据上报（写简历用）：仅当开启且配置了接收地址才发；绝不含个人信息
// v0.8.13（08-21）：切到我们后端 /api/analytics（聚合格式 {date, events}）——
//   open/parse 等事件 → dau（活跃设备，每设备每天一次，storage 节流）；autofill → fill_count（每次 +1）。
async function reportUsage(event, extra = {}) {
  try {
    const opts = (await getStorage("options")).options || {};
    if (!opts.shareData) return;
    const installId = await getInstallId();
    const today = new Date().toISOString().slice(0, 10);
    const events = {};
    if (event === "autofill") { events.fill_count = 1; }
    else { events.dau = 1; }
    // dau 节流：同一天同一设备只上报一次活跃（近似独立设备数）
    if (events.dau) {
      const st = await getStorage("rfa_an_date");
      if (st.rfa_an_date === today) return;
      await setStorage({ rfa_an_date: today });
    }
    const payload = {
      date: today,
      events,
      ver: PLUGIN_VERSION,
      install_id: installId, // 后端按日聚合不落库，仅审计口径备用
    };
    await fetch(opts.dataEndpoint || DATA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {}
}

// 检查是否有新版本（若配置了 version.json 地址），有则在顶部显示"!"提示
async function checkForUpdate() {
  if (!UPDATE_INFO_URL) return;
  try {
    const res = await fetch(UPDATE_INFO_URL, { cache: "no-store" });
    if (!res.ok) return;
    const info = await res.json();
    if (!info || !info.version) return;
    const parse = (s) => String(s).split(".").map((n) => parseInt(n, 10) || 0);
    const [a, b, c] = parse(PLUGIN_VERSION);
    const [x, y, z] = parse(info.version);
    const newer = x > a || (x === a && (y > b || (y === b && z > c)));
    if (!newer) return;
    const dismissed = (await getStorage("updateDismissed")).updateDismissed;
    if (dismissed === info.version) return;
    $("updateVersion").textContent = info.version;
    $("updateNotes").textContent = info.notes || "（点击查看更新内容）";
    $("updateBanner").hidden = false;
  } catch (e) {}
}

// 打开弹窗时上报一次"使用"事件（每天最多一次，避免刷数据）
async function maybeReportOpen() {
  const r = await getStorage("lastOpenPing");
  const today = new Date().toISOString().slice(0, 10);
  if (r.lastOpenPing === today) return;
  await setStorage({ lastOpenPing: today });
  reportUsage("open");
}

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.js");
}

// ---------- storage 小工具 ----------
function getStorage(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
}
function setStorage(obj) {
  return new Promise((r) => chrome.storage.local.set(obj, r));
}
function removeStorage(keys) {
  return new Promise((r) => chrome.storage.local.remove(keys, r));
}

// ---------- 一键清空 4 档（逻辑核心见 clear_data.js，这里注入真实浏览器原语）----------
function rfaClearDeps() {
  return {
    storage: {
      get: (keys) => getStorage(keys),
      set: (obj) => setStorage(obj),
      remove: (keys) => removeStorage(keys),
    },
    sendToPage: (msg, payload, cb) => sendToPage(msg, payload, cb),
    deleteFragmentedFile: (key) => deleteFragmentedFile(key),
    getActiveProfileId: () => getStorage("activeProfileId").then((r) => r.activeProfileId),
  };
}

// ---------- 大文件分片存储（绕过 chrome.tabs.sendMessage 64MB 限制） ----------
// 说明：content script 与 popup 共享 chrome.storage.local，因此把 base64 拆成多片存
// 储，消息里只传 storageKey。content.js 需要上传时再把分片读出来合并。
const FRAGMENT_SIZE = 4 * 1024 * 1024; // 每片 4MB，留足余量
const FILE_KEY_PREFIX = "rfa_file_";

function fileFragmentKeys(storageKey, fragmentCount) {
  const keys = [storageKey];
  for (let i = 0; i < fragmentCount; i++) keys.push(`${storageKey}_part${i}`);
  return keys;
}

async function saveFragmentedFile(storageKey, fileObj) {
  // 手动模式/无 base64：只存元数据
  if (fileObj.manual || !fileObj.base64) {
    await setStorage({ [storageKey]: { name: fileObj.name, size: fileObj.size, manual: true } });
    return true;
  }
  const base64 = fileObj.base64;
  const fragments = [];
  for (let i = 0; i < base64.length; i += FRAGMENT_SIZE) {
    fragments.push(base64.slice(i, i + FRAGMENT_SIZE));
  }
  const batch = {};
  batch[storageKey] = { name: fileObj.name, size: fileObj.size, manual: false, fragments: fragments.length };
  fragments.forEach((part, idx) => {
    batch[`${storageKey}_part${idx}`] = part;
  });
  await setStorage(batch);
  return true;
}

async function loadFragmentedFile(storageKey) {
  const metaRes = await getStorage(storageKey);
  const meta = metaRes[storageKey];
  if (!meta) return null;
  // 兼容旧格式：直接把 base64 存在 storageKey 里
  if (meta.base64) return Object.assign({}, meta);
  const fragmentCount = meta.fragments || 0;
  if (!fragmentCount) return Object.assign({}, meta);
  const parts = await getStorage(fileFragmentKeys(storageKey, fragmentCount));
  const arr = [];
  for (let i = 0; i < fragmentCount; i++) {
    arr.push(parts[`${storageKey}_part${i}`] || "");
  }
  return Object.assign({}, meta, { base64: arr.join("") });
}

async function deleteFragmentedFile(storageKey) {
  if (!storageKey) return;
  const metaRes = await getStorage(storageKey);
  const meta = metaRes[storageKey];
  const keys = [storageKey];
  if (meta && meta.fragments) {
    for (let i = 0; i < meta.fragments; i++) keys.push(`${storageKey}_part${i}`);
  }
  await new Promise((r) => chrome.storage.local.remove(keys, r));
}

function getFileStorageKey(cat) {
  return `${FILE_KEY_PREFIX}${cat}`;
}
function getWorkFileStorageKey(idx, type) {
  return `${FILE_KEY_PREFIX}work_${idx}_${type}`;
}

// 把 fileVault/works 里旧格式（直接带 base64）迁移到分片存储，避免 sendMessage 报 64MB 错。
// 迁移是幂等的：已经带 storageKey 的跳过。
async function migrateLegacyFiles() {
  const r = await getStorage(["fileVault", "works"]);
  let changed = false;

  // 迁移简历文件
  const vault = r.fileVault || {};
  for (const cat of Object.keys(vault)) {
    const v = vault[cat];
    if (!v || v.storageKey || v.manual || !v.base64) continue;
    const key = getFileStorageKey(cat);
    try {
      await saveFragmentedFile(key, v);
      vault[cat] = { name: v.name, size: v.size, manual: false, storageKey: key };
      changed = true;
    } catch (e) {
      console.error("migrate vault", cat, e);
    }
  }

  // 迁移作品文件（按当前索引位置生成 key；迁移后不再变动，后续用户重新选文件会覆盖）
  const works = r.works || [];
  for (let i = 0; i < works.length; i++) {
    const w = works[i];
    if (!w) continue;
    // 旧版：video/pdf 各自存 base64 → 先迁成分片存储
    for (const type of ["video", "pdf"]) {
      const f = w[type];
      if (!f || f.storageKey || f.manual || !f.base64) continue;
      const key = getWorkFileStorageKey(i, type);
      try {
        await saveFragmentedFile(key, f);
        w[type] = { name: f.name, size: f.size, manual: false, storageKey: key };
        changed = true;
      } catch (e) {
        console.error("migrate work", i, type, e);
      }
    }
    // 旧版：video 与 pdf 两个槽 → 合并为单个「附件」槽（优先保留视频，多余的 PDF 分片清理）
    if (w.video !== undefined || w.pdf !== undefined) {
      const chosen = w.video || w.pdf || null;
      if (w.video && w.pdf && w.pdf.storageKey) {
        // 两个都有：保留视频、删掉 PDF 分片，避免孤儿数据
        try { await deleteFragmentedFile(w.pdf.storageKey); } catch (e) {}
      }
      delete w.video;
      delete w.pdf;
      w.attachment = chosen;
      changed = true;
    }
  }

  if (changed) {
    await setStorage({ fileVault: vault, works });
  }
  return changed;
}

function queryTabs() {
  return new Promise((resolve) => {
    // 独立窗口模式下，currentWindow 是扩展自己的窗口（没有普通网页标签页），
    // 需要退回到「所有窗口的活动标签页」里找用户正在浏览的招聘页。
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const t = tabs && tabs[0];
      if (t && isWebTab(t)) return resolve([t]);
      chrome.tabs.query({ active: true }, (all) => {
        const candidates = (all || []).filter(isWebTab);
        candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        resolve(candidates.length ? [candidates[0]] : []);
      });
    });
  });
}
function isWebTab(t) {
  if (!t || !t.url) return false;
  return !/^(chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:|devtools:)/.test(t.url);
}
// 向当前招聘网页的内容脚本发消息（wrapper，统一处理找不到标签页 / lastError）
function sendToPage(action, payload, cb) {
  queryTabs().then((tabs) => {
    if (!tabs[0]) return cb && cb(false, "找不到当前招聘标签页");
    chrome.tabs.sendMessage(tabs[0].id, Object.assign({ action }, payload || {}), (res) => {
      if (chrome.runtime.lastError) return cb && cb(false, chrome.runtime.lastError.message || "内容脚本未就绪");
      cb && cb(true, res);
    });
  });
}
function genId() {
  return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

document.addEventListener("DOMContentLoaded", async () => {
  // 先把旧格式（直接存 base64）的大文件迁移到分片存储，避免后续 sendMessage 超过 64MB
  await migrateLegacyFiles();

  const r = await getStorage([
    "profiles", "activeProfileId", "fileVault", "works",
    "options",
  ]);
  await refreshProfileSelect();
  const profiles = r.profiles || [];
  const active = profiles.find((p) => p.id === r.activeProfileId);
  if (active && active.data) {
    currentProfile = active.data;
    renderEditor(active.data);
  } else {
    clearEditor();
  }
  // 关键修复：作品集面板之前只渲染独立的 works 存储键，而网页「同步到插件」写入的是
  // profile.portfolio，两者脱节 → 同步后面板仍空白。现在：同步进来的 profile.portfolio 优先显示，
  // 否则才用本地手动维护的 works 兜底，确保「网页改了插件就同步」。
  const fromProfile = buildWorksFromProfile(active && active.data);
  const initialWorks = (fromProfile && fromProfile.length) ? fromProfile : (r.works || []);
  renderWorks(initialWorks || []);
  if (r.options && r.options.uploadResumeFirst) $("uploadResumeFirst").checked = true;
  $("autoRestoreWorksAttachments").checked = !(r.options && r.options.autoRestoreWorksAttachments === false);
  showResumeState(r.fileVault);
  // 数据收集开关与接收地址
  const opts = r.options || {};
  if (opts.shareData) $("shareData").checked = true;
  initAnchors();
  relocateAddButtons();
  initScrollSpy();
  // 打开即归顶：屏蔽浏览器/异步布局把视口带离顶部，避免「档案→项目经历」横跳。
  // 根因：Chrome 扩展弹窗重开时会恢复【上次的滚动位置】并【重新聚焦上次那个输入框】，
  // 而 #mainBody 是 overflow:auto 的滚动容器，重新聚焦下方「项目经历」的输入项会把它带下去。
  // 对策：关掉 scrollRestoration（已在 popup.html head 内联脚本尽早设置）+ 这里反复归顶 + 清掉残留焦点。
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
  const resetTop = () => {
    // 清掉浏览器恢复出来的焦点（聚焦下方输入框是“自动下滑”的真正推手）
    try { if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
    const mb = document.getElementById("mainBody");
    if (mb) mb.scrollTop = 0;
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    if (window.scrollY) window.scrollTo(0, 0);
    if (mb) mb.dispatchEvent(new Event("scroll")); // 让 scroll-spy 立即按顶端重算高亮
  };
  resetTop();
  requestAnimationFrame(resetTop);
  setTimeout(resetTop, 60);
  setTimeout(resetTop, 200);
  setTimeout(resetTop, 360);
  setTimeout(resetTop, 600);
  // 图、update banner 等异步渲染后再兜底一次
  window.addEventListener("load", resetTop);

  // 网页实时同步：storage 里 profiles / activeProfileId 变化时自动重渲染当前档案。
  // 否则网页端「立即同步到插件」写入后，已打开的插件面板一直显示打开时的旧快照（看起来像空白/不更新）。
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes.profiles && !changes.activeProfileId) return;
      getStorage(["profiles", "activeProfileId", "fileVault", "works"]).then((rr) => {
        try { refreshProfileSelect(); } catch (e) {}
        const ps = rr.profiles || [];
        const act = ps.find((x) => x.id === rr.activeProfileId);
        if (act && act.data) { currentProfile = act.data; renderEditor(act.data); }
        // 关键修复：网页同步把 profile.portfolio 灌入后，用同步数据即时填充作品集面板，
        // 避免「点了同步却看不到作品」。
        const syncedWorks = buildWorksFromProfile(act && act.data);
        if (syncedWorks && syncedWorks.length) {
          renderWorks(syncedWorks);
        }
      }).catch(() => {});
    });
  }

  // 兜底锁（终极手段）：打开后短时间内锁死滚动在顶部，任何「浏览器恢复出来的滚动」都立即拉回 0，
  // 不等时序、不跟 Chrome 抢跑。直到用户【主动】滚动（滚轮/触摸/键盘/点击）才解锁。
  // 这样无论是滚动位置恢复还是焦点恢复，只要它把容器带离顶部，就触发 scroll 事件被强行归零。
  (function lockScrollTop() {
    const mb = document.getElementById("mainBody");
    let locked = true;
    const clamp = () => {
      if (!locked) return;
      if (mb && mb.scrollTop !== 0) {
        mb.scrollTop = 0;
        // 顺手清掉「恢复出来的焦点」：否则会出现“视图在顶部、却在下方的输入框里打字”的隐形坑
        try { if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      }
      if (window.scrollY) window.scrollTo(0, 0);
    };
    if (mb) mb.addEventListener("scroll", clamp, { passive: true });
    window.addEventListener("scroll", clamp, { passive: true });
    const unlock = () => {
      locked = false;
      if (mb) mb.removeEventListener("scroll", clamp);
      window.removeEventListener("scroll", clamp);
    };
    // 用户任何主动输入都解锁（让正常的滚动/锚点跳转恢复生效）
    ["pointerdown", "wheel", "touchmove", "keydown"].forEach((ev) => {
      if (mb) mb.addEventListener(ev, unlock, { once: true, passive: true });
      window.addEventListener(ev, unlock, { once: true, passive: true });
    });
    // 极端兜底：2.5s 后无论如何解锁，避免永久锁死
    setTimeout(unlock, 2500);
  })();

  checkForUpdate();
  maybeReportOpen();
});

async function refreshProfileSelect() {
  const r = await getStorage(["profiles", "activeProfileId"]);
  const profiles = r.profiles || [];
  const sel = $("profileSelect");
  sel.innerHTML = "";
  profiles.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + (p.data ? "" : "（空）");
    sel.appendChild(o);
  });
  if (r.activeProfileId && profiles.find((p) => p.id === r.activeProfileId))
    sel.value = r.activeProfileId;
  const active = profiles.find((p) => p.id === r.activeProfileId);
  $("newProfileBtn").disabled = profiles.length >= 3;
  $("copyProfileBtn").disabled = profiles.length >= 3 || !currentProfile;
}

function initAnchors() {
  const nav = $("anchorNav");
  const body = $("mainBody");
  const links = [...nav.querySelectorAll("a")];

  nav.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = a.getAttribute("href").slice(1);
      if (id.startsWith("edit-")) {
        // 档案内部的细分锚点：先滚到「档案」大区，再滚到具体板块
        const sec = document.getElementById("section-profile");
        if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => {
          const el = document.getElementById(id);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 220);
      } else {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // 横向导航条随滚动联动高亮（scroll-spy）统一交给 initScrollSpy() 处理：
  // 顶部主板块 + 档案内部细分板块一起高亮，并用滚动位置判定，比 IntersectionObserver 更稳。
}

$("closePopup").addEventListener("click", () => window.close());

/* ---------- 简历管理 ---------- */
$("profileSelect").addEventListener("change", async (e) => {
  await setStorage({ activeProfileId: e.target.value });
  const r = await getStorage("profiles");
  const p = (r.profiles || []).find((x) => x.id === e.target.value);
  currentProfile = p && p.data ? p.data : null;
  if (currentProfile) renderEditor(currentProfile);
  else {
    clearEditor();
    setStatus("topStatus", "该简历暂无档案，请解析或编辑", "wait");
  }
  await refreshProfileSelect();
});

/* ---------- 右键重命名当前简历（替代原来右侧的改名框） ---------- */
const resumeCtxMenu = $("resumeCtxMenu");
const renameInput = $("renameInput");

function hideCtxMenu() { resumeCtxMenu.hidden = true; }

function doRenameCurrent(name) {
  name = (name || "").trim();
  if (!name) return;
  getStorage(["profiles", "activeProfileId"]).then((r) => {
    const profiles = r.profiles || [];
    const p = profiles.find((x) => x.id === r.activeProfileId);
    if (!p) return;
    p.name = name;
    setStorage({ profiles }).then(refreshProfileSelect);
  });
}

$("profileSelect").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  resumeCtxMenu.style.left = Math.min(e.clientX, window.innerWidth - 130) + "px";
  resumeCtxMenu.style.top = Math.min(e.clientY, window.innerHeight - 44) + "px";
  resumeCtxMenu.hidden = false;
});

resumeCtxMenu.addEventListener("click", (e) => {
  e.stopPropagation();
  const act = e.target.dataset.act;
  if (act !== "rename") return;
  resumeCtxMenu.hidden = true;
  const sel = $("profileSelect");
  const cur = (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : "").replace("（空）", "");
  renameInput.value = cur;
  const rect = sel.getBoundingClientRect();
  renameInput.style.left = rect.left + "px";
  renameInput.style.top = rect.bottom + 4 + "px";
  renameInput.hidden = false;
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 0);
});

renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
  else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
});
renameInput.addEventListener("blur", commitRename);

function commitRename() {
  if (renameInput.hidden) return;
  const v = renameInput.value;
  renameInput.hidden = true;
  doRenameCurrent(v);
}
function cancelRename() {
  renameInput.hidden = true;
}

document.addEventListener("click", hideCtxMenu);
document.addEventListener("scroll", hideCtxMenu, true);

$("newProfileBtn").addEventListener("click", async () => {
  const r = await getStorage("profiles");
  let profiles = r.profiles || [];
  if (profiles.length >= 3) return;
  const np = { id: genId(), name: "简历" + (profiles.length + 1), data: null };
  profiles.push(np);
  await setStorage({ profiles, activeProfileId: np.id });
  currentProfile = null;
  clearEditor();
  await refreshProfileSelect();
  setStatus("topStatus", `已新建「${np.name}」，请解析或编辑`, "wait");
});

$("copyProfileBtn").addEventListener("click", async () => {
  const r = await getStorage(["profiles", "activeProfileId"]);
  let profiles = r.profiles || [];
  if (profiles.length >= 3) return setStatus("topStatus", "最多 3 份，无法再复制", "err");
  const src = profiles.find((x) => x.id === r.activeProfileId);
  if (!src) return;
  const np = {
    id: genId(),
    name: (src.name || "简历") + "-副本",
    data: src.data ? JSON.parse(JSON.stringify(src.data)) : null,
  };
  profiles.push(np);
  await setStorage({ profiles, activeProfileId: np.id });
  currentProfile = np.data;
  if (np.data) renderEditor(np.data);
  else clearEditor();
  await refreshProfileSelect();
  setStatus("topStatus", `已复制为「${np.name}」`, "ok");
});

/* ---------- 导入档案 JSON（新增一份，不覆盖现有） ---------- */
$("importProfileBtn").addEventListener("click", () => {
  const p = $("importPanel");
  p.hidden = !p.hidden;
});
// 通用：把一个档案对象新增为一份当前简历（不覆盖现有），校验上限 3 份
async function addProfileFromData(data, st) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    st.textContent = "请输入一个档案对象 JSON（即 profile.data）";
    st.style.color = "#e06c75";
    return false;
  }
  const r = await getStorage("profiles");
  let profiles = r.profiles || [];
  if (profiles.length >= 3) {
    st.textContent = "最多 3 份，请先删一份再导入";
    st.style.color = "#e06c75";
    return false;
  }
  const name = (data.basic && data.basic.name) || "导入档案";
  const np = { id: genId(), name: String(name), data };
  profiles.push(np);
  await setStorage({ profiles, activeProfileId: np.id });
  currentProfile = data;
  if (data) renderEditor(data);
  else clearEditor();
  await refreshProfileSelect();
  return true;
}

$("importProfileConfirmBtn").addEventListener("click", async () => {
  const ta = $("importProfileIn");
  const st = $("importProfileStatus");
  let data;
  try {
    data = JSON.parse((ta.value || "").trim());
  } catch (e) {
    st.textContent = "JSON 解析失败：" + e.message;
    st.style.color = "#e06c75";
    return;
  }
  const ok = await addProfileFromData(data, st);
  if (ok) {
    const name = (data.basic && data.basic.name) || "导入档案";
    st.textContent = `已导入为「${name}」`;
    st.style.color = "#7ec699";
    setTimeout(() => { $("importPanel").hidden = true; }, 1200);
  }
});

/* ---------- 文档上传（Word/PDF 自动提取文字） ---------- */
$("docFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus("docFileStatus", "正在读取文档…", "wait");
  try {
    let text = "";
    if (file.name.toLowerCase().endsWith(".pdf")) text = await extractPdfText(file);
    else if (file.name.toLowerCase().endsWith(".docx")) text = await extractDocxText(await file.arrayBuffer());
    else text = await file.text();
    if (!text || text.trim().length < 20) {
      setStatus("docFileStatus", "没提取到文字，换个文件或改用粘贴", "err");
      return;
    }
    $("docText").value = text;
    setStatus("docFileStatus", `已提取 ${text.length} 字，点「解析」`, "ok");
  } catch (err) {
    setStatus("docFileStatus", "读取失败：" + err.message, "err");
  }
});

/* ---------- 解析 ---------- */
$("parseBtn").addEventListener("click", async () => {
  const doc = $("docText").value.trim();
  if (!doc) return setStatus("parseStatus", "请先上传或粘贴简历内容", "err");
  setStatus("parseStatus", "正在解析…", "wait");
  $("parseBtn").disabled = true;
  chrome.runtime.sendMessage({ action: "parseResume", doc }, async (res) => {
    $("parseBtn").disabled = false;
    if (!res || !res.ok) return setStatus("parseStatus", "失败：" + (res?.error || "未知"), "err");
    setStatus("parseStatus", "解析完成，请检查", "ok");
    reportUsage("parse");
    // 用户要求：重解析前先清空下方（档案数据 + 作品），再写入新结果；简历/证件照不动。
    const rWipe = await getStorage(["profiles", "activeProfileId", "works"]);
    const profiles = rWipe.profiles || [];
    const ap = profiles.find((x) => x.id === rWipe.activeProfileId);
    if (ap) ap.data = null;
    await setStorage({ profiles });
    await setStorage({ works: [] });
    currentProfile = res.profile;
    renderEditor(res.profile);
    // 作品集：从「项目经历(有链接/描述)」+「作品集」自动带入（不再合并旧作品，重解析即全新）
    const gen = buildWorksFromProfile(res.profile);
    await setStorage({ works: gen });
    renderWorks(gen);
    setStatus("parseStatus", `解析完成，已带入 ${gen.length} 条作品`, "ok");
    await refreshProfileSelect();
  });
});

/* ---------- 保存当前简历 ---------- */
function worksToPortfolio(works) {
  return (works || [])
    // 关键修复：旧逻辑只保留「有 link/desc/password」的作品，导致只有名称（或只有名称+链接）的作品在保存时被整条丢弃，
    // 网页同步过来的作品集因此在插件里全部消失。现在：只要有任一有效字段就保留。
    .filter((w) => w && (w.name || w.link || w.desc || w.password || w.date))
    .map((w) => ({
      // 关键修复：姓名直接取自 w.name，不再从 desc 的「【名称】」前缀里抠（旧写法会丢名称）。
      name: (w.name || "").trim(),
      link: w.link || "",
      description: (w.desc || "").trim(),
      password: w.password || "",
    }));
}
async function saveProfileFromEditor() {
  if (!currentProfile && !$("basicEditor").children.length) return;
  const profile = collectProfileFromEditor();
  // 2026-08-13：把「作品集」面板维护的 works 同步回 profile.portfolio，
  // 否则每次保存/投递都会把 portfolio 弄丢，网页上作品链接/密码也填不上。
  profile.portfolio = worksToPortfolio(currentWorks);
  currentProfile = profile;
  const r = await getStorage(["profiles", "activeProfileId"]);
  const profiles = r.profiles || [];
  const p = profiles.find((x) => x.id === r.activeProfileId);
  if (p) p.data = profile;
  await setStorage({ profiles });
  setStatus("saveStatus", "当前简历已自动保存", "ok");
}
$("saveProfileBtn").addEventListener("click", saveProfileFromEditor);
// 用户可导出档案 JSON（换电脑/重装不丢资料；也便于备份与迁移）
$("exportProfileBtn").addEventListener("click", () => {
  const profile = collectProfileFromEditor();
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "秋招档案-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setStatus("saveStatus", "已导出档案 JSON（在当前简历基础上）", "ok");
});
// 2026-08-13：用户反馈「在插件里手写的内容刷新后不保存」。
// 给档案编辑器所有输入框加自动保存：input/change 事件 debounce 600ms 后落盘。
const autoSaveProfileDebounced = debounce(() => saveProfileFromEditor(), 600);
document.addEventListener("input", (e) => {
  if (e.target.closest("#basicEditor, #educationEditor, #internshipsEditor, #projectsEditor, #campusEditor, #papersEditor, #competitionsEditor, #languagesEditor, #socialEditor, #certificatesEditor, #skillsEditor, #awardsEditor, #patentsEditor, #intentEditor, #referenceEditor, #aiSkillsEditor, #selfEvalEditor")) {
    autoSaveProfileDebounced();
  }
});
// change 事件（下拉选择、单选等）立即保存，不 debounce
document.addEventListener("change", (e) => {
  if (e.target.closest("#basicEditor, #educationEditor, #internshipsEditor, #projectsEditor, #campusEditor, #papersEditor, #competitionsEditor, #languagesEditor, #socialEditor, #certificatesEditor, #skillsEditor, #awardsEditor, #patentsEditor, #intentEditor, #referenceEditor, #aiSkillsEditor, #selfEvalEditor")) {
    saveProfileFromEditor();
  }
});

// 用 canvas 把图片压缩到 targetSize 以下（优先降质量，必要时降尺寸）
function compressPhoto(file, targetSize) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      const maxDim = 1200; // 证件照不需要太高分辨率
      if (Math.max(w, h) > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      let quality = 0.92;
      const tryBlob = () => {
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error("canvas 导出失败"));
          if (blob.size <= targetSize || quality <= 0.3) {
            const compressed = new File([blob], file.name.replace(/\.[^.]+$/, ".jpg") + "" || "photo.jpg", { type: "image/jpeg" });
            resolve(compressed);
          } else {
            quality -= 0.08;
            tryBlob();
          }
        }, "image/jpeg", quality);
      };
      tryBlob();
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = url;
  });
}

/* ---------- 简历文件 ---------- */
$("resumeFile").addEventListener("change", (e) => saveFileItem("resume", e.target.files[0]));
/* ---------- 证件照文件 ---------- */
$("photoFile").addEventListener("change", async (e) => { await saveFileItem("photo", e.target.files[0]); });

async function saveFileItem(cat, file) {
  if (!file) return;
  // 证件照自动压缩到 ≤300KB（腾讯等站实测 300KB 以下不弹窗）
  if (cat === "photo" && file.size > 300 * 1024) {
    try {
      file = await compressPhoto(file, 300 * 1024);
      updateFileMeta(cat, `证件照已压缩至 ${(file.size / 1024).toFixed(1)}KB`, "ok");
    } catch (e) {
      updateFileMeta(cat, `证件照压缩失败：${e.message}，请手动压缩到 300KB 以下`, "warn");
      return;
    }
  }
  // 各通道按"所有站点最低可接受值"硬拦截（简历 6MB / 证件照 300KB；其余兜底 6MB）
  const CHANNEL_MAX = { resume: 6 * 1024 * 1024, photo: 300 * 1024 };
  const max = CHANNEL_MAX[cat] || (6 * 1024 * 1024);
  if (file.size > max) {
    const label = cat === "resume" ? "简历" : cat === "photo" ? "证件照" : "文件";
    updateFileMeta(cat, `${label} ${file.name}（${(file.size / 1048576).toFixed(1)}MB）超过上限 ${max / 1048576}MB，请压缩后重试`, "warn");
    return;
  }
  chrome.storage.local.get("fileVault", async (r) => {
    const vault = r.fileVault || {};
    const base = { name: file.name, size: file.size };
    const storageKey = getFileStorageKey(cat);
    // 删除旧分片，避免同一分类残留过期数据
    await deleteFragmentedFile(storageKey);
    const reader = new FileReader();
    reader.onload = async () => {
      const fileObj = { ...base, manual: false, base64: reader.result };
      await saveFragmentedFile(storageKey, fileObj);
      vault[cat] = { ...base, manual: false, storageKey };
      await setStorage({ fileVault: vault });
      updateFileMeta(cat, `${file.name}（${(file.size / 1048576).toFixed(1)}MB）已就绪，自动上传`, "ok");
    };
    reader.readAsDataURL(file);
  });
}

function updateFileMeta(cat, text, type) {
  const meta = $(`meta-${cat}`);
  if (!meta) return;
  meta.textContent = text;
  meta.className = "file-meta " + type;
}

// 弹窗打开时，把已保存的简历文件状态显示出来，避免用户以为要重新上传
function showResumeState(vault) {
  const v = vault && vault.resume;
  const meta = $("meta-resume");
  if (!meta) return;
  if (!v) {
    meta.textContent = "未选择（投递时会自动带简历文件，上传一次即可）";
    meta.className = "file-meta";
    return;
  }
  const auto = v.manual ? "（较大，投递时帮你点开上传框）" : "（已保存，刷新页面也不会丢，投递时自动上传）";
  meta.textContent = "✓ 已保存：" + v.name + auto;
  meta.className = "file-meta ok";
  showPhotoState(vault);
}

// 弹窗打开时，把已保存的证件照状态显示出来
function showPhotoState(vault) {
  const v = vault && vault.photo;
  const meta = $("meta-photo");
  if (!meta) return;
  if (!v) {
    meta.textContent = "未选择（可选，部分站点需要上传证件照）";
    meta.className = "file-meta";
    return;
  }
  const auto = v.manual ? "（较大，投递时帮你点开上传框）" : "（已保存，投递时自动上传）";
  meta.textContent = "✓ 已保存：" + v.name + auto;
  meta.className = "file-meta ok";
}

$("uploadResumeFirst").addEventListener("change", (e) => {
  getStorage("options").then((r) => {
    const opt = r.options || {};
    opt.uploadResumeFirst = e.target.checked;
    setStorage({ options: opt });
  });
});
$("autoRestoreWorksAttachments").addEventListener("change", async (e) => {
  const opts = (await getStorage("options")).options || {};
  opts.autoRestoreWorksAttachments = e.target.checked;
  await setStorage({ options: opts });
});

/* ---------- 作品条目 ---------- */
let currentWorks = [];

function renderWorks(works) {
  currentWorks = works || [];
  const c = $("worksList");
  c.innerHTML = "";
  if (!currentWorks.length) {
    c.innerHTML = `<div class="hint">还没有作品，点下方「+ 添加作品」。解析文档后会自动带入作品链接与描述。</div>`;
    return;
  }
  currentWorks.forEach((w, i) => c.appendChild(createWorkCard(w, i)));
}

function createWorkCard(w, idx) {
  const card = document.createElement("div");
  card.className = "work-card";
  const savedAttachmentHtml = w.attachment
    ? `✓ 已选择：${escapeHtml(w.attachment.name)}（${(w.attachment.size / 1048576).toFixed(1)}MB）`
    : `未选择任何文件`;
  card.innerHTML = `
    <div class="work-header">
      <span class="work-title">作品 #${idx + 1}</span>
      <button class="btn-del-small" data-idx="${idx}">删除</button>
    </div>
    <div class="work-fields">
      <div class="work-row">
        <span class="work-label">作品名称</span>
        <input class="work-name" placeholder="例如：智能简历解析浏览器扩展" value="${escapeHtml(w.name || "")}">
      </div>
      <div class="work-row">
        <span class="work-label">作品链接</span>
        <input class="work-link" placeholder="https://..." value="${escapeHtml(w.link || "")}">
      </div>
      <div class="work-row">
        <span class="work-label">密码 / 提取码</span>
        <input class="work-pwd" placeholder="网盘私密分享的提取码等，没有可留空" value="${escapeHtml(w.password || "")}">
      </div>
      <div class="work-row">
        <span class="work-label">作品描述</span>
        <textarea class="work-desc" rows="2" placeholder="简单描述这个作品">${escapeHtml(w.desc || "")}</textarea>
      </div>
      <div class="work-row">
        <span class="work-label">作品日期</span>
        <div class="month-single" data-month="work-date"></div>
      </div>
      <div class="work-row work-file-row">
        <span class="work-label">作品附件</span>
        <input type="file" class="work-file" style="display:none" accept=".zip,.7z,.rar,.pdf,.mp4,.mov,.avi,.mkv,.webm,.mp3,.wav,.flac,.png,.jpg,.jpeg" data-idx="${idx}">
        <div class="work-file-display">
          <span class="work-file-name ${w.attachment ? "ok" : "empty"}">${savedAttachmentHtml}</span>
          <div class="work-file-actions">
            <button class="btn-choose-file">${w.attachment ? "重新选择" : "选择文件"}</button>
            <button class="btn-remove-file" ${w.attachment ? "" : 'style="display:none"'}>× 移除</button>
          </div>
        </div>
      </div>
      <div class="work-attachment-hint" style="${w.attachment ? '' : 'display:none'}">文件已保存到插件，刷新页面后会自动恢复到网页作品框</div>
      <div class="work-file-status" style="display:none"></div>
    </div>
  `;
  function showStatus(text, type) {
    const st = card.querySelector(".work-file-status");
    st.style.display = "block";
    st.textContent = text;
    st.className = "work-file-status" + (type === "ok" ? " ok" : type === "err" ? " err" : "");
  }
  card.querySelector(".btn-del-small").addEventListener("click", async () => {
    const w = currentWorks[idx];
    if (w && w.attachment && w.attachment.storageKey) await deleteFragmentedFile(w.attachment.storageKey);
    currentWorks.splice(idx, 1);
    await saveWorks();
    renderWorks(currentWorks);
  });
  // 2026-08-13：改为 input 事件 + debounce 自动保存，用户不离开输入框也能落盘，
  // 避免「写了一半刷新页面，内容回到最初」的问题。
  const debouncedSave = debounce(() => saveWorks(), 600);
  card.querySelector(".work-link").addEventListener("input", (e) => { currentWorks[idx].link = e.target.value; debouncedSave(); });
  card.querySelector(".work-desc").addEventListener("input", (e) => { currentWorks[idx].desc = e.target.value; debouncedSave(); });
  card.querySelector(".work-pwd").addEventListener("input", (e) => { currentWorks[idx].password = e.target.value; debouncedSave(); });
  // 2026-08-16：作品名称 + 作品日期（年→月→日日历）
  card.querySelector(".work-name").addEventListener("input", (e) => { currentWorks[idx].name = e.target.value; debouncedSave(); });
  const dateBox = card.querySelector('[data-month="work-date"]');
  if (dateBox) {
    renderMonthPicker(dateBox, "work-date-" + idx, w.date || "");
    const dateHidden = dateBox.querySelector('[data-key="work-date-' + idx + '"]');
    if (dateHidden) {
      const mo = new MutationObserver(() => { currentWorks[idx].date = dateHidden.value; debouncedSave(); });
      mo.observe(dateHidden, { attributes: true, attributeFilter: ["value"] });
    }
  }
  // 文件选择：直接在卡片上显示每一步状态，不重建列表（避免输入框被重置、状态行消失）
  // 合并后的「作品附件」单槽：PDF 或视频都放这一个，网页作品附件框本就是单文件框
  function setAttachmentUi(name, size, mode) {
    const nameEl = card.querySelector(".work-file-name");
    const hintEl = card.querySelector(".work-attachment-hint");
    const removeBtn = card.querySelector(".btn-remove-file");
    const chooseBtn = card.querySelector(".btn-choose-file");
    if (mode === "empty") {
      nameEl.className = "work-file-name empty";
      nameEl.textContent = "未选择任何文件";
      hintEl.style.display = "none";
      removeBtn.style.display = "none";
      chooseBtn.textContent = "选择文件";
    } else if (mode === "oversized") {
      nameEl.className = "work-file-name err";
      nameEl.textContent = "未选择任何文件（文件超过 300MB）";
      hintEl.style.display = "none";
      removeBtn.style.display = "none";
      chooseBtn.textContent = "选择文件";
    } else if (mode === "reading") {
      nameEl.className = "work-file-name";
      nameEl.textContent = `${escapeHtml(name)}（${(size / 1048576).toFixed(1)}MB，读取中…）`;
      hintEl.style.display = "none";
      removeBtn.style.display = "none";
      chooseBtn.textContent = "重新选择";
    } else {
      nameEl.className = "work-file-name ok";
      nameEl.textContent = `✓ 已选择：${escapeHtml(name)}（${(size / 1048576).toFixed(1)}MB）`;
      hintEl.style.display = "";
      removeBtn.style.display = "";
      chooseBtn.textContent = "重新选择";
    }
  }
  const fileInput = card.querySelector(".work-file");
  card.querySelector(".btn-choose-file").addEventListener("click", () => {
    fileInput.click();
  });
  fileInput.addEventListener("change", async (e) => {
    try {
      const file = e.target.files && e.target.files[0];
      if (!file) { showStatus("没有选中文件，请重新选择", "err"); return; }
      // 清除旧分片
      if (currentWorks[idx].attachment && currentWorks[idx].attachment.storageKey) {
        await deleteFragmentedFile(currentWorks[idx].attachment.storageKey);
      }
      currentWorks[idx].attachment = { name: file.name, size: file.size, base64: null, reading: true };
      setAttachmentUi(file.name, file.size, "reading");
      showStatus(`已选择 ${file.name}，正在读取…`, "");
      const WORK_MAX = 150 * 1024 * 1024; // 美团作品集上限 150MB
      if (file.size > WORK_MAX) {
        showStatus(`文件超过 ${WORK_MAX / 1048576}MB（美团作品集上限），无法使用，请压缩后重试`, "err");
        currentWorks[idx].attachment = null;
        setAttachmentUi(null, 0, "oversized");
        return;
      }
      const storageKey = getWorkFileStorageKey(idx, "attachment");
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const fileObj = { name: file.name, size: file.size, base64: reader.result, manual: false };
          await saveFragmentedFile(storageKey, fileObj);
          currentWorks[idx].attachment = { name: file.name, size: file.size, manual: false, storageKey };
          setAttachmentUi(file.name, file.size, "saved");
          saveWorks().then((ok) => {
            showStatus(ok ? `已添加附件 ${file.name}（已保存）` : `已读取但保存失败：${file.name}`, ok ? "ok" : "err");
          });
        } catch (err) { showStatus("保存出错：" + err.message, "err"); }
      };
      reader.onerror = (ev) => {
        setAttachmentUi(null, 0, "empty");
        showStatus("读取失败：" + ((ev && ev.message) || "文件可能过大或损坏，请换一个试试"), "err");
      };
      reader.readAsDataURL(file);
    } catch (err) {
      showStatus("出错了：" + err.message, "err");
    }
  });
  // 移除附件按钮：只清当前卡片的 attachment，不删整条作品
  card.querySelector(".btn-remove-file").addEventListener("click", async () => {
    const w = currentWorks[idx];
    if (w && w.attachment && w.attachment.storageKey) {
      try { await deleteFragmentedFile(w.attachment.storageKey); } catch (e) {}
    }
    currentWorks[idx].attachment = null;
    await saveWorks();
    setAttachmentUi(null, 0, "empty");
    fileInput.value = "";
    showStatus("已移除附件", "ok");
  });
  return card;
}

$("addWorkBtn").addEventListener("click", () => {
  currentWorks.push({ name: "", link: "", desc: "", date: "", password: "", attachment: null });
  saveWorks();
  renderWorks(currentWorks);
});

function saveWorks() {
  return new Promise((resolve) => {
    // 防御：确保写入 storage 的 works 里不包含 base64（大文件应已分片存储）
    const cleaned = (currentWorks || []).map((w) => {
      if (!w) return w;
      const out = Object.assign({}, w);
      if (out.attachment) out.attachment = Object.assign({}, out.attachment, { base64: undefined });
      return out;
    });
    chrome.storage.local.set({ works: cleaned }, () => {
      if (chrome.runtime.lastError) {
        setStatus("feedbackStatus", "作品保存失败：" + chrome.runtime.lastError.message, "err");
        resolve(false);
        return;
      }
      // 校验真的写进去了（防止异步写入未完成/被吞）
      chrome.storage.local.get("works", (r) => {
        const saved = (r.works || []).length === (currentWorks || []).length;
        if (!saved) {
          setStatus("feedbackStatus", "作品保存未生效，请重试或换小文件", "err");
        }
        resolve(saved);
      });
    });
  });
}

function buildWorksFromProfile(profile) {
  if (!profile) return [];
  const out = [];
  // 2026-08-13：不再把 projects 和 portfolio 简单合并，否则「项目经历」和「作品集」
  // 重复链接会让网页上出现 8 个作品卡片（用户文档里作品集只有 4 个）。
  // 优先只取 profile.portfolio；如果用户没维护作品集，再用 projects 兜底。
  const source = (profile.portfolio || []).length ? profile.portfolio : (profile.projects || []);
  source.forEach((w) => {
    if (w.link || w.description || w.name) {
      out.push({
        name: w.name || "",
        link: w.link || "",
        desc: (w.description || ""),
        password: w.password || "",
        attachment: null,
      });
    }
  });
  return out;
}

// 注意：works 的加载只放在 DOMContentLoaded 里做一次（见 init）。
// 这里不再重复 renderWorks —— 顶层重复调用会用存储旧数据覆盖用户正在编辑的内容
// （存储里有大 base64 文件时读取慢，回调延后执行会「吃掉」用户刚添加的作品）。

/* ---------- 打开管理台（资料编辑 + 投递记录） ---------- */
$("openTrackerBtn").addEventListener("click", () => {
  const openMgmt = (site) => {
    const base = chrome.runtime.getURL("management.html");
    const url = site ? base + "?site=" + encodeURIComponent(site) : base;
    chrome.tabs.create({ url });
  };
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let site = "";
      const t = tabs && tabs[0];
      if (t && t.url) { try { site = new URL(t.url).hostname; } catch (e) { site = ""; } }
      openMgmt(site);
    });
  } catch (e) {
    openMgmt("");
  }
});

// 「页面内面板」：把整个插件界面注入到当前招聘页里，做成可自由拖动的悬浮面板。
// 好处：① 面板能随意拖动、不被遮挡，同时还能看到招聘页面（不是独立窗口）；
//      ② 在面板里选择作品文件时不会被浏览器自动关闭（工具栏弹窗选文件会被关闭，
//         这就是之前作品 MP4/PDF「传不进来」的根因），文件能正常读进插件。
$("openFloatWindowBtn").addEventListener("click", async () => {
  const tabs = await queryTabs();
  if (!tabs[0]) return setStatus("topStatus", "找不到当前标签页", "err");
  chrome.tabs.sendMessage(tabs[0].id, { action: "openPanel" }, (res) => {
    if (chrome.runtime.lastError)
      return setStatus("topStatus", "无法在页面打开面板：请先刷新招聘网页再试", "err");
    setStatus("topStatus", "已在页面打开可拖动面板", "ok");
    // 工具栏弹窗点完自动关闭（面板已在页面上）；页面内面板模式下不关闭自身
    if (!location.search.includes("mode=float")) setTimeout(() => window.close(), 400);
  });
});

/* ---------- 网页表单一键清空（向内容脚本发 clearPage） ---------- */
$("clearPageBtn").addEventListener("click", () => {
  sendToPage("clearPage", {}, (ok, res) => {
    if (!ok) return setStatus("topStatus", "网页清空失败：" + res + "（请先刷新招聘网页）", "err");
    const c = (res && res.count) || 0;
    setStatus("topStatus", `已清空网页表单 ${c} 个字段`, "ok");
  });
});

/* ---------- ① 只清临时缓存（不影响任何用户数据） ---------- */
$("clearTempBtn").addEventListener("click", async () => {
  if (!confirm("确认只清【临时缓存】？\n仅清理运行缓存（如最近打开记录），不影响档案 / 作品 / 文件。")) return;
  const r = await RFAClear.clearStorageTier(1, rfaClearDeps());
  setStatus("topStatus", `已清临时缓存 ${r.removed.length} 项`, "ok");
});

/* ---------- 清空下方档案（保留简历 PDF / 证件照） — ③ 清空全部已填 ---------- */
$("clearProfileBtn").addEventListener("click", async () => {
  if (!confirm("确认清空【全部已填档案】？\n将清空当前档案数据 + 作品集 + 当前网页表单，但保留简历PDF/证件照、API Key、设置。")) return;
  await RFAClear.clearStorageTier(3, rfaClearDeps());
  currentProfile = null;
  if (typeof clearEditor === "function") clearEditor();
  if (typeof renderWorks === "function") renderWorks([]);
  await refreshProfileSelect();
  setStatus("topStatus", "已清空全部已填（档案+作品+网页），简历/证件照保留", "ok");
});

/* ---------- 全部清空（含简历 PDF / 证件照） — ④ 恢复出厂 ---------- */
$("clearAllBtn").addEventListener("click", async () => {
  if (!confirm("确认【恢复出厂】？\n将删除档案 + 作品 + 简历PDF + 证件照 + API Key + 设置，不可恢复")) return;
  await RFAClear.clearStorageTier(4, rfaClearDeps());
  currentProfile = null;
  if (typeof clearEditor === "function") clearEditor();
  if (typeof renderWorks === "function") renderWorks([]);
  updateFileMeta("resume", "未选择", "");
  updateFileMeta("photo", "未选择", "");
  await refreshProfileSelect();
  setStatus("topStatus", "已恢复出厂（全部清空）", "ok");
});

/* ---------- 一键投递（顶部 + 底部两处入口，共用同一逻辑） ---------- */
let fillingInProgress = false;
function setFillBtn(on) {
  const b = $("fillBtnBottom");
  if (!b) return;
  if (on) {
    b.classList.add("filling");
    b.disabled = true;
    if (!b.dataset.old) b.dataset.old = b.textContent;
    b.textContent = "正在投递…";
  } else {
    b.classList.remove("filling");
    b.disabled = false;
    if (b.dataset.old) b.textContent = b.dataset.old;
  }
}
function finishFill() {
  fillingInProgress = false;
  setFillBtn(false);
}
function stripFileBase64(vault, works) {
  // 保险：投递消息里绝不含 base64（防止旧数据/异常路径导致 sendMessage 超过 64MB）
  const cleanVault = {};
  Object.keys(vault || {}).forEach((k) => {
    const v = vault[k];
    if (!v) return;
    cleanVault[k] = Object.assign({}, v, { base64: undefined });
  });
  const cleanWorks = (works || []).map((w) => {
    if (!w) return w;
    const out = Object.assign({}, w);
    if (out.attachment) out.attachment = Object.assign({}, out.attachment, { base64: undefined });
    return out;
  });
  return { fileVault: cleanVault, works: cleanWorks };
}

async function doFill() {
  if (fillingInProgress) return; // 防止重复点击导致重复投递
  const r = await getStorage(["profiles", "activeProfileId", "fileVault", "works", "options"]);
  // 必读同意：未勾选《投递数据收集说明》则不能使用一键投递
  if (!r.options || !r.options.shareData) {
    setStatus("topStatus", "请先勾选下方「投递数据收集说明」中的同意项，才能使用一键投递", "err");
    const sec = document.getElementById("section-data");
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const active = (r.profiles || []).find((x) => x.id === r.activeProfileId);
  // v0.6.54：一键投递前自动保存当前面板数据，避免用户忘了点「保存当前简历」导致用旧数据投递
  const freshProfile = collectProfileFromEditor();
  // 2026-08-13：同步作品集面板数据到 profile.portfolio，防止投递时作品链接/密码丢失。
  freshProfile.portfolio = worksToPortfolio(currentWorks);
  currentProfile = freshProfile;
  if (active) active.data = freshProfile;
  await setStorage({ profiles: r.profiles || [] });
  const profile = (active && active.data) || currentProfile;
  if (!profile) return setStatus("topStatus", "请先在「详细文档」解析并保存当前简历", "err");
  // 把「作品集」区维护的链接/描述合并进 profile.portfolio，供网站填充作品链接/描述字段
  const works = r.works || [];
  const augmented = Object.assign({}, profile);
  augmented.portfolio = works
    .filter((w) => w && (w.link || w.desc || w.password))
    .map((w) => ({ name: "", link: w.link || "", description: w.desc || "", password: w.password || "" }));

  // 进入投递状态：按钮变黄 + 禁用，避免误以为卡住而重复点击
  fillingInProgress = true;
  setFillBtn(true);
  setStatus("topStatus", "正在一键投递…", "wait");
  const tabs = await queryTabs();
  if (!tabs[0]) { setStatus("topStatus", "找不到当前标签页", "err"); finishFill(); return; }
  const { fileVault: cleanVault, works: cleanWorks } = stripFileBase64(r.fileVault, r.works);
  chrome.tabs.sendMessage(
    tabs[0].id,
    {
      action: "autofill",
      profile: augmented,
      fileVault: cleanVault,
      works: cleanWorks,
      options: r.options || {},
    },
    (res) => {
      finishFill(); // 无论成功失败都先恢复按钮
      if (chrome.runtime.lastError)
        return setStatus("topStatus", "无法操作该页，请刷新招聘网页后重试", "err");
      if (!res || !res.ok)
        return setStatus(
          "topStatus",
          "未填充：" + (res?.error || "未知") + (res?.scanned ? `（识别 ${res.scanned} 字段）` : ""),
          "err"
        );
      const uploadWarn = res.uploadPending
        ? "；⚠ 有附件上传未完成/被网站拒收，需手动上传"
        : "";
      setStatus(
        "topStatus",
        `已填 ${res.filled}/${res.total}（识别 ${res.scanned || res.total}）；未填 ${res.unfilled || 0} 个${uploadWarn}`,
        res.uploadPending ? "wait" : "ok"
      );
      const successRate = res.total ? Math.round((res.filled / res.total) * 100) : 0;
      reportUsage("autofill", {
        filled: res.filled,
        total: res.total,
        scanned: res.scanned || res.total,
        unfilled: res.unfilled || 0,
        success_rate: successRate,
        unfilled_fields: res.unfilledFields || [],
        section_hits: res.sectionHits || {},
        has_pdf: !!(r.fileVault && r.fileVault.resume),
        deepseek_used: res.source === "llm",
      });
    }
  );
  // 兜底：若 2 分钟仍未收到回包（罕见），自动恢复按钮，避免永久卡死
  setTimeout(() => { if (fillingInProgress) finishFill(); }, 120000);
}
$("fillBtnBottom").addEventListener("click", doFill);

/* ---------- 调试：一键导出页面字段（给开发者看目标站结构，无需登录用户账号） ---------- */
$("exportFieldsBtn").addEventListener("click", async () => {
  const tabs = await queryTabs();
  if (!tabs[0]) return setStatus("exportStatus", "找不到当前标签页", "err");
  setStatus("exportStatus", "正在展开下拉框抓取选项，请稍候（约十几秒）…", "wait");
  chrome.tabs.sendMessage(tabs[0].id, { action: "exportFields" }, (res) => {
    if (chrome.runtime.lastError || !res || res.error) {
      return setStatus("exportStatus", "请先在该招聘网页上刷新扩展，再点此按钮", "err");
    }
    const json = JSON.stringify(res, null, 1);
    const ta = $("exportFieldsOut");
    if (ta) ta.value = json;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(
        () => setStatus("exportStatus", `已复制 ${res.fields.length} 个字段结构，发给开发者即可`, "ok"),
        () => setStatus("exportStatus", "已生成在下方框，请手动复制", "wait")
      );
    } else {
      setStatus("exportStatus", "已生成在下方框，请手动复制", "wait");
    }
  });
});

$("copyExportBtn").addEventListener("click", async () => {
  const ta = $("exportFieldsOut");
  if (!ta || !ta.value) return setStatus("exportStatus", "请先点「导出当前页面字段」", "err");
  try {
    await navigator.clipboard.writeText(ta.value);
    setStatus("exportStatus", "已复制", "ok");
  } catch (e) {
    setStatus("exportStatus", "复制失败，请手动选择下方文字复制", "err");
  }
});

/* ---------- 调试：一键导出插件本地存储（排查刷新后作品附件丢失） ---------- */
// 仅读取 chrome.storage.local 的 works / fileVault，复制到剪贴板并显示在下方，便于定位根因。
// 注意：自 v0.6.36 起文件字节已分片存储，works/fileVault 内不含 base64，导出体很小。
$("exportStorageBtn").addEventListener("click", async () => {
  const r = await getStorage(["works", "fileVault", "profiles", "activeProfileId"]);
  const works = r.works || [];
  const attInfo = works
    .map((w, i) => {
      if (!w) return null;
      const f = w.attachment || w.video || w.pdf;
      return f ? { index: i, name: f.name, size: f.size, hasStorageKey: !!f.storageKey } : null;
    })
    .filter(Boolean);
  const summary = {
    worksCount: works.length,
    worksWithAttachment: attInfo.length,
    attachmentList: attInfo,
    fileVaultKeys: Object.keys(r.fileVault || {}),
  };
  const dump = { _summary: summary, works: r.works, fileVault: r.fileVault };
  const json = JSON.stringify(dump, null, 2);
  const ta = $("exportStorageOut");
  if (ta) ta.value = json;
  try {
    await navigator.clipboard.writeText(json);
    setStatus("exportStorageStatus", `已复制：${attInfo.length}/${works.length} 个作品带附件，发给开发者即可`, "ok");
  } catch (e) {
    setStatus("exportStorageStatus", "已生成在下方框，请手动复制", "wait");
  }
});

/* ---------- 投递数据收集说明（必读，不同意无法投递） ---------- */
$("shareData").addEventListener("change", async (e) => {
  const opts = (await getStorage("options")).options || {};
  opts.shareData = e.target.checked;
  await setStorage({ options: opts });
  setStatus("dataStatus", e.target.checked ? "已同意：仅收集你的投递数据（岗位/次数，不含个人信息）用于改进插件" : "未同意：将无法使用一键投递", e.target.checked ? "ok" : "err");
});

/* ---------- 更新提示 ---------- */
$("updateBtn").addEventListener("click", () => chrome.runtime.reload());
$("updateIgnoreBtn").addEventListener("click", async () => {
  const v = $("updateVersion").textContent;
  $("updateBanner").hidden = true;
  await setStorage({ updateDismissed: v });
});

/* ---------- 行政区划级联选择器 ---------- */
let districtData = null;
async function loadDistricts() {
  if (districtData) return districtData;
  try {
    const res = await fetch(chrome.runtime.getURL("districts.json"));
    districtData = await res.json();
  } catch (e) {
    districtData = [];
  }
  return districtData;
}

const REGION_OPTIONS = ["中国大陆", "中国香港", "中国澳门", "中国台湾"];

// 把 location/hometown（如 "中国大陆/四川省/成都市/锦江区" 或旧 "四川省/成都市/成华区"）解析成四级值
function parseCascadeValue(raw, provinces) {
  const out = { region: "中国大陆", province: "", city: "", district: "" };
  const s = String(raw || "").trim();
  if (!s) return out;

  // 新格式：国家/地区/省/市/区
  const parts = s.split("/").map((x) => x.trim());
  if (REGION_OPTIONS.includes(parts[0])) {
    out.region = parts[0];
    out.province = parts[1] || "";
    out.city = parts[2] || "";
    out.district = parts[3] || "";
    return out;
  }

  // 旧格式：省/市/区（默认中国大陆）
  out.province = parts[0] || "";
  out.city = parts[1] || "";
  out.district = parts[2] || "";
  if (!out.province) {
    if (REGION_OPTIONS.includes(s)) {
      out.region = s;
    } else {
      // 无斜杠：在中国大陆区划里搜最细粒度
      for (const p of provinces || []) {
        if (p.name === s) { out.province = p.name; break; }
        for (const c of p.children || []) {
          if (c.name === s) { out.province = p.name; out.city = c.name; break; }
          for (const d of c.children || []) {
            if (d.name === s) { out.province = p.name; out.city = c.name; out.district = d.name; break; }
          }
          if (out.city) break;
        }
        if (out.province) break;
      }
    }
  }
  return out;
}

function renderCascade(container, key, basic) {
  const regionKey = key + "Region";
  const provinceKey = key + "Province";
  const cityKey = key + "City";
  const districtKey = key + "District";
  container.classList.add("cascade-single");
  container.innerHTML = `
    <div class="cascade-trigger"><span class="cascade-text"></span><span class="cascade-arrow">▾</span></div>
    <div class="cascade-panel" hidden>
      <div class="cascade-head"><span class="cascade-back">‹ 返回</span><span class="cascade-step"></span></div>
      <div class="cascade-col"></div>
    </div>
    <input type="hidden" data-key="${regionKey}" value="">
    <input type="hidden" data-key="${provinceKey}" value="">
    <input type="hidden" data-key="${cityKey}" value="">
    <input type="hidden" data-key="${districtKey}" value="">
  `;
  const trigger = container.querySelector(".cascade-trigger");
  const panel = container.querySelector(".cascade-panel");
  const back = container.querySelector(".cascade-back");
  const stepEl = container.querySelector(".cascade-step");
  const col = container.querySelector(".cascade-col");
  const hR = container.querySelector(`[data-key="${regionKey}"]`);
  const hP = container.querySelector(`[data-key="${provinceKey}"]`);
  const hC = container.querySelector(`[data-key="${cityKey}"]`);
  const hD = container.querySelector(`[data-key="${districtKey}"]`);
  const textEl = container.querySelector(".cascade-text");
  let step = 1;
  const STEP_TITLE = { 1: "选择国家 / 地区", 2: "选择省 / 直辖市", 3: "选择城市", 4: "选择区 / 县" };

  function syncText() {
    const parts = [hP.value, hC.value, hD.value].filter(Boolean);
    if (parts.length) { textEl.textContent = parts.join("  "); textEl.classList.remove("placeholder"); }
    else if (hR.value) { textEl.textContent = hR.value; textEl.classList.remove("placeholder"); }
    else { textEl.textContent = "请选择 国家/地区 · 省 · 市 · 区"; textEl.classList.add("placeholder"); }
  }
  function close() { panel.hidden = true; trigger.classList.remove("open"); }
  function startStep() {
    if (!hR.value) return 1;
    if (hR.value !== "中国大陆") return 1;
    if (!hP.value) return 2;
    if (!hC.value) return 3;
    if (!hD.value) return 4;
    return 4;
  }
  function levelItems() {
    if (step === 1) return REGION_OPTIONS.map((v) => ({ v, t: v }));
    if (step === 2) return (districtData || []).map((p) => ({ v: p.name, t: p.name }));
    if (step === 3) {
      const prov = (districtData || []).find((p) => p.name === hP.value);
      return (prov && prov.children ? prov.children : []).map((c) => ({ v: c.name, t: c.name }));
    }
    const prov = (districtData || []).find((p) => p.name === hP.value);
    if (!cityLevelExists()) return (prov && prov.children ? prov.children : []).map((d) => ({ v: d.name, t: d.name }));
    const cit = prov && prov.children ? prov.children.find((c) => c.name === hC.value) : null;
    return (cit && cit.children ? cit.children : []).map((d) => ({ v: d.name, t: d.name }));
  }
  function selectedVal() {
    return step === 1 ? hR.value : step === 2 ? hP.value : step === 3 ? hC.value : hD.value;
  }
  // 直辖市/特区（如 北京市）省下直接是区县、没有「市」级 → 跳过市
  function cityLevelExists() {
    const prov = (districtData || []).find((p) => p.name === hP.value);
    return !!(prov && prov.children && prov.children.length && prov.children[0].children && prov.children[0].children.length);
  }
  function renderStep() {
    stepEl.textContent = STEP_TITLE[step];
    back.style.visibility = step > 1 ? "visible" : "hidden";
    const items = levelItems();
    const sel = selectedVal();
    col.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "cascade-empty";
      empty.textContent = step >= 3 ? "（无下级选项）" : "（无数据）";
      col.appendChild(empty);
      return;
    }
    items.forEach((it) => {
      const o = document.createElement("div");
      o.className = "cascade-opt" + (it.v === sel ? " selected" : "");
      o.textContent = it.t;
      o.addEventListener("click", (e) => { e.stopPropagation(); pick(it.v); });
      col.appendChild(o);
    });
  }
  function pick(val) {
    if (step === 1) {
      hR.value = val;
      if (val !== "中国大陆") { hP.value = ""; hC.value = ""; hD.value = ""; syncText(); close(); return; }
      step = 2;
    } else if (step === 2) {
      hP.value = val; hC.value = ""; hD.value = "";
      step = cityLevelExists() ? 3 : 4;
    } else if (step === 3) { hC.value = val; hD.value = ""; step = 4; }
    else if (step === 4) { hD.value = val; syncText(); close(); return; }
    syncText(); renderStep();
  }
  back.addEventListener("click", (e) => { e.stopPropagation(); if (step > 1) { step = (step === 4 && !cityLevelExists()) ? 2 : step - 1; renderStep(); } });
  function open() {
    loadDistricts().then(() => { step = startStep(); renderStep(); panel.hidden = false; trigger.classList.add("open"); });
  }
  trigger.addEventListener("click", (e) => { e.stopPropagation(); panel.hidden ? open() : close(); });
  document.addEventListener("click", (e) => { if (!container.contains(e.target)) close(); });
  // 初始值：优先用 basic 的省/市/区字段，否则用原 parseCascadeValue 解析 basic[key]
  hR.value = basic[regionKey] || "";
  hP.value = basic[provinceKey] || "";
  hC.value = basic[cityKey] || "";
  hD.value = basic[districtKey] || "";
  if (hP.value) { if (!hR.value) hR.value = "中国大陆"; syncText(); }
  else if (basic[key]) {
    loadDistricts().then((provinces) => {
      const p = parseCascadeValue(basic[key], provinces);
      hR.value = p.region || hR.value; hP.value = p.province || hP.value;
      hC.value = p.city || hC.value; hD.value = p.district || hD.value;
      syncText();
    });
  } else syncText();
}

/* 全局：点击空白处关闭所有打开的日历浮层（除点击所在的那个） */
let __monthCloseBound = false;
function ensureMonthClose() {
  if (__monthCloseBound) return;
  __monthCloseBound = true;
  document.addEventListener("click", (e) => {
    const inside = e.target.closest && e.target.closest(".month-single");
    document.querySelectorAll(".month-panel:not([hidden])").forEach((p) => {
      const single = p.closest(".month-single");
      if (single !== inside) {
        p.hidden = true;
        const t = single && single.querySelector(".month-trigger");
        if (t) t.classList.remove("open");
      }
    });
  });
}

/* ---------- 出生年月日历（年 → 月 → 日）---------- */
// 规范化日期字符串：网页端可能以 "2001.03.07" / "2019.09" / "2001年03月07日" 等形式传入，
// 日历控件内部按 "YYYY-MM-DD" 解析（split("-")），这里统一转成 dash 格式，
// 否则 "2001.03.07" 无法被 split("-") 识别，会一直显示「请选择 年 / 月 / 日」的空占位。
function normalizeDateStr(s) {
  if (!s) return "";
  const raw = String(s).trim();
  if (!/\d/.test(raw)) return raw; // 非日期串（如「至今」）原样保留，避免丢数据
  let t = raw.replace(/[.\/年月日]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  t = t.replace(/[^\d-]/g, "");
  const p = t.split("-").filter(Boolean);
  if (!p.length) return raw;
  const y = p[0];
  const m = p[1] ? String(p[1]).padStart(2, "0") : "";
  const d = p[2] ? String(p[2]).padStart(2, "0") : "";
  return [y, m, d].filter(Boolean).join("-");
}
function renderMonthPicker(container, key, current) {
  current = normalizeDateStr(current);
  container.classList.add("month-single");
  ensureMonthClose();
  container.innerHTML = `
    <div class="month-trigger"><span class="month-text"></span><span class="month-arrow">▾</span></div>
    <div class="month-panel" hidden>
      <div class="month-head"><span class="month-back">‹ 返回</span><span class="month-year"></span><span class="month-next">›</span></div>
      <div class="month-week" hidden></div>
      <div class="month-grid"></div>
    </div>
    <input type="hidden" data-key="${key}" value="${escapeHtml(current || "")}">
  `;
  const trigger = container.querySelector(".month-trigger");
  const panel = container.querySelector(".month-panel");
  const back = container.querySelector(".month-back");
  const yearEl = container.querySelector(".month-year");
  const next = container.querySelector(".month-next");
  const week = container.querySelector(".month-week");
  const grid = container.querySelector(".month-grid");
  const hidden = container.querySelector(`[data-key="${key}"]`);
  const textEl = container.querySelector(".month-text");
  const now = new Date();
  let step = "month";
  let viewYear = now.getFullYear();
  let viewMonth = 1;
  const cur = String(current || "").split("-");
  if (cur[0]) viewYear = parseInt(cur[0], 10) || viewYear;
  if (cur[1]) viewMonth = parseInt(cur[1], 10) || viewMonth;
  step = cur[2] ? "day" : "month";
  const pad = (n) => String(n).padStart(2, "0");
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

  function syncText() {
    const p = hidden.value.split("-");
    if (p[0] && p[1] && p[2]) { textEl.textContent = `${p[0]} 年 ${parseInt(p[1], 10)} 月 ${parseInt(p[2], 10)} 日`; textEl.classList.remove("placeholder"); }
    else if (p[0] && p[1]) { textEl.textContent = `${p[0]} 年 ${parseInt(p[1], 10)} 月`; textEl.classList.remove("placeholder"); }
    else { textEl.textContent = "请选择 年 / 月 / 日"; textEl.classList.add("placeholder"); }
  }
  function close() { panel.hidden = true; trigger.classList.remove("open"); }
  function renderMonth() {
    step = "month"; back.hidden = true; week.hidden = true; grid.classList.remove("show-day");
    yearEl.textContent = viewYear + " 年";
    next.textContent = "›"; next.title = "下一年";
    grid.innerHTML = "";
    for (let i = 1; i <= 12; i++) {
      const o = document.createElement("div");
      o.className = "month-opt" + (`${viewYear}-${pad(i)}` === hidden.value.slice(0, 7) ? " selected" : "");
      o.textContent = i + "月";
      o.addEventListener("click", () => { viewMonth = i; renderDay(); });
      grid.appendChild(o);
    }
  }
  function renderDay() {
    step = "day"; back.hidden = false; week.hidden = false; grid.classList.add("show-day");
    week.innerHTML = "";
    ["日", "一", "二", "三", "四", "五", "六"].forEach((w) => { const s = document.createElement("span"); s.textContent = w; week.appendChild(s); });
    yearEl.textContent = viewYear + " 年 " + viewMonth + " 月";
    next.textContent = "›"; next.title = "下一个月";
    const dim = daysInMonth(viewYear, viewMonth);
    const first = new Date(viewYear, viewMonth - 1, 1).getDay();
    grid.innerHTML = "";
    for (let i = 0; i < first; i++) { const e = document.createElement("div"); e.className = "month-opt empty"; grid.appendChild(e); }
    for (let d = 1; d <= dim; d++) {
      const val = `${viewYear}-${pad(viewMonth)}-${pad(d)}`;
      const o = document.createElement("div");
      o.className = "month-opt" + (val === hidden.value ? " selected" : "");
      o.textContent = d;
      o.addEventListener("click", () => { hidden.value = val; syncText(); close(); });
      grid.appendChild(o);
    }
  }
  function open() { (step === "day" ? renderDay : renderMonth)(); panel.hidden = false; trigger.classList.add("open"); }
  back.addEventListener("click", () => { renderMonth(); });
  next.addEventListener("click", () => { if (step === "month") viewYear++; else viewMonth = viewMonth % 12 + 1; (step === "month" ? renderMonth : renderDay)(); });
  trigger.addEventListener("click", () => { panel.hidden ? open() : close(); });
  syncText();
}

/* ---------- 编辑器 ---------- */
function clearEditor() {
  $("basicEditor").innerHTML = "";
  ["educationEditor", "internshipsEditor", "projectsEditor", "campusEditor", "languagesEditor", "socialEditor", "certificatesEditor", "papersEditor", "competitionsEditor", "skillsEditor", "awardsEditor", "patentsEditor"].forEach(
    (id) => ($(id).innerHTML = `<div class="empty-tip">暂无，可点上方「+ 添加」</div>`)
  );
  $("selfEvalEditor").value = "";
  renderKV("intentEditor", {}, INTENT_FIELDS);
  renderKV("referenceEditor", {}, REFERENCE_FIELDS);
  renderKV("aiSkillsEditor", {}, AI_SKILL_FIELDS);
  renderDevLang({});
}

function renderEditor(profile) {
  renderBasic(profile.basic || {});
  renderEducation(profile.education || []);
  renderList("internshipsEditor", profile.internships || [], INTERN_FIELDS);
  renderList("projectsEditor", profile.projects || [], PROJECT_FIELDS);
  // v0.8.x：项目「描述/职责/成果」三字段合并填充说明（小红字），避免用户误以为只填了某一项
  try {
    const pe = $("projectsEditor");
    if (pe && pe.querySelector(".edit-card")) {
      const hint = document.createElement("div");
      hint.className = "rfa-hint-red";
      hint.style.cssText = "color:#d23;font-size:12px;line-height:1.5;margin:8px 2px 4px;padding:6px 8px;background:#fff5f5;border:1px solid #f3c2c2;border-radius:6px;";
      hint.textContent = "提示：若招聘网站的项目只给一个文本框（不管它叫「项目描述」「工作职责」还是「项目成果」），插件会把「项目描述 + 项目职责 + 项目成果」三项内容合并填进这唯一一个框，保证你的项目经历最完整。";
      pe.appendChild(hint);
    }
  } catch (e) {}
  renderList("campusEditor", profile.campus || [], CAMPUS_FIELDS);
  renderList("papersEditor", profile.papers || [], PAPER_FIELDS);
  renderList("competitionsEditor", profile.competitions || [], COMPETITION_FIELDS);
  renderList("languagesEditor", profile.languages || [], LANGUAGE_FIELDS);
  renderList("socialEditor", profile.social || [], SOCIAL_FIELDS);
  renderList("certificatesEditor", profile.certificates || [], CERT_FIELDS);
  renderSkills(profile.skills || []);
  renderList("awardsEditor", profile.awards || [], AWARD_FIELDS);
  renderList("patentsEditor", profile.patents || [], PATENT_FIELDS);
  renderKV("intentEditor", profile.intent, INTENT_FIELDS);
  renderKV("referenceEditor", profile.reference, REFERENCE_FIELDS);
  renderKV("aiSkillsEditor", profile.aiSkills, AI_SKILL_FIELDS);
  renderDevLang(profile.devLang);
  $("selfEvalEditor").value = profile.selfEval || "";
  renderSyncedFiles();
}

// 展示网页端随同步传来的文件字节（base64），可下载到本机再上传招聘站
async function renderSyncedFiles(){
  const box = document.getElementById('syncedFilesList');
  if(!box) return;
  try{
    const st = await new Promise(res=>chrome.storage.local.get(['activeProfileId'], res));
    const aid = st.activeProfileId;
    const files = await new Promise(res=>chrome.storage.local.get(['rfa_files_'+aid], res));
    const map = files['rfa_files_'+aid] || {};
    const keys = Object.keys(map);
    if(!keys.length){ box.innerHTML = '<div class="empty-tip">尚未从网页同步文件（成绩单 / 作品 / 证书 / 专利等）。</div>'; return; }
    box.innerHTML = '';
    keys.forEach(k=>{
      const f = map[k];
      const wrap = document.createElement('div');
      wrap.className = 'edit-card';
      const label = k.split('|').slice(1).join(' / ');
      if(f.skip){
        wrap.innerHTML = `<div class="card-main"><div class="card-name">${escapeHtml(f.name||'文件')}</div><div class="card-sub">${label} · 超过 5MB 未同步，请手动上传到招聘站</div></div>`;
      } else {
        const info = document.createElement('div');
        info.className = 'card-main';
        info.innerHTML = `<div class="card-name">${escapeHtml(f.name||'文件')}</div><div class="card-sub">${label} · ${((f.size||0)/1024).toFixed(1)}KB</div>`;
        const a = document.createElement('a');
        a.className = 'btn btn-mini'; a.textContent = '⬇ 下载';
        a.href = 'data:'+(f.type||'application/octet-stream')+';base64,'+f.base64;
        a.setAttribute('download', f.name||'file');
        wrap.appendChild(info); wrap.appendChild(a);
      }
      box.appendChild(wrap);
    });
  }catch(e){ if(box) box.innerHTML = '<div class="empty-tip">读取同步文件失败</div>'; }
}

// 字段顺序 / 标签已对齐网页落地版 our-plugin-web-v4.html（2026-08-16 用户要求）
const BASIC_FIELDS = [
  { key: "name", label: "姓名" },
  { key: "gender", label: "性别", options: ["男", "女", "其他"] },
  { key: "birth", label: "出生年月" },
  { key: "phone", label: "手机号" },
  { key: "email", label: "邮箱" },
  { key: "location", label: "现居城市", cascade: true },
  { key: "politicalStatus", label: "政治面貌", options: ["中共党员", "共青团员", "群众", "民主党派", "无党派人士"] },
  { key: "targetPosition", label: "求职意向 / 目标岗位" },
  { key: "nationality", label: "国籍/地区", options: ["中国", "中国香港", "中国澳门", "中国台湾", "美国", "英国", "加拿大", "澳大利亚", "日本", "韩国", "新加坡", "其他"] },
  { key: "hometown", label: "家乡", cascade: true },
  { key: "idType", label: "证件类型", options: ["居民身份证", "港澳居民来往内地通行证", "护照", "永久居留证", "台湾居民来往大陆通行证", "香港身份证", "澳门身份证", "其他"] },
  { key: "idNumber", label: "证件号码" },
  { key: "ethnicity", label: "民族" },
  { key: "hobbies", label: "兴趣爱好" },
  { key: "qq", label: "QQ 号" },
  { key: "homepage", label: "个人主页 / 作品集链接" },
  { key: "wechat", label: "微信号" },
  { key: "emergencyContact", label: "紧急联系人姓名" },
  { key: "emergencyRelation", label: "与紧急联系人关系" },
  { key: "emergencyPhone", label: "紧急联系人电话" },
];
// ── v0.7.2：三个「单对象」板块 ─────────────────────────────────────────────────
// 这三块的填充映射在 content.js 里早就写好了（腾讯适配时加的），但档案界面一直没有录入口，
// 等于死代码：profile.intent / profile.reference / profile.aiSkills 永远是 undefined，
// 腾讯的期望城市、面试城市、证明人三连、AI 技能三连因此全部空着。补上录入口后才真正闭环。
// 字段顺序 / 标签已对齐网页落地版
const INTENT_FIELDS = [
  { key: "expectedCities", label: "期望城市", multi: true },
  { key: "availableFrom", label: "到岗时间" },
  { key: "internshipDuration", label: "可实习时长" },
  { key: "weeklyDays", label: "每周出勤" },
  { key: "interviewCity", label: "可面试城市" },
  { key: "expectedSalary", label: "期望薪资" },
  { key: "acceptOtherCities", label: "是否接受调剂", options: ["是", "否"] },
];
const REFERENCE_FIELDS = [
  { key: "name", label: "证明人姓名" },
  { key: "phone", label: "证明人联系电话" },
  { key: "identity", label: "证明人身份（如 实习主管 / 导师）" },
];
// 字段标签已对齐网页落地版
const AI_SKILL_FIELDS = [
  { key: "tools", label: "① 常用 AI 工具 & 模型" },
  { key: "collabProject", label: "② 与 AI 协作完成的项目或任务", textarea: true, full: true },
  { key: "link", label: "③ 相关项目或作品链接" },
];
const DEV_LANG_FIELDS = [
  { key: "langs", label: "擅长的开发语言" },
];
// 开发语言 / 技能 的预设常用项：点一下直接加标签，减少"该填什么"的混淆（2026-08-16 用户要求）
const DEV_LANG_PRESETS = ["Python", "C/C++", "Java", "JavaScript", "TypeScript", "Go", "C#", "SQL", "HTML/CSS", "Rust", "Swift", "Kotlin", "R", "MATLAB", "Shell", "PHP", "其他"];
const SKILL_PRESETS = ["Figma", "Photoshop", "Premiere", "剪映", "公众号排版", "小红书运营", "PR / 公众号运营", "Excel", "PPT", "数据分析", "短视频剪辑", "直播运营", "内容策划", "受众分析", "用户增长", "React", "Git", "Docker", "PyTorch", "文案写作", "SEO", "飞书", "Notion"];

// 单对象板块的通用渲染 / 收集，与 renderBasic 同构，避免为三个新板块各抄一份
function renderKV(containerId, obj, fields) {
  const c = $(containerId);
  if (!c) return;
  c.innerHTML = "";
  const data = obj || {};
  fields.forEach((f) => {
    const raw = data[f.key];
    const val = Array.isArray(raw) ? raw.join("、") : raw || "";
    const row = document.createElement("div");
    row.className = "field-row";
    if (f.full) row.classList.add("full");
    if (f.date) {
      row.innerHTML = `<label class="field-label">${f.label}</label><div class="month-single" data-month="${f.key}"></div>`;
      c.appendChild(row);
      renderMonthPicker(row.querySelector(".month-single"), f.key, val);
      return;
    }
    if (f.options) {
      row.innerHTML = `<label class="field-label">${f.label}</label>${buildSelectHtml(f, val)}`;
    } else if (f.textarea) {
      row.innerHTML = `<label class="field-label">${f.label}</label>
        <textarea class="edit-input edit-textarea" rows="3" data-key="${f.key}">${escapeHtml(val)}</textarea>`;
    } else {
      row.innerHTML = `<label class="field-label">${f.label}</label>
        <input class="edit-input" data-key="${f.key}" value="${escapeHtml(val)}">`;
    }
    c.appendChild(row);
  });
}

function collectKV(containerId, fields) {
  const out = {};
  const c = $(containerId);
  if (!c) return out;
  c.querySelectorAll("[data-key]").forEach((el) => {
    const v = (el.value || "").trim();
    if (!v) return;
    const f = fields.find((x) => x.key === el.dataset.key);
    out[el.dataset.key] = f && f.multi
      ? v.split(/[、,，;；]+/).map((s) => s.trim()).filter(Boolean)
      : v;
  });
  return out;
}

// 字段顺序 / 标签已对齐网页落地版（含新增「目前就读地」）
const EDU_FIELDS = [
  { key: "school", label: "学校" },
  { key: "major", label: "专业" },
  { key: "degree", label: "学历/学位", select: true, options: ["小学", "初中", "高中", "中专", "大专", "专科", "本科", "硕士", "博士", "MBA"] },
  { key: "eduType", label: "学习形式", select: true },
  { key: "start", label: "开始时间", date: true },
  { key: "end", label: "结束时间", date: true },
  { key: "college", label: "学院" },
  { key: "studyLocation", label: "目前就读地" },
  { key: "lab", label: "实验室" },
  { key: "tutor", label: "导师" },
  { key: "research", label: "研究方向" },
  { key: "rank", label: "成绩排名" },
  { key: "gpa", label: "绩点 GPA" },
  { key: "gpaBase", label: "满绩绩点" },
  { key: "transcript", label: "成绩单文件", file: true },
];
const EDU_SELECTS = {
  degree: ["大专", "本科", "硕士", "博士", "其他"],
  eduType: ["全日制", "非全日制", "统招", "自考", "成人教育", "网络教育", "在职"],
};
// 字段顺序 / 标签已对齐网页落地版
const INTERN_FIELDS = [
  { key: "company", label: "公司" },
  { key: "department", label: "部门" },
  { key: "title", label: "职务" },
  { key: "workType", label: "工作类型", options: ["实习", "兼职", "全职", "社会实践"] },
  { key: "start", label: "开始时间", date: true },
  { key: "end", label: "结束时间", date: true },
  { key: "responsibilities", label: "实习职责" },
  { key: "achievements", label: "实习成果" },
  { key: "description", label: "实习描述" },
];
// 字段顺序 / 标签已对齐网页落地版（链接移到职责/成果之后）
const PROJECT_FIELDS = [
  { key: "name", label: "项目名称" },
  { key: "role", label: "项目岗位" },
  { key: "start", label: "开始时间", date: true },
  { key: "end", label: "结束时间", date: true },
  { key: "responsibilities", label: "项目职责", textarea: true },
  { key: "achievements", label: "项目成果", textarea: true },
  { key: "link", label: "项目链接" },
  { key: "description", label: "项目描述", textarea: true },
];
// v0.6.71：「语言考试」和「考试分数」必须分开填。
// 招聘站（美团实测）是两个独立控件：考试是下拉、分数是纯数字校验的输入框。
// 过去合成一栏「CET-6 621」，分数框要么被塞进整串、要么读不出名字被填成语种名「英语」。
// v0.8.34：语种 → 语言考试 级联（覆盖英/日/韩/法/德/西/俄/阿/葡/意/泰/越/普通话等，含 CATTI 国内通用译考）。
const LANG_LIST = ["英语", "日语", "韩语", "法语", "德语", "西班牙语", "俄语", "阿拉伯语", "葡萄牙语", "意大利语", "泰语", "越南语", "普通话", "其他小语种", "其他"];
const LANG_EXAM_MAP = {
  "英语": ["CET-4", "CET-6", "TEM-4", "TEM-8", "TOEFL", "IELTS", "GRE", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "日语": ["JLPT N1", "JLPT N2", "JLPT N3", "JLPT N4", "JLPT N5", "J.TEST", "NAT-TEST", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "韩语": ["TOPIK 1级", "TOPIK 2级", "TOPIK 3级", "TOPIK 4级", "TOPIK 5级", "TOPIK 6级", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "法语": ["DELF A1", "DELF A2", "DELF B1", "DELF B2", "DALF C1", "DALF C2", "TEF", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "德语": ["TestDaF 3级", "TestDaF 4级", "TestDaF 5级", "Goethe A1", "Goethe A2", "Goethe B1", "Goethe B2", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "西班牙语": ["DELE A1", "DELE A2", "DELE B1", "DELE B2", "DELE C1", "DELE C2", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "俄语": ["TORFL 一级", "TORFL 二级", "TORFL 三级", "TORFL 四级", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "阿拉伯语": ["CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "葡萄牙语": ["CAPLE", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "意大利语": ["CELI", "CILS", "CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "泰语": ["CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "越南语": ["CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "普通话": ["普通话一级甲等", "普通话一级乙等", "普通话二级甲等", "普通话二级乙等", "普通话三级甲等", "普通话三级乙等"],
  "其他小语种": ["CATTI 三级", "CATTI 二级", "CATTI 一级"],
  "其他": ["CATTI 三级", "CATTI 二级", "CATTI 一级"]
};
const LANGUAGE_FIELDS = [
  { key: "name", label: "语种", options: LANG_LIST },
  { key: "level", label: "精通程度", options: ["母语", "无障碍商务沟通", "商务会话", "日常会话", "入门", "双语", "精通", "熟练", "良好", "一般"] },
  { key: "exam", label: "语言考试", cascadeFrom: "name", cascadeMap: LANG_EXAM_MAP, allowOther: true },
  { key: "score", label: "考试分数" },
];
// v0.6.71：美团新增板块，字段按页面实测顺序排列
// 字段顺序 / 标签已对齐网页落地版
const CAMPUS_FIELDS = [
  { key: "name", label: "校园经历名称" },
  { key: "role", label: "角色" },
  { key: "start", label: "开始时间", date: true },
  { key: "end", label: "结束时间", date: true },
  { key: "description", label: "校园经历描述", textarea: true },
];
// 字段顺序 / 标签已对齐网页落地版（新增「论文描述」）
const PAPER_FIELDS = [
  { key: "name", label: "论文名称" },
  { key: "venue", label: "发表渠道" },
  { key: "order", label: "作者顺序", options: ["第一作者", "第二作者", "第三作者", "第四作者", "第五作者", "独立作者", "通讯作者", "其他"] },
  { key: "impact", label: "影响因子" },
  { key: "link", label: "论文链接" },
  { key: "description", label: "论文描述", textarea: true },
];
// 字段顺序 / 标签已对齐网页落地版（新增「奖项类别」）
const COMPETITION_FIELDS = [
  { key: "name", label: "竞赛名称" },
  { key: "level", label: "获奖等级" },
  { key: "date", label: "获奖时间", date: true },
  { key: "category", label: "奖项类别" },
  { key: "description", label: "竞赛描述", textarea: true },
];
// 字段顺序 / 标签已对齐网页落地版
const SOCIAL_FIELDS = [
  { key: "platform", label: "平台" },
  { key: "account", label: "账号" },
  { key: "link", label: "链接" },
];
// 字段顺序 / 标签已对齐网页落地版（文件移到描述之前）
const CERT_FIELDS = [
  { key: "name", label: "证书名称" },
  { key: "date", label: "获得时间", date: true },
  { key: "file", label: "证书文件", file: true },
  { key: "description", label: "证书描述", textarea: true },
];
// 字段顺序 / 标签已对齐网页落地版（文件移到简介之前）
const PATENT_FIELDS = [
  { key: "type", label: "成果类型" },
  { key: "name", label: "成果名称" },
  { key: "regNo", label: "登记号" },
  { key: "date", label: "登记日期", date: true },
  { key: "rank", label: "发明人排名" },
  { key: "file", label: "专利文件", file: true },
  { key: "summary", label: "核心简介", textarea: true },
];
const SKILL_FIELDS = [{ key: "name", label: "技能" }];
// 字段顺序 / 标签已对齐网页落地版（奖项名称→获奖时间→奖项类别→级别→奖项描述）
const AWARD_FIELDS = [
  { key: "name", label: "奖项名称" },
  { key: "date", label: "获奖时间", date: true },
  { key: "category", label: "奖项类别", options: ["奖学金", "竞赛获奖", "评优表彰"] },
  { key: "level", label: "级别", options: ["国际级", "国家级", "省部级", "省级", "市级", "校级", "院系级", "企业级", "其他"] },
  { key: "description", label: "奖项描述", textarea: true },
];
const ALL_LIST_FIELDS = {
  education: EDU_FIELDS,
  internships: INTERN_FIELDS,
  projects: PROJECT_FIELDS,
  campus: CAMPUS_FIELDS,
  languages: LANGUAGE_FIELDS,
  social: SOCIAL_FIELDS,
  certificates: CERT_FIELDS,
  papers: PAPER_FIELDS,
  competitions: COMPETITION_FIELDS,
  skills: SKILL_FIELDS,
  awards: AWARD_FIELDS,
  patents: PATENT_FIELDS,
};

// 统一构造下拉框（替代原生 select，UI 与 webapp 一致）：隐藏 input 存值 + 自定义浮层
function buildSelectHtml(f, current) {
  const cur = current || "";
  if (f.allowOther) {
    const opts = (f.options || [])
      .map((o) => `<option value="${escapeHtml(o)}" ${o === current ? "selected" : ""}>${escapeHtml(o)}</option>`)
      .join("");
    return `<select class="edit-input" data-key="${f.key}"><option value="">（不填）</option>${opts}</select>`;
  }
  const opts = (f.options || []).map((o) => {
    const v = String(o);
    return `<span class="dd-opt${v === cur ? " selected" : ""}" data-v="${escapeHtml(v)}">${escapeHtml(v)}</span>`;
  }).join("");
  return `<span class="dd" data-dd="${f.key}">
    <input type="hidden" class="dd-val" data-key="${f.key}" value="${escapeHtml(cur)}">
    <span class="dd-trigger edit-input"><span class="dd-text${cur ? "" : " placeholder"}">${escapeHtml(cur) || "（不填）"}</span><span class="dd-arrow">▾</span></span>
    <span class="dd-panel" hidden><span class="dd-opt${"" === cur ? " selected" : ""}" data-v="">（不填）</span>${opts}</span>
  </span>`;
}
// 自定义下拉全局交互：点触发展开 / 点选项存值 / 点外部关闭
document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".dd-trigger");
  if (trigger) {
    const dd = trigger.closest(".dd");
    const panel = dd.querySelector(".dd-panel");
    const willOpen = panel.hidden;
    document.querySelectorAll(".dd-panel:not([hidden])").forEach((p) => { if (p !== panel) p.hidden = true; });
    document.querySelectorAll(".dd-trigger.open").forEach((t) => { if (t !== trigger) t.classList.remove("open"); });
    panel.hidden = !willOpen;
    trigger.classList.toggle("open", willOpen);
    e.stopPropagation();
    return;
  }
  const opt = e.target.closest(".dd-opt");
  if (opt) {
    const dd = opt.closest(".dd");
    const hidden = dd.querySelector(".dd-val");
    const text = dd.querySelector(".dd-text");
    const v = opt.getAttribute("data-v") || "";
    hidden.value = v;
    text.textContent = v || "（不填）";
    text.classList.toggle("placeholder", !v);
    dd.querySelectorAll(".dd-opt").forEach((o) => o.classList.remove("selected"));
    opt.classList.add("selected");
    dd.querySelector(".dd-panel").hidden = true;
    dd.querySelector(".dd-trigger").classList.remove("open");
    hidden.dispatchEvent(new Event("change"));
    e.stopPropagation();
    return;
  }
  document.querySelectorAll(".dd-panel:not([hidden])").forEach((p) => (p.hidden = true));
  document.querySelectorAll(".dd-trigger.open").forEach((t) => t.classList.remove("open"));
});

function renderBasic(basic) {
  const c = $("basicEditor");
  c.innerHTML = "";
  BASIC_FIELDS.forEach((f) => {
    const row = document.createElement("div");
    row.className = "field-row";
    if (f.key === "birth") {
      row.innerHTML = `<label class="field-label">${f.label}</label><div class="month-single" data-month="${f.key}"></div>`;
      c.appendChild(row);
      renderMonthPicker(row.querySelector(".month-single"), f.key, basic[f.key]);
      return;
    }
    // v0.8.13：手机号拆两格——左「区号」下拉（data-key=phoneCc）+ 右手机号（data-key=phone）。
    // 区号存进档案 basic.phoneCc（随简历版本走），保存/同步/填充自动跟随；不选=铁律（站点区号下拉留空提示手动确认）。
    if (f.key === "phone") {
      const ccVal = basic.phoneCc || "";
      const ccOpts = [["", "区号"], ["86", "+86"], ["852", "+852"], ["886", "+886"], ["1", "+1"], ["65", "+65"], ["81", "+81"], ["82", "+82"], ["44", "+44"], ["61", "+61"]]
        .map(([v, t]) => `<option value="${v}" ${v === ccVal ? "selected" : ""}>${t}</option>`).join("");
      row.innerHTML = `<label class="field-label">${f.label}</label>
        <div class="phone-split-wrap">
          <select class="cc-sel" data-key="phoneCc">${ccOpts}</select>
          <input class="edit-input" data-key="phone" value="${escapeHtml(basic.phone || "")}" placeholder="手机号">
        </div>
        <span class="phone-split-hint">选好区号后，填充时站点「手机号区号」下拉自动按它选；不选则档案没有就不动、留空提示手动确认。</span>`;
      c.appendChild(row);
      return;
    }
    if (f.cascade) {
      row.innerHTML = `<label class="field-label">${f.label}</label><div class="cascade-row" data-cascade="${f.key}"></div>`;
      c.appendChild(row);
      renderCascade(row.querySelector(".cascade-row"), f.key, basic);
    } else if (f.options) {
      row.innerHTML = `<label class="field-label">${f.label}</label>${buildSelectHtml(f, basic[f.key])}`;
      c.appendChild(row);
    } else {
      row.innerHTML = `<label class="field-label">${f.label}</label>
        <input class="edit-input" data-key="${f.key}" value="${escapeHtml(basic[f.key] || "")}">`;
      c.appendChild(row);
    }
    if (f.key === "idNumber") {
      const wn = document.createElement("div");
      wn.className = "warn-red";
      wn.textContent = "🔒 证件号码只保存在本机浏览器，AI 字段匹配时会自动脱敏、不会上传；填表由插件本地完成。不需要可留空。";
      c.appendChild(wn);
    }
  });
  const w = document.createElement("div");
  w.className = "warn-red";
  w.textContent = "⚠ 每次投递前请确认岗位是否一致，避免投错（例如投运营却填了算法岗）";
  c.appendChild(w);
}

function renderEducation(items) {
  const c = $("educationEditor");
  c.innerHTML = "";
  if (!items || !items.length) {
    c.innerHTML = `<div class="empty-tip">暂无，可点上方「+ 添加」</div>`;
    return;
  }
  items.forEach((it, i) => c.appendChild(createEduCard(it, i)));
  updateMoveButtons(c, ".edu-card");
}

function createEduCard(item, idx) {
  const card = document.createElement("div");
  card.className = "edu-card";
  const school = item.school || "";
  const major = item.major || "";
  const degree = item.degree || "";
  const eduType = item.eduType || "";
  const start = item.start || "";
  const end = item.end || "";
  const datePart = [start, end].filter(Boolean).join(" – ");
  const mainParts = [school, major, degree, eduType].filter(Boolean);
  const main = mainParts.length ? mainParts.join(" · ") : "（空教育经历）";
  const sub = datePart || "起止时间未填写";

  const fieldsHtml = EDU_FIELDS.map((f) => {
    const val = escapeHtml(item[f.key] || "");
    let input;
    if (f.select) {
      input = buildSelectHtml({ key: f.key, options: EDU_SELECTS[f.key] || [] }, item[f.key]);
    } else if (f.options) {
      input = buildSelectHtml(f, item[f.key]);
    } else if (f.textarea) {
      input = `<textarea class="edit-textarea" data-key="${f.key}">${val}</textarea>`;
    } else if (f.file) {
      const saved = item[f.key] || "";
      input = `<div class="file-widget">
        <div class="file-drop">点击上传（PDF / 图片）</div>
        <input type="file" class="card-file-input" accept=".pdf,.jpg,.jpeg,.png" style="display:none">
        <span class="file-name ${saved ? "ok" : "empty"}">${saved ? "✓ 已选择：" + escapeHtml(saved) : "未选择文件"}</span>
        <button class="btn-remove-file" type="button">× 移除</button>
        <input type="hidden" data-key="${f.key}" value="${escapeHtml(saved)}">
      </div>`;
    } else if (f.date) {
      input = `<div class="month-single" data-month="${f.key}"></div>`;
    } else {
      input = `<input class="edit-input" data-key="${f.key}" value="${val}" placeholder="${f.label}">`;
    }
    return `<div class="field-row"><label class="field-label">${f.label}</label>${input}</div>`;
  }).join("");

  card.innerHTML = `
    <div class="edu-summary">
      <div>
        <div class="edu-main">${escapeHtml(main)}</div>
        <div class="edu-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="edu-actions">
        <button class="btn-up-card" type="button" title="上移">↑</button>
        <button class="btn-down-card" type="button" title="下移">↓</button>
        <button class="edu-toggle" type="button">编辑</button>
        <button class="btn-del-small edu-del" type="button">删除</button>
      </div>
    </div>
    <div class="edu-edit">${fieldsHtml}</div>
  `;

  const summary = card.querySelector(".edu-summary");
  const edit = card.querySelector(".edu-edit");
  const toggle = card.querySelector(".edu-toggle");
  summary.addEventListener("click", (e) => {
    if (e.target.closest(".edu-actions")) return;
    edit.classList.toggle("open");
    toggle.textContent = edit.classList.contains("open") ? "收起" : "编辑";
  });
  toggle.addEventListener("click", () => {
    edit.classList.toggle("open");
    toggle.textContent = edit.classList.contains("open") ? "收起" : "编辑";
  });
  card.querySelector(".edu-del").addEventListener("click", () => card.remove());
  EDU_FIELDS.forEach((f) => {
    if (!f.date) return;
    const box = card.querySelector(`[data-month="${f.key}"]`);
    if (box) renderMonthPicker(box, f.key, item[f.key]);
  });
  return card;
}

function renderList(id, items, fields) {
  const c = $(id);
  c.innerHTML = "";
  if (!items || !items.length) {
    c.innerHTML = `<div class="empty-tip">暂无，可点上方「+ 添加」</div>`;
    return;
  }
  items.forEach((it, i) => c.appendChild(createCard(it, fields, i + 1)));
  updateMoveButtons(c, ".edit-card");
}
function createCard(item, fields, num) {
  const card = document.createElement("div");
  card.className = "edit-card";
  const titleLabel = (fields === SOCIAL_FIELDS) ? "社交账号" : fields[0].label;
  let html = `<div class="edit-card-header"><span class="edit-card-title">${titleLabel} #${num}</span><span class="card-acts"><button class="btn-up-card" type="button" title="上移">↑</button><button class="btn-down-card" type="button" title="下移">↓</button><button class="btn-del-small">删除</button></span></div>`;
  fields.forEach((f) => {
    const val = escapeHtml(item[f.key] || "");
    let input;
    if (f.file) {
      const saved = item[f.key] || "";
      input = `<div class="file-widget">
        <div class="file-drop">点击上传（PDF / 图片）</div>
        <input type="file" class="card-file-input" accept=".pdf,.jpg,.jpeg,.png" style="display:none">
        <span class="file-name ${saved ? "ok" : "empty"}">${saved ? "✓ 已选择：" + escapeHtml(saved) : "未选择文件"}</span>
        <button class="btn-remove-file" type="button">× 移除</button>
        <input type="hidden" data-key="${f.key}" value="${escapeHtml(saved)}">
      </div>`;
    } else if (f.options) {
      input = buildSelectHtml(f, item[f.key]);
      if (f.allowOther) {
        input += `<input class="edit-input other-input" data-other="${f.key}" placeholder="请填写具体${f.label}" style="display:none">`;
      }
    } else if (f.textarea) {
      input = `<textarea class="edit-textarea" data-key="${f.key}">${val}</textarea>`;
    } else if (f.date) {
      input = `<div class="month-single" data-month="${f.key}"></div>`;
    } else {
      input = `<input class="edit-input" data-key="${f.key}" value="${val}" placeholder="${f.label}">`;
    }
    html += `<div class="field-row"><label class="field-label">${f.label}</label>${input}</div>`;
  });
  card.innerHTML = html;
  fields.forEach((f) => {
    if (!f.date) return;
    const box = card.querySelector(`[data-month="${f.key}"]`);
    if (box) renderMonthPicker(box, f.key, item[f.key]);
  });
  // 级联下拉：源字段变化 → 目标字段选项联动（如 语种 → 语言考试）
  fields.forEach((f) => {
    if (f.cascadeFrom && f.cascadeMap) {
      const src = card.querySelector(`[data-key="${f.cascadeFrom}"]`);
      const tgt = card.querySelector(`[data-key="${f.key}"]`);
      if (src && tgt) {
        const rebuild = () => {
          const v = src.value;
          const list = f.cascadeMap[v] || f.cascadeMap["__default__"] || [];
          const cur = tgt.value;
          tgt.innerHTML = `<option value="">（不填）</option>` +
            list.map((o) => `<option ${o === cur ? "selected" : ""}>${o}</option>`).join("") +
            `<option value="其他">其他</option>`;
          tgt.dispatchEvent(new Event("change")); // 触发 allowOther 切换
        };
        src.addEventListener("change", rebuild);
        rebuild();
      }
    }
  });
  return card;
}
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("btn-add-foot") && e.target.dataset.section) addItem(e.target.dataset.section);
  if (e.target.classList.contains("btn-up-card")) moveCard(e.target.closest(".edit-card, .edu-card"), -1);
  if (e.target.classList.contains("btn-down-card")) moveCard(e.target.closest(".edit-card, .edu-card"), +1);
  if (e.target.classList.contains("btn-del-small")) {
    const card = e.target.closest(".edit-card");
    if (card) card.remove();
  }
  if (e.target.classList.contains("file-drop")) {
    const fi = e.target.parentElement.querySelector(".card-file-input");
    if (fi) fi.click();
  }
  if (e.target.classList.contains("btn-remove-file") && e.target.closest(".file-widget")) {
    const fw = e.target.closest(".file-widget");
    const hi = fw.querySelector("input[type=hidden]");
    if (hi) hi.value = "";
    const fn = fw.querySelector(".file-name");
    if (fn) { fn.textContent = "未选择文件"; fn.className = "file-name empty"; }
    const fi = fw.querySelector(".card-file-input");
    if (fi) fi.value = "";
  }
});
document.addEventListener("change", (e) => {
  if (e.target.classList.contains("card-file-input")) {
    const fw = e.target.closest(".file-widget");
    if (!fw) return;
    const f = e.target.files && e.target.files[0];
    const hi = fw.querySelector("input[type=hidden]");
    const fn = fw.querySelector(".file-name");
    if (f) {
      if (hi) hi.value = f.name;
      if (fn) { fn.textContent = "✓ 已选择：" + f.name; fn.className = "file-name ok"; }
    }
  }
});
// 把「+ 添加」按钮从板块标题右侧搬到板块内容末尾（整块宽、更醒目）
function relocateAddButtons() {
  document.querySelectorAll(".edit-title .btn-add-small").forEach((btn) => {
    const group = btn.closest(".edit-group");
    const title = btn.closest(".edit-title");
    if (!group || !title) return;
    // 找到该板块的编辑器容器（标题之后的 .edit-list / 带 Editor 的 div）
    let editor = title.nextElementSibling;
    while (editor && !editor.classList.contains("edit-list") && !/Editor$/.test(editor.id)) {
      editor = editor.nextElementSibling;
    }
    if (!editor) editor = group.querySelector(".edit-list");
    const foot = document.createElement("div");
    foot.className = "add-foot";
    // 移动原节点（appendChild 会保留节点及其已绑定的事件监听），不要用新建节点替换，
    // 否则原按钮上的 click 监听（如作品集 addWorkBtn 的「+ 添加」）会随旧节点被移除而失效。
    btn.classList.add("btn-add-foot");
    btn.classList.remove("btn-add-small");
    btn.textContent = "＋ 添加一条";
    foot.appendChild(btn);
    if (editor && editor.parentNode) editor.parentNode.insertBefore(foot, editor.nextSibling);
    else group.appendChild(foot);
  });
}

// 滚动高亮（scroll-spy）：横向导航条随滚动联动高亮
// ① 顶部主板块（简历PDF / 详细文档 / 档案 / 反馈）随滚动依次点亮；
// ② 进入「档案」后，其内部细分板块（基本信息…自我评价）依次点亮；
// ③ 横向导航条自动把当前激活项滚入可视区，避免被遮挡。
// 用「滚动位置」而非 IntersectionObserver 判定，语义单调（越往下只前进不后退），绝不横跳。
function initScrollSpy() {
  const nav = document.getElementById("anchorNav");
  if (!nav) return;
  const allLinks = Array.from(nav.querySelectorAll("a"));
  const navMap = {};
  allLinks.forEach((a) => {
    const h = a.getAttribute("href") || "";
    if (h.charAt(0) === "#" && h.length > 1) navMap[h.slice(1)] = a;
  });
  const mainLinks = allLinks.filter((a) => !a.classList.contains("sub"));
  const subLinks = allLinks.filter((a) => a.classList.contains("sub"));
  const topEls = mainLinks.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
  const subEls = subLinks.map((a) => document.getElementById(a.getAttribute("href").slice(1))).filter(Boolean);
  if (!topEls.length) return;

  const spyBox = document.getElementById("mainBody") || document.querySelector(".body");
  let curTop = "";
  let curSub = "";

  function setActiveEl(id, on) {
    const a = navMap[id];
    if (a) a.classList.toggle("active", on);
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", on);
  }
  // 横向导航条：把当前激活项**居中**于导航条可视区（用户明确要「中间高亮」那版）。
  // 绝不调用 scrollIntoView/scrollTo 等会改动垂直滚动的 API（铁律 08-13：scroll-spy 回调里绝对不能动垂直滚动位置）。
  function centerNavItem(act) {
    if (!nav || !act) return;
    const navRect = nav.getBoundingClientRect();
    const aRect = act.getBoundingClientRect();
    const target = aRect.left - navRect.left + nav.scrollLeft - (navRect.width - aRect.width) / 2;
    nav.scrollLeft = Math.max(0, target);
  }
  function apply() {
    const inProfile = curTop === "section-profile";
    topEls.forEach((g) => setActiveEl(g.id, !inProfile && g.id === curTop));
    subEls.forEach((g) => setActiveEl(g.id, inProfile && g.id === curSub));
    const act = inProfile ? (navMap[curSub] || null) : (navMap[curTop] || null);
    if (act) centerNavItem(act);
  }
  function compute() {
    const cr = spyBox ? spyBox.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const line = cr.top + (cr.bottom - cr.top) * 0.4; // 板块头部划到视口 40% 处即点亮
    let t = topEls[0] ? topEls[0].id : "";
    for (const g of topEls) { if (g.getBoundingClientRect().top <= line) t = g.id; }
    let s = "";
    if (t === "section-profile") {
      // 纯位置判定（无状态机）：最后一个「头部已越过 40% 线」的子板块即当前激活项。
      // 过渡区间（当前子板块已越过、下一个还没到）s 自然保持为刚越过的那个，绝不回退到最前「基本信息」。
      // 仅当档案区最顶部、尚无任何子板块越过线时 s 才为空 -> 落到首个子板块「基本信息」（属正常顶端态，非回跳）。
      for (const g of subEls) { if (g.getBoundingClientRect().top <= line) s = g.id; }
      if (!s && subEls.length) s = subEls[0].id;
    }
    if (t !== curTop || s !== curSub) { curTop = t; curSub = s; apply(); }
  }
  const scroller = spyBox || window;
  scroller.addEventListener("scroll", compute, { passive: true });
  // 兜底轮询：无论滚动发生在哪个容器（或内容异步渲染），高亮始终跟随
  setInterval(compute, 200);
  compute();
}

function addItem(section) {
  const fields = ALL_LIST_FIELDS[section];
  if (!fields) return;
  const id = section + "Editor";
  const c = $(id);
  if (c.querySelector(".empty-tip")) c.innerHTML = "";
  if (section === "skills") {
    const inp = c.querySelector(".skill-input");
    if (inp) inp.focus();
    return;
  }
  if (section === "education") {
    c.appendChild(createEduCard({}, c.querySelectorAll(".edu-card").length + 1));
    updateMoveButtons(c, ".edu-card");
  } else {
    c.appendChild(createCard({}, fields, c.querySelectorAll(".edit-card").length + 1));
    updateMoveButtons(c, ".edit-card");
  }
}
// 列表卡片排序：上移/下移（竞品核心能力；多段教育/实习控制顺序是大厂网申刚需）
function moveCard(card, dir) {
  if (!card) return;
  const container = card.parentElement;
  const sel = card.classList.contains("edu-card") ? ".edu-card" : ".edit-card";
  const sibs = Array.from(container.querySelectorAll(sel));
  const i = sibs.indexOf(card);
  const j = i + dir;
  if (j < 0 || j >= sibs.length) return;
  if (dir < 0) container.insertBefore(card, sibs[j]);
  else container.insertBefore(card, sibs[j].nextSibling);
  renumberCards(container, sel);
  updateMoveButtons(container, sel);
}
function renumberCards(container, sel) {
  if (sel !== ".edit-card") return; // 教育卡为折叠式，无序号，按 DOM 顺序即可
  container.querySelectorAll(".edit-card").forEach((c, i) => {
    const t = c.querySelector(".edit-card-title");
    if (t) {
      const label = t.textContent.replace(/ #\d+$/, "");
      t.textContent = label + " #" + (i + 1);
    }
  });
}
function updateMoveButtons(container, sel) {
  const cards = Array.from(container.querySelectorAll(sel));
  cards.forEach((c, i) => {
    const up = c.querySelector(".btn-up-card");
    const down = c.querySelector(".btn-down-card");
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === cards.length - 1;
  });
}
function collectProfileFromEditor() {
  const basic = {};
  $("basicEditor").querySelectorAll("[data-key]").forEach((el) => (basic[el.dataset.key] = el.value.trim()));
  // 把国家/地区/省/市/区四级选择器拼成 location / hometown
  // 如 "中国大陆/四川省/成都市/锦江区"，港澳台如 "中国香港"
  ["location", "hometown"].forEach((key) => {
    const region = basic[key + "Region"] || "";
    const province = basic[key + "Province"] || "";
    const city = basic[key + "City"] || "";
    const district = basic[key + "District"] || "";
    const parts = [region, province, city, district].filter(Boolean);
    if (parts.length) basic[key] = parts.join("/");
  });
  const education = collectEducation();
  const internships = collectList("internshipsEditor", INTERN_FIELDS);
  const projects = collectList("projectsEditor", PROJECT_FIELDS);
  const campus = collectList("campusEditor", CAMPUS_FIELDS);
  const papers = collectList("papersEditor", PAPER_FIELDS);
  const competitions = collectList("competitionsEditor", COMPETITION_FIELDS);
  const languages = collectList("languagesEditor", LANGUAGE_FIELDS);
  const social = collectList("socialEditor", SOCIAL_FIELDS);
  const certificates = collectList("certificatesEditor", CERT_FIELDS);
  const skills = collectSkills();
  const awards = collectList("awardsEditor", AWARD_FIELDS);
  return {
    basic,
    education,
    internships,
    projects,
    campus,
    languages,
    social,
    certificates,
    papers,
    competitions,
    skills,
    awards,
    patents: collectList("patentsEditor", PATENT_FIELDS),
    selfEval: $("selfEvalEditor").value.trim(),
    // v0.7.2：三个单对象板块（求职意向 / 资料证明人 / AI 应用技能）
    intent: collectKV("intentEditor", INTENT_FIELDS),
    reference: collectKV("referenceEditor", REFERENCE_FIELDS),
    aiSkills: collectKV("aiSkillsEditor", AI_SKILL_FIELDS),
    devLang: collectDevLang(),
  };
}
function collectEducation() {
  const arr = [];
  $("educationEditor").querySelectorAll(".edu-card").forEach((card) => {
    const item = {};
    let has = false;
    card.querySelectorAll(".edu-edit [data-key]").forEach((el) => {
      const v = el.value.trim();
      item[el.dataset.key] = v;
      if (v) has = true;
    });
    if (has) arr.push(item);
  });
  return arr;
}
function collectList(id, fields) {
  const arr = [];
  $(id).querySelectorAll(".edit-card").forEach((card) => {
    const item = {};
    let has = false;
    card.querySelectorAll("[data-key]").forEach((el) => {
      const v = el.value.trim();
      item[el.dataset.key] = v;
      if (v) has = true;
    });
    // allowOther：下拉选了“其他”时，用自由输入框的内容覆盖
    (fields || []).forEach((f) => {
      if (f.allowOther) {
        const sel = card.querySelector(`select[data-key="${f.key}"]`);
        const other = card.querySelector(`[data-other="${f.key}"]`);
        if (sel && sel.value === "其他" && other && other.value.trim()) {
          item[f.key] = other.value.trim();
        }
      }
    });
    if (has) arr.push(item);
  });
  return arr;
}
function makeSkillChip(name) {
  const chip = document.createElement("span");
  chip.className = "skill-chip";
  chip.appendChild(document.createTextNode(name));
  const x = document.createElement("button");
  x.type = "button"; x.textContent = "×"; x.title = "删除";
  x.addEventListener("click", () => chip.remove());
  chip.appendChild(x);
  return chip;
}
function renderSkills(items) {
  const c = $("skillsEditor");
  if (!c) return;
  c.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "skill-tags";
  (items || []).forEach((s) => {
    const name = typeof s === "string" ? s : (s && s.name) || "";
    if (name) wrap.appendChild(makeSkillChip(name));
  });
  const input = document.createElement("input");
  input.className = "skill-input";
  input.placeholder = "输入技能后回车添加";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      if (v) { wrap.insertBefore(makeSkillChip(v), input); input.value = ""; }
    }
  });
  wrap.appendChild(input);
  c.appendChild(wrap);
  c.appendChild(buildSugRow(SKILL_PRESETS, wrap, input));
}
function renderDevLang(obj) {
  const c = $("devLangEditor");
  if (!c) return;
  c.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "skill-tags";
  const seed = (obj && obj.langs ? String(obj.langs) : "");
  seed.split(/[、,，;；]+/).map((s) => s.trim()).filter(Boolean).forEach((name) => {
    if (name) wrap.appendChild(makeSkillChip(name));
  });
  const input = document.createElement("input");
  input.className = "skill-input";
  input.placeholder = "输入开发语言后回车添加";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      if (v) { wrap.insertBefore(makeSkillChip(v), input); input.value = ""; }
    }
  });
  wrap.appendChild(input);
  c.appendChild(wrap);
  c.appendChild(buildSugRow(DEV_LANG_PRESETS, wrap, input));
}
// 预设常用项：点一下把该项加为标签（去重）；targetWrap 里 label 在 input 之前
function buildSugRow(presets, targetWrap, input) {
  const row = document.createElement("div");
  row.className = "sug-row";
  const lab = document.createElement("span");
  lab.className = "sug-label";
  lab.textContent = "常用：";
  row.appendChild(lab);
  presets.forEach((p) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "sug-chip";
    chip.textContent = p;
    chip.addEventListener("click", () => {
      const exists = Array.from(targetWrap.querySelectorAll(".skill-chip")).some(
        (ch) => (ch.firstChild ? ch.firstChild.textContent : "").trim() === p
      );
      if (!exists) targetWrap.insertBefore(makeSkillChip(p), input);
    });
    row.appendChild(chip);
  });
  return row;
}
function collectDevLang() {
  const arr = [];
  const c = $("devLangEditor");
  if (!c) return { langs: "" };
  c.querySelectorAll(".skill-chip").forEach((chip) => {
    const t = (chip.firstChild ? chip.firstChild.textContent : "").trim();
    if (t) arr.push(t);
  });
  return { langs: arr.join("、") };
}
function collectSkills() {
  const arr = [];
  const c = $("skillsEditor");
  if (!c) return arr;
  c.querySelectorAll(".skill-chip").forEach((chip) => {
    const t = (chip.firstChild ? chip.firstChild.textContent : "").trim();
    if (t) arr.push(t);
  });
  return arr;
}

/* ---------- 工具 ---------- */
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function setStatus(id, text, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = "status " + (type || "");
}

/* ---------- 文档文本提取 ---------- */
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  return text;
}
async function extractDocxText(buf) {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  // 先扫描收集所有本地文件头偏移（逐字节扫描，绝不会因偏移算错而漏掉条目）
  const headers = [];
  let o = 0;
  while (o < bytes.length - 4) {
    if (dv.getUint32(o, true) === 0x04034b50) {
      const fnLen = dv.getUint16(o + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(o + 30, o + 30 + fnLen));
      headers.push({ o, name });
      o += 4;
    } else {
      o++;
    }
  }
  for (const h of headers) {
    if (h.name !== "word/document.xml") continue;
    const method = dv.getUint16(h.o + 8, true);
    const compSize = dv.getUint32(h.o + 18, true);
    const fnLen = dv.getUint16(h.o + 26, true);
    const extraLen = dv.getUint16(h.o + 28, true);
    const dataStart = h.o + 30 + fnLen + extraLen;
    let data;
    if (method === 0) data = bytes.subarray(dataStart, dataStart + compSize);
    else {
      try { data = await inflateRaw(bytes.subarray(dataStart, dataStart + compSize)); }
      catch (e) { continue; }
    }
    let docXml = new TextDecoder().decode(data);
    // 保留段落/表格/换行结构：先把结构标记换成分隔符，再整体去标签（分隔符保留）
    docXml = docXml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<w:cr\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n");
    let text = docXml.replace(/<[^>]+>/g, "");
    // 解码 XML 实体（&amp; 必须最后解，避免双重解码）
    text = text
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
      .replace(/&amp;/g, "&");
    // 压缩多余空白/空行，减少噪声
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return text;
  }
  return "";
}
async function inflateRaw(uint8) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Response(uint8).body.pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}
