(function () {
  // Live push (MEDISYS_RT, see realtime-client.js) now does the real-time work
  // the moment resolveNurseAssignment() runs server-side; this interval is
  // just a slow safety-net fallback in case a socket ever silently drops.
  const POLL_INTERVAL_MS = 60000;

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

  async function loadMyPatients() {
    const res = await fetch("/api/ipd/admissions?status=admitted", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("myPatientsTableBody");
    const emptyState = document.getElementById("myPatientsEmptyState");

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
          <td>${a.admitted_at ? escapeHtml(new Date(a.admitted_at).toLocaleString()) : "—"}</td>
        </tr>`
      )
      .join("");
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadMyPatients();
    setInterval(loadMyPatients, POLL_INTERVAL_MS);
    if (window.MEDISYS_RT) {
      ["ipd_admissions", "patients", "vitals"].forEach((resource) => MEDISYS_RT.on(resource, loadMyPatients));
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadMyPatients();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
