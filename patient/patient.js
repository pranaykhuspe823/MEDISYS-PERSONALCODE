(function () {
  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }

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

  function actionCard(href, iconSvg, label, hint) {
    return `<a href="${href}" class="staff-action-card">
      <span class="staff-action-icon">${iconSvg}</span>
      <span class="staff-action-label">${label}</span>
      <span class="staff-action-hint">${hint}</span>
    </a>`;
  }

  const ICONS = {
    records: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M8 13h2l1.5-3 2 6 1.5-3H16"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>`,
    prescription: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(45 12 12)"><rect x="4" y="9" width="16" height="6" rx="3"/><line x1="12" y1="9" x2="12" y2="15"/></g></svg>`,
    bill: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6V2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`,
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  async function loadDiseaseAlerts() {
    const section = document.getElementById("diseaseAlertsSection");
    if (!section) return;

    const res = await fetch("/api/patients/me/disease-alerts", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success || data.alerts.length === 0) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    section.innerHTML = data.alerts
      .map((a) => {
        const when = new Date(a.created_at).toLocaleDateString();
        const where = a.is_own_hospital
          ? t("dashboard.alert_at_your_hospital", "at your hospital")
          : `${t("dashboard.alert_nearby_at", "nearby, at")} ${escapeHtml(a.hospital_name)}`;
        return `
        <div class="outbreak-alert-card">
          <span class="outbreak-alert-icon">&#9888;</span>
          <div>
            <p class="outbreak-alert-title">${escapeHtml(a.diagnosis)} ${t("dashboard.alert_cases_reported", "cases reported")} ${where}</p>
            <p class="outbreak-alert-detail">${a.case_count} ${t("dashboard.alert_cases_in_last", "cases in the last")} ${a.window_days} ${t("dashboard.alert_days", "days")} (${escapeHtml(a.city)}). ${t("dashboard.alert_advice", "If you notice symptoms, please consult a doctor promptly.")}</p>
            <p class="outbreak-alert-meta">${escapeHtml(when)}</p>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderAbhaStatus(abha) {
    const el = document.getElementById("abhaStatusCard");
    if (!el) return;

    if (abha && abha.abhaId) {
      el.innerHTML = `
        <div class="portal-card abha-fetch-card">
          <h3 class="abha-fetch-title">🆔 ${t("dashboard.abha_linked_title", "Your ABHA Health Account")}</h3>
          <p class="wizard-hint">
            ${t("dashboard.abha_number_label", "ABHA Number")}: <b>${escapeHtml(abha.abhaId)}</b>
            ${abha.abhaAddress ? `<br>${t("dashboard.abha_address_label", "ABHA Address")}: <b>${escapeHtml(abha.abhaAddress)}</b>` : ""}
          </p>
          ${abha.verified ? `<div class="abha-verified-badge">&#10003; ${t("dashboard.abha_verified", "Verified via ABHA")}</div>` : ""}
        </div>`;
    } else {
      el.innerHTML = `
        <div class="portal-card abha-fetch-card">
          <h3 class="abha-fetch-title">🆔 ${t("dashboard.abha_unlinked_title", "No ABHA Linked Yet")}</h3>
          <p class="wizard-hint">${t(
            "dashboard.abha_unlinked_hint",
            "Ask the front desk to link your Ayushman Bharat Health Account (ABHA) on your next visit so your records can be shared across ABDM-connected hospitals."
          )}</p>
        </div>`;
    }
  }

  async function loadProfile() {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;

    const { fullName, hospitalName, abha } = data.profile;
    document.getElementById("welcomeHeading").textContent = `${t("dashboard.welcome", "Welcome")}, ${fullName}`;
    document.getElementById("patientSubtitle").textContent = `${t("dashboard.patient_at", "Patient at")} ${hospitalName}`;

    renderAbhaStatus(abha);

    document.getElementById("patientActionCards").innerHTML =
      actionCard("records.html", ICONS.records, t("records.title", "Your Medical Records"), t("dashboard.card_patient_records_hint", "Consultations, admissions, vitals, and lab/radiology results")) +
      actionCard("appointments.html", ICONS.calendar, t("appointments.title", "Appointments"), t("dashboard.card_patient_appointments_hint", "Every OPD visit you've booked, past and upcoming")) +
      actionCard("prescriptions.html", ICONS.prescription, t("prescriptions.title", "Prescriptions"), t("dashboard.card_patient_prescriptions_hint", "Medicines your doctor has prescribed and their dispense status")) +
      actionCard("bills.html", ICONS.bill, t("bills.title", "Bills & Invoices"), t("dashboard.card_patient_bills_hint", "Outstanding charges, past bills, and pharmacy invoices"));
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadProfile();
    loadDiseaseAlerts();

    if (window.MEDISYS_RT) {
      // Reaches this patient live only when the alert was raised at their own
      // hospital (same realtime room) — a nearby-hospital alert still shows up
      // on next load/refresh via the REST fetch above.
      MEDISYS_RT.on("disease_alerts", loadDiseaseAlerts);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadProfile();
      loadDiseaseAlerts();
    });
  });
})();
