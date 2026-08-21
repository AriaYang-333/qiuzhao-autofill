const STATUS_OPTS = ["已投递", "简历过筛", "一面", "二面", "三面", "终面", "Offer", "已挂", "放弃"];
    let apps = [];

    function $(id) { return document.getElementById(id); }

    function loadApps() {
      chrome.storage.local.get("applications", (r) => {
        apps = r.applications || [];
        render();
      });
    }
    function saveApps() {
      chrome.storage.local.set({ applications: apps });
    }

    function formatDate(d) {
      const now = d ? new Date(d) : new Date();
      return now.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function render() {
      const q = ($("searchInput").value || "").trim().toLowerCase();
      const filtered = apps.filter((a) =>
        !q ||
        (a.company || "").toLowerCase().includes(q) ||
        (a.position || "").toLowerCase().includes(q) ||
        (a.status || "").toLowerCase().includes(q)
      );

      $("appTable").innerHTML = "";
      $("empty").style.display = filtered.length ? "none" : "block";

      // stats
      const counts = {};
      STATUS_OPTS.forEach((s) => (counts[s] = 0));
      apps.forEach((a) => { if (counts[a.status] !== undefined) counts[a.status]++; });
      const total = apps.length;
      const active = total - (counts["已挂"] || 0) - (counts["放弃"] || 0);
      $("stats").innerHTML = `
        <div class="stat">总投递 <b>${total}</b></div>
        <div class="stat">进行中 <b>${active}</b></div>
        <div class="stat">Offer <b>${counts["Offer"] || 0}</b></div>
        <div class="stat">已挂 <b>${counts["已挂"] || 0}</b></div>
      `;

      filtered.forEach((app) => {
        const tr = document.createElement("tr");
        const statusOpts = STATUS_OPTS.map((s) => `<option ${s === app.status ? "selected" : ""}>${s}</option>`).join("");
        tr.innerHTML = `
          <td>${formatDate(app.time)}</td>
          <td><input value="${escapeHtml(app.company)}" data-f="company"></td>
          <td><input value="${escapeHtml(app.position)}" data-f="position"></td>
          <td><select data-f="status">${statusOpts}</select></td>
          <td class="link-cell">${renderLink(app.url)}</td>
          <td><button class="del-btn" data-id="${app.id}">删除</button></td>
        `;
        tr.querySelectorAll("[data-f]").forEach((el) => {
          el.addEventListener("change", () => { app[el.dataset.f] = el.value; saveApps(); render(); });
        });
        const urlTd = tr.querySelector(".link-cell");
        urlTd.addEventListener("click", () => {
          const newUrl = prompt("修改投递链接：", app.url || "");
          if (newUrl !== null) { app.url = newUrl; saveApps(); render(); }
        });
        tr.querySelector(".del-btn").addEventListener("click", () => {
          apps = apps.filter((a) => a.id !== app.id);
          saveApps();
          render();
        });
        $("appTable").appendChild(tr);
      });
    }

    function renderLink(url) {
      if (!url) return `<span style="color:#999">点击添加链接</span>`;
      const short = escapeHtml(url.length > 35 ? url.slice(0, 32) + "…" : url);
      return `<a href="${escapeHtml(url)}" target="_blank" class="link-short" title="${escapeHtml(url)}">${short}</a>`;
    }

    $("addBtn").addEventListener("click", () => {
      apps.unshift({ id: Date.now(), company: "", position: "", url: "", status: "已投递", time: Date.now() });
      saveApps();
      render();
    });

    $("captureBtn").addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const t = tabs[0];
        if (!t) return;
        const title = t.title || "";
        let company = title.replace(/(求职简历|招聘|职位|career|jobs|招聘官网|申请|校园招聘|社会招聘).*$/i, "").trim();
        company = company.slice(0, 30);
        apps.unshift({
          id: Date.now(),
          company,
          position: "",
          url: t.url || "",
          status: "已投递",
          time: Date.now(),
        });
        saveApps();
        render();
      });
    });

    $("searchInput").addEventListener("input", render);

    $("exportBtn").addEventListener("click", () => {
      const rows = [["投递时间", "企业", "岗位", "状态", "投递链接"]];
      apps.forEach((a) => rows.push([formatDate(a.time), a.company || "", a.position || "", a.status || "", a.url || ""]));
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `投递记录_${new Date().toLocaleDateString("zh-CN")}.csv`;
      a.click();
    });

    loadApps();
