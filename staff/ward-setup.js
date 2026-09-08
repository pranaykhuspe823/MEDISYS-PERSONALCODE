(function () {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || !data.user.hospitalId || data.user.role === "patient") {
      window.location.href = "../index";
      return null;
    }
    document.getElementById("portalUser").textContent = data.user.fullName || data.user.userId;
    return data.user;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
  }

  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }

  async function loadWards() {
    const res = await fetch("/api/wards", { credentials: "same-origin" });
    const data = await res.json();
    const list = document.getElementById("wardsList");
    const emptyState = document.getElementById("wardsEmptyState");

    if (!data.success || data.wards.length === 0) {
      list.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    list.innerHTML = data.wards
      .map(
        (w) => `
        <div class="ward-card">
          <div class="ward-card-title-row">
            <div class="ward-card-title">${escapeHtml(w.name)} <span class="wizard-hint" style="display:inline;">(${w.beds.length} ${t('ward.beds', 'bed(s)')})</span></div>
            <button type="button" class="icon-btn-delete delete-ward-btn" data-ward-id="${w.id}" data-ward-name="${escapeHtml(w.name)}" aria-label="Delete ward">&times; ${t('ward.delete_ward', 'Delete Ward')}</button>
          </div>
          <div class="bed-chip-grid">
            ${w.beds
              .map((b) => `<span class="bed-chip ${escapeHtml(b.status)}">${escapeHtml(b.bed_number)}</span>`)
              .join("") || `<span class="wizard-hint">${t('ward.no_beds', 'No beds yet.')}</span>`}
          </div>
          <div class="wizard-suggest-row" style="margin-top: 14px;">
            <input type="number" min="1" max="200" value="5" data-ward-id="${w.id}" class="add-bed-input" style="max-width: 90px;" />
            <button type="button" class="wizard-suggest-btn add-bed-btn" data-ward-id="${w.id}">+ ${t('ward.add_beds', 'Add Beds')}</button>
          </div>
        </div>`
      )
      .join("");

    list.querySelectorAll(".add-bed-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const input = list.querySelector(`.add-bed-input[data-ward-id="${btn.dataset.wardId}"]`);
        const count = Number(input.value);
        if (!count || count < 1) return;

        const res = await fetch(`/api/wards/${btn.dataset.wardId}/beds`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ count }),
        });
        const data = await res.json();
        if (data.success) {
          if (window.showToast) showToast(`${count} ${t('ward.beds_added', 'bed(s) added.')}`, "success");
          loadWards();
        } else if (window.showToast) {
          showToast(data.message || t('ward.could_not_add_beds', 'Could not add beds.'), "error");
        }
      });
    });

    list.querySelectorAll(".delete-ward-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`${t('ward.delete', 'Delete')} ${btn.dataset.wardName}?`)) return;
        const res = await fetch(`/api/wards/${btn.dataset.wardId}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        const data = await res.json();
        if (data.success) {
          if (window.showToast) showToast(`${btn.dataset.wardName} ${t('ward.deleted', 'deleted.')}`, "success");
          loadWards();
        } else {
          if (window.showToast) showToast(data.message || t('ward.could_not_delete', 'Could not delete ward.'), "error");
          else alert(data.message || t('ward.could_not_delete', 'Could not delete ward.'));
        }
      });
    });
  }

  function wireAddWard() {
    document.getElementById("addWardBtn").addEventListener("click", async () => {
      const input = document.getElementById("wardName");
      const bedCountInput = document.getElementById("wardBedCount");
      const errorEl = document.getElementById("wardFormError");
      errorEl.textContent = "";
      const name = input.value.trim();
      const bedCount = Number(bedCountInput.value);
      if (!name) {
        errorEl.textContent = t('ward.name_required', 'Ward name is required.');
        return;
      }
      if (!bedCount || bedCount < 1) {
        errorEl.textContent = t('ward.enter_bed_count', 'Enter how many beds this ward should have.');
        return;
      }

      const res = await fetch("/api/wards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, bedCount }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('ward.could_not_add_ward', 'Could not add ward.');
        return;
      }
      input.value = "";
      bedCountInput.value = "10";
      if (window.showToast) showToast(`${name} ${t('ward.created_with', 'created with')} ${data.bedsCreated} ${t('ward.beds', 'bed(s).')}`, "success");
      loadWards();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireAddWard();
    loadWards();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("wards_beds", loadWards);
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadWards();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
