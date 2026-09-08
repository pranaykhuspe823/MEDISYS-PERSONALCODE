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

  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }

  let currentAdmission = null;

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

  async function loadAdmissions() {
    const res = await fetch("/api/ipd/admissions?status=admitted", { credentials: "same-origin" });
    const data = await res.json();
    const select = document.getElementById("admissionSelect");
    if (!data.success || data.admissions.length === 0) {
      select.innerHTML = `<option value="">No admitted patients</option>`;
      return;
    }
    select.innerHTML =
      `<option value="">Select a patient</option>` +
      data.admissions
        .map((a) => `<option value="${a.id}">${escapeHtml(a.patient_name || a.patient_uhid)} (${escapeHtml(a.ward_name || "")} ${escapeHtml(a.bed_number || "")})</option>`)
        .join("");
  }

  async function loadChart(admissionId) {
    const res = await fetch(`/api/ipd/admissions/${admissionId}`, { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;

    currentAdmission = data.admission;
    document.getElementById("workspace").hidden = false;

    document.getElementById("ordersFeed").innerHTML =
      data.orders
        .map(
          (o) => `<div class="chart-feed-item">
            <strong>${escapeHtml(o.order_type)}</strong>: ${escapeHtml(o.description)}
            <div class="chart-feed-meta">by ${escapeHtml(o.ordered_by)} &middot; ${escapeHtml(new Date(o.created_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">No orders yet.</p>`;

    document.getElementById("marFeed").innerHTML =
      data.mar
        .map(
          (m) => `<div class="chart-feed-item">
            ${escapeHtml(m.medicine_name)} ${escapeHtml(m.dose || "")}
            <div class="chart-feed-meta">by ${escapeHtml(m.administered_by)} &middot; ${escapeHtml(new Date(m.administered_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">No doses logged yet.</p>`;
  }

  function wireActions() {
    document.getElementById("admissionSelect").addEventListener("change", (e) => {
      if (e.target.value) loadChart(e.target.value);
      else document.getElementById("workspace").hidden = true;
    });

    document.getElementById("logMarBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("ipdError");
      errorEl.textContent = "";
      const medicineName = document.getElementById("medicineName").value.trim();
      if (!medicineName || !currentAdmission) {
        errorEl.textContent = t('nurse.medicine_name_required', 'Medicine name is required.');
        return;
      }
      const res = await fetch(`/api/ipd/admissions/${currentAdmission.id}/mar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          medicineName,
          dose: document.getElementById("dose").value.trim(),
          notes: document.getElementById("marNotes").value.trim(),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('nurse.could_not_log_dose', 'Could not log dose.');
        return;
      }
      document.getElementById("medicineName").value = "";
      document.getElementById("dose").value = "";
      document.getElementById("marNotes").value = "";
      loadChart(currentAdmission.id);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireActions();
    loadAdmissions();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("ipd_admissions", loadAdmissions);
    }
  });
})();
