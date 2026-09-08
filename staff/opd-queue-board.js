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

  // Same three-stage status model as staff/doctor-queue.js (which is what
  // actually moves a visit through these) — waiting -> called -> in-consultation.
  const STATUS_MAP = {
    waiting: "opd.status_waiting",
    called: "opd.status_called",
    in_consultation: "opd.status_in_consultation",
    "in-consultation": "opd.status_in_consultation",
    completed: "opd.status_completed",
    cancelled: "opd.status_cancelled",
  };

  function getStatusDisplay(s) {
    const key = STATUS_MAP[s] || `opd.status_${s}`;
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    const fallbacks = {
      waiting: "Waiting",
      called: "Called",
      in_consultation: "In Consultation",
      "in-consultation": "In Consultation",
      completed: "Completed",
      cancelled: "Cancelled",
    };
    return fallbacks[s] || s;
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

  async function loadQueue() {
    const res = await fetch("/api/opd/queue", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("queueBoardTableBody");
    const emptyState = document.getElementById("queueBoardEmptyState");

    if (!data.success || data.queue.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const walkInLabel = t("registration.walk_in", "Walk-in");
    tbody.innerHTML = data.queue
      .map(
        (v) => `<tr>
          <td>#${v.token_number}</td>
          <td>${escapeHtml(v.patient_name || v.patient_uhid)}</td>
          <td>${escapeHtml(v.doctor_name || v.doctor_user_id)}</td>
          <td>${escapeHtml(v.slot_time || walkInLabel)}</td>
          <td><span class="queue-status ${escapeHtml(v.status)}">${escapeHtml(getStatusDisplay(v.status))}</span></td>
        </tr>`
      )
      .join("");
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadQueue();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("opd_queue", loadQueue);
    }

    window.addEventListener("i18n:languageChanged", () => {
      if (window.i18n) window.i18n.applyTranslations();
      loadQueue();
    });
  });
})();
