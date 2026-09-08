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

  const STATUS_LABEL = { pending_pharmacy: "Pending at Pharmacy", dispensed: "Dispensed" };

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "patient") {
      window.location.href = "../index";
      return null;
    }
    document.getElementById("portalUser").textContent = data.user.userId;
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

  async function loadPrescriptions() {
    const res = await fetch("/api/patients/me/prescriptions", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("prescriptionsTableBody");
    const emptyState = document.getElementById("prescriptionsEmptyState");

    if (!data.success || data.prescriptions.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.prescriptions
      .map((p) => {
        const isDispensed = p.status === "dispensed";
        const statusLabel = isDispensed ? t('prescriptions.dispensed', 'Dispensed') : t('prescriptions.pending_pharmacy', 'Pending at Pharmacy');
        const urgencyLabel = p.urgency === "urgent" ? t('common.urgent', 'Urgent') : t('common.routine', 'Routine');
        return `<tr>
          <td>${escapeHtml(p.medicine_name)}</td>
          <td>${escapeHtml(p.dosage)}</td>
          <td>${escapeHtml(p.duration)}</td>
          <td>${escapeHtml(p.food_instruction || "—")}</td>
          <td>${escapeHtml(urgencyLabel)}</td>
          <td><span class="queue-status ${isDispensed ? "completed" : "waiting"}">${escapeHtml(statusLabel)}</span></td>
          <td>${escapeHtml(new Date(p.created_at).toLocaleString())}</td>
        </tr>`;
      })
      .join("");
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadPrescriptions();
    if (window.MEDISYS_RT) {
      ["pharmacy_orders", "pharmacy_invoices"].forEach((resource) => MEDISYS_RT.on(resource, loadPrescriptions));
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadPrescriptions();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
