// 网页悬浮助手（小球）显隐开关：通过消息通道切换当前页面 content.js 的内存态。
// × 只是「当前页临时隐藏」，刷新网页后小球会自动出现，所以这里的开关也只是切换当前页可见性。
// 独立成文件：MV3 默认 CSP 禁止 popup.html 内联 <script>，内联会报 "Refused to execute inline script"。
(function () {
  var btn = document.getElementById("fabToggleBtn");
  var status = document.getElementById("fabToggleStatus");
  if (!btn) return;
  function setUI(hidden) {
    btn.textContent = hidden ? "显示悬浮助手" : "隐藏悬浮助手";
    if (status) status.textContent = hidden ? "当前：已隐藏" : "当前：已显示";
  }
  function activeTab(cb) {
    try { chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { cb(tabs && tabs[0]); }); }
    catch (e) { cb(null); }
  }
  // 打开弹窗时读取当前页面的真实状态
  activeTab(function (tab) {
    if (!tab || tab.id == null) return;
    try {
      chrome.tabs.sendMessage(tab.id, { action: "rfa_get_fab_state" }, function (r) {
        if (chrome.runtime.lastError) return;
        if (r) setUI(!!r.hidden);
      });
    } catch (e) {}
  });
  btn.addEventListener("click", function () {
    activeTab(function (tab) {
      if (!tab || tab.id == null) { if (status) status.textContent = "（请先打开一个网页）"; return; }
      try {
        chrome.tabs.sendMessage(tab.id, { action: "rfa_toggle_fab" }, function (r) {
          if (chrome.runtime.lastError) { if (status) status.textContent = "（该页面未加载助手）"; return; }
          if (r) setUI(!!r.hidden);
        });
      } catch (e) {}
    });
  });
})();
