(function () {
  const POLL_INTERVAL_MS = 60000; // slow safety-net fallback alongside MEDISYS_RT live push

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
    if (!data.user || data.user.role !== "nurse") {
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

  async function loadAllPatients() {
    const res = await fetch("/api/ipd/admissions?status=admitted&scope=all", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("allPatientsTableBody");
    const emptyState = document.getElementById("allPatientsEmptyState");

    if (!data.success || data.admissions.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.admissions
      .map(
        (a) => `<tr>
          <td>${escapeHtml(a.patient_name || a.patient_uhid)}</td>
          <td>${escapeHtml(a.ward_name || "—")}</td>
          <td>${escapeHtml(a.bed_number || "—")}</td>
          <td>${escapeHtml(a.doctor_name || "—")}</td>
          <td>${escapeHtml(a.assigned_nurse_id || "—")}</td>
          <td>${a.admitted_at ? escapeHtml(new Date(a.admitted_at).toLocaleString()) : "—"}</td>
          <td><button type="button" class="wizard-suggest-btn discharge-btn" data-id="${a.id}" data-name="${escapeHtml(a.patient_name || a.patient_uhid)}">${t('nurse.discharge', 'Discharge')}</button></td>
        </tr>`
      )
      .join("");

    tbody.querySelectorAll(".discharge-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`${t('nurse.confirm_discharge', 'Discharge')} ${btn.dataset.name}?`)) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/ipd/admissions/${btn.dataset.id}/discharge`, {
            method: "POST",
            credentials: "same-origin",
          });
          const data = await res.json();
          if (!data.success) {
            if (window.showToast) showToast(data.message || t('nurse.could_not_discharge', 'Could not discharge patient.'), "error");
            else alert(data.message || t('nurse.could_not_discharge', 'Could not discharge patient.'));
            btn.disabled = false;
            return;
          }
          if (window.showToast) showToast(`${btn.dataset.name} ${t('nurse.discharged_freed', 'discharged — bed freed.')}`, "success");
          loadAllPatients();
        } catch (err) {
          btn.disabled = false;
        }
      });
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadAllPatients();
    setInterval(loadAllPatients, POLL_INTERVAL_MS);
    if (window.MEDISYS_RT) {
      ["ipd_admissions", "patients", "wards_beds"].forEach((resource) => MEDISYS_RT.on(resource, loadAllPatients));
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadAllPatients();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
