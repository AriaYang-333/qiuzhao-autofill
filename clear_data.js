/*
 * clear_data.js — 插件「一键清空」核心逻辑（4 档）
 *
 * 设计目标：
 *  1. 纯逻辑、可测试：不依赖 chrome.* / DOM，所有浏览器原语通过 deps 注入；
 *     因此可以在 node 里用 mock storage 做完整单测（见 clear_data.test.js）。
 *  2. 生产可直接复用：popup.js 通过 <script src="clear_data.js"> 引入，
 *     拿到 window.RFAClear.clearStorageTier，把真实 chrome/popup 原语注入即可。
 *
 * 四档定义（对齐需求）：
 *   tier 1 只清临时缓存    —— 删 lastOpenPing / updateDismissed / rfaTemp* 等临时键，
 *                             不动任何用户数据（档案/作品/文件/已填）。
 *   tier 2 清某站已填      —— 只清空【当前招聘网页】的表单字段（向 content script 发 clearPage），
 *                             不动插件本地数据。因为"已填"数据存在站点服务器，插件只能清自己这边的网页。
 *   tier 3 清全部已填      —— 清空档案数据(profiles[active].data=null) + 作品(works=[]) + 网页表单，
 *                             但【保留】简历PDF/证件照(fileVault) / API Key / 设置。
 *   tier 4 恢复出厂        —— 全清：档案 + 作品 + 文件仓库(删分片) + API Key + 设置 + 临时缓存 + 网页表单。
 */
(function (global) {
  'use strict';

  // 临时缓存键（非用户数据，可随时安全清）
  const TEMP_KEYS = ['lastOpenPing', 'updateDismissed'];

  // 任何以这些前缀开头的 key 都视为临时缓存
  const TEMP_PREFIX_RE = /^rfa(Temp|Cache|Session|Log|Last|Fill|Probe|Debug|Test)/;

  function isTempKey(k) {
    if (!k || typeof k !== 'string') return false;
    return TEMP_KEYS.indexOf(k) !== -1 || TEMP_PREFIX_RE.test(k);
  }

  // 各档的执行计划（声明式，便于单测断言）
  function planTier(tier) {
    switch (tier) {
      case 1:
        return { temp: true, profile: false, works: false, fileVault: false, apiKey: false, options: false, sendPage: false };
      case 2:
        return { temp: false, profile: false, works: false, fileVault: false, apiKey: false, options: false, sendPage: true };
      case 3:
        return { temp: false, profile: true, works: true, fileVault: false, apiKey: false, options: false, sendPage: true };
      case 4:
        return { temp: true, profile: true, works: true, fileVault: true, apiKey: true, options: true, sendPage: true };
      default:
        throw new Error('未知清空档位: ' + tier + '（应为 1/2/3/4）');
    }
  }

  /*
   * clearStorageTier(tier, deps) -> Promise<{ tier, removed: string[] }>
   *
   * deps（浏览器原语，node 单测里全部 mock）：
   *   storage: {
   *     get(keys)   -> Promise<obj>      // keys: null=全量, string, string[], 或 {key:''} 形式
   *     set(obj)    -> Promise
   *     remove(keys)-> Promise           // keys: string | string[]
   *   }
   *   sendToPage(msg, payload, cb)        // 可选；清网页表单（tier2/3/4）。失败不应抛。
   *   deleteFragmentedFile(key) -> Promise  // 可选；删分片文件（tier4 清 fileVault）。
   *   getActiveProfileId() -> Promise<string|null>  // 可选；定位要清的 profile。
   */
  async function clearStorageTier(tier, deps) {
    if (!deps || !deps.storage) throw new Error('clearStorageTier 需要 deps.storage');
    const plan = planTier(tier);
    const storage = deps.storage;
    const removed = [];

    // 1) 临时缓存
    if (plan.temp) {
      const all = await storage.get(null);
      const tempKeys = Object.keys(all || {}).filter(isTempKey);
      if (tempKeys.length) {
        await storage.remove(tempKeys);
        removed.push.apply(removed, tempKeys);
      }
    }

    // 2) 档案数据（只清 active profile 的 data，不删 profile 本身）
    if (plan.profile) {
      const r = await storage.get(['profiles', 'activeProfileId']);
      const profiles = Array.isArray(r.profiles) ? r.profiles : [];
      let apId = r.activeProfileId;
      if ((apId === null || apId === undefined) && deps.getActiveProfileId) {
        apId = await deps.getActiveProfileId();
      }
      const ap = profiles.find((x) => x && x.id === apId);
      if (ap) ap.data = null;
      await storage.set({ profiles });
      removed.push('profiles.data');
    }

    // 3) 作品
    if (plan.works) {
      await storage.set({ works: [] });
      removed.push('works');
    }

    // 4) 文件仓库（先删分片，再清空对象）
    if (plan.fileVault) {
      const r = await storage.get('fileVault');
      const vault = (r && r.fileVault) || {};
      const cats = Object.keys(vault);
      for (const cat of cats) {
        const v = vault[cat];
        if (v && v.storageKey && typeof deps.deleteFragmentedFile === 'function') {
          try { await deps.deleteFragmentedFile(v.storageKey); } catch (e) { /* 忽略单文件删除失败 */ }
        }
      }
      await storage.set({ fileVault: {} });
      removed.push('fileVault');
    }

    // 5) 密钥 / 设置
    if (plan.apiKey) {
      await storage.remove('apiKey');
      removed.push('apiKey');
    }
    if (plan.options) {
      await storage.remove(['options', 'shareData', 'rfa_phone_cc']);
      removed.push('options', 'shareData', 'rfa_phone_cc');
    }

    // 6) 网页表单（清当前招聘页已填字段）
    // sendToPage 契约：调用方传入 (msg, payload, cb)，实现应在完成/失败时调用 cb。
    // 加 setTimeout 兜底，避免实现未调用 cb 时永久挂起。
    if (plan.sendPage && typeof deps.sendToPage === 'function') {
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        try { deps.sendToPage('clearPage', {}, fin); } catch (e) { fin(); }
        setTimeout(fin, 0);
      });
      removed.push('page');
    }

    return { tier, removed };
  }

  const RFAClear = { clearStorageTier, planTier, isTempKey, TEMP_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = RFAClear;
  global.RFAClear = RFAClear;
})(typeof window !== 'undefined' ? window : globalThis);
