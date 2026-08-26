// 防「打开弹窗先闪一下再跳到上次位置」：在浏览器恢复滚动/焦点【之前】就关掉它。
// 必须放在 head 外部脚本、内容渲染前执行，写在 popup.js 的 DOMContentLoaded 里就太晚了。
// 注：MV3 CSP 禁止 popup.html 内联脚本，所以单独成文件用 <script src="popup-head.js"> 引入。
try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}

// —— 滚动锁（独立于 popup.js，即便 popup.js 报错也照装，彻底干掉跳动）——
// 关键改进：用 rAF 每帧强制归零（压住 scrollIntoView 平滑滚动那种逐帧覆盖式跳动），
// 并在锁定期内禁用 scrollIntoView（让任何 scrollIntoView 调用变空操作），
// 只在用户【主动】滚动/点击时才解锁（不再有定时自动解锁，避免漏掉延迟滚动）。
(function lockScrollTopHead() {
  function install() {
    var mb = document.getElementById("mainBody");
    var locked = true;

    // 锁定期内：禁用 Element.prototype.scrollIntoView，让所有平滑/非平滑跳转都失效
    var origScrollIntoView = null;
    if (typeof Element !== "undefined" && Element.prototype && Element.prototype.scrollIntoView) {
      origScrollIntoView = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function () { /* locked: no-op */ };
    }
    // 锁定期内：把 focus() 改成 preventScroll，掐断「浏览器恢复焦点 → 自动滚下去」这条根因
    var origFocus = null;
    if (typeof HTMLElement !== "undefined" && HTMLElement.prototype && HTMLElement.prototype.focus) {
      origFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (opts) {
        try { return origFocus.call(this, Object.assign({}, opts, { preventScroll: true })); } catch (e) {
          try { return origFocus.call(this); } catch (e2) {}
        }
      };
    }

    // rAF 每帧强制归零：无论滚动来自浏览器恢复、焦点恢复还是 scrollIntoView 动画，
    // 每一帧都被拉回 0，肉眼看不到任何滑动。同时持续 blur 残留焦点，双管齐下根绝焦点滚动。
    var rafId = 0;
    function tick() {
      if (!locked) return;
      if (mb && mb.scrollTop !== 0) mb.scrollTop = 0;
      if (window.scrollY) try { window.scrollTo(0, 0); } catch (e) {}
      // 持续清掉浏览器恢复出来的焦点（焦点是「自动下滑」的真正推手）
      try { if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    function unlock() {
      if (!locked) return;
      locked = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (origScrollIntoView) Element.prototype.scrollIntoView = origScrollIntoView; // 恢复正常滚动能力
      if (origFocus) HTMLElement.prototype.focus = origFocus;
    }
    // 用户任何主动输入才解锁（让正常滚动/锚点跳转恢复生效）
    ["pointerdown", "wheel", "touchmove", "keydown"].forEach(function (ev) {
      if (mb) mb.addEventListener(ev, unlock, { once: true, passive: true });
      window.addEventListener(ev, unlock, { once: true, passive: true });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();

document.addEventListener("DOMContentLoaded", function () {
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
  var mb = document.getElementById("mainBody");
  if (mb) mb.scrollTop = 0;
  if (document.documentElement) document.documentElement.scrollTop = 0;
  if (document.body) document.body.scrollTop = 0;
  window.scrollTo(0, 0);
});
