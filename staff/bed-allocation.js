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

  async function loadPending() {
    const [pendingRes, bedsRes] = await Promise.all([
      fetch("/api/ipd/admissions?status=requested", { credentials: "same-origin" }),
      fetch("/api/beds/available", { credentials: "same-origin" }),
    ]);
    const pendingData = await pendingRes.json();
    const bedsData = await bedsRes.json();

    const list = document.getElementById("pendingList");
    const emptyState = document.getElementById("pendingEmptyState");

    if (!pendingData.success || pendingData.admissions.length === 0) {
      list.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const bedOptions = bedsData.success
      ? bedsData.beds
          .map((b) => `<option value="${b.id}">${escapeHtml(b.ward_name)} — ${escapeHtml(b.bed_number)}</option>`)
          .join("")
      : "";

    list.innerHTML = pendingData.admissions
      .map(
        (a) => `
        <div class="staff-entry-card" style="margin-bottom: 14px;">
          <div class="staff-entry-name">${escapeHtml(a.patient_name || a.patient_uhid)}</div>
          <div class="staff-entry-detail">${t('bed.admitting_doctor', 'Admitting doctor')}: ${escapeHtml(a.doctor_name || "—")}</div>
          <div class="staff-entry-detail">${t('bed.requested', 'Requested')} ${escapeHtml(new Date(a.created_at).toLocaleString())}</div>
          <div class="wizard-suggest-row" style="margin-top: 12px;">
            <select data-admission-id="${a.id}" class="bed-select">
              <option value="">${t('bed.select_bed', 'Select a bed')}</option>
              ${bedOptions}
            </select>
            <button type="button" class="wizard-suggest-btn allocate-btn" data-admission-id="${a.id}">${t('bed.allocate', 'Allocate')}</button>
          </div>
        </div>`
      )
      .join("");

    list.querySelectorAll(".allocate-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const select = list.querySelector(`.bed-select[data-admission-id="${btn.dataset.admissionId}"]`);
        const bedId = select.value;
        if (!bedId) return;

        const res = await fetch(`/api/ipd/admissions/${btn.dataset.admissionId}/allocate-bed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ bedId }),
        });
        const data = await res.json();
        if (data.success) {
          loadPending();
        } else {
          if (window.showToast) showToast(data.message || t('bed.could_not_allocate', 'Could not allocate bed.'), "error");
        }
      });
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadPending();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("ipd_admissions", loadPending);
      MEDISYS_RT.on("beds", loadPending);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadPending();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
