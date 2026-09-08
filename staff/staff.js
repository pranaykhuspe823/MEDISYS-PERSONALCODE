(function () {
  const MODULE_ICONS = {
    opd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 13l2 2 4-4"/></svg>`,
    radiology: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M9 4v14"/><circle cx="15" cy="12" r="2.5"/></svg>`,
    billing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6V2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`,
    pharmacy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(45 12 12)"><rect x="4" y="9" width="16" height="6" rx="3"/><line x1="12" y1="9" x2="12" y2="15"/></g></svg>`,
    laboratory: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6M10 2v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3.5L14 8V2"/><path d="M7.5 15h9"/></svg>`,
    bloodbank: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-4 5-6 8.5-6 11a6 6 0 0 0 12 0c0-2.5-2-6-6-11z"/></svg>`,
  };

  const ROLE_MODULE = {
    pharmacist: "pharmacy",
    pathology_staff: "pathology",
    billing_staff: "billing",
    blood_bank_staff: "bloodbank",
  };

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

    if (!data.user || !data.user.hospitalId || data.user.role === "hospital_admin" || data.user.role === "patient") {
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

  async function loadProfile() {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;

    const { fullName, roleLabel, hospitalName, role, details } = data.profile;
    const displayLabel = role === "pathology_staff" && details?.designation ? details.designation : roleLabel;
    
    document.getElementById("welcomeHeading").textContent = `${t('dashboard.welcome', 'Welcome')}, ${fullName}`;
    document.getElementById("staffSubtitle").textContent = `${displayLabel} ${t('dashboard.at', 'at')} ${hospitalName}`;

    const actionCards = document.getElementById("staffActionCards");
    const CARD_ICONS = {
      registration: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 13l2 2 4-4"/></svg>`,
      calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>`,
      bed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M3 18v2M21 18v2M6 10V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4"/></svg>`,
      vitals: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>`,
      ward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l9-5 9 5v13M9 21v-6h6v6"/></svg>`,
      clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
      queue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="9" r="2.6"/><path d="M2.5 20c0-3.3 2.6-5.6 5.5-5.6s5.5 2.3 5.5 5.6M14.5 14.9c2.4.2 4.5 2.3 4.5 5.1"/></svg>`,
      admission: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5a3 3 0 0 0 6 0V3"/><path d="M12 11v4a5 5 0 0 0 10 0v-2"/><circle cx="21" cy="10" r="1.6"/></svg>`,
    };

    function actionCard(href, iconKey, label, hint) {
      return `<a href="${href}" class="staff-action-card">
        <span class="staff-action-icon">${CARD_ICONS[iconKey]}</span>
        <span class="staff-action-label">${label}</span>
        <span class="staff-action-hint">${hint}</span>
      </a>`;
    }

    if (role === "receptionist") {
      actionCards.innerHTML =
        actionCard("registration.html", "registration", t("navigation.registration", "Patient Registration"), t("dashboard.card_reg_hint", "Search existing patients or register a new one")) +
        actionCard("opd.html", "calendar", t("opd.title", "OPD Booking & Queue"), t("dashboard.card_opd_hint", "Book an appointment, issue a walk-in token, view today's queue")) +
        actionCard("ipd-admission.html", "admission", t("navigation.admission", "Admission Request"), t("dashboard.card_adm_hint", "Start a direct IPD admission for a patient"));
    } else if (role === "nurse") {
      actionCards.innerHTML =
        actionCard("vitals.html", "vitals", t("navigation.opd_vitals", "OPD Vitals"), t("dashboard.card_vitals_hint", "Log BP, temperature, weight, SpO2 before consultation")) +
        actionCard("ward-setup.html", "ward", t("navigation.ward_bed", "Ward & Bed Setup"), t("dashboard.card_ward_hint", "Add wards and beds for this hospital")) +
        actionCard("bed-allocation.html", "bed", t("navigation.bed_allocation", "Bed Allocation"), t("dashboard.card_bed_hint", "Allocate a bed to a pending admission request")) +
        actionCard("nurse-ipd.html", "admission", t("navigation.ipd_patients", "IPD Patients"), t("dashboard.card_nurse_ipd_hint", "Log medication administered for admitted patients")) +
        actionCard("nurse-patients.html", "queue", t("navigation.my_patients", "My Patients"), t("dashboard.card_nurse_pat_hint", "Patients auto-assigned to you for this shift")) +
        actionCard("nurse-all-patients.html", "queue", t("navigation.all_patients", "All Patients"), t("dashboard.card_nurse_all_hint", "Every admitted patient hospital-wide, with a Discharge button"));
    } else if (role === "doctor") {
      actionCards.innerHTML =
        actionCard("doctor-schedule.html", "clock", t("navigation.my_schedule", "My Schedule"), t("dashboard.card_doc_sched_hint", "Set your weekly available time slots")) +
        actionCard("doctor-queue.html", "queue", t("navigation.my_queue", "My Queue"), t("dashboard.card_doc_queue_hint", "Call patients, view EMR history, record consultations")) +
        actionCard("doctor-ipd.html", "admission", t("navigation.ipd_rounds", "IPD Rounds"), t("dashboard.card_doc_ipd_hint", "Round notes and orders for your admitted patients")) +
        actionCard("doctor-patients.html", "registration", t("navigation.my_patients", "My Patients"), t("dashboard.card_doc_pat_hint", "Prescriptions and lab/radiology reports for everyone you've seen"));
    } else if (role === "pathology_staff") {
      const designation = details?.designation;
      const isRadiologist = designation === "Radiologist";
      const href = isRadiologist ? "radiology-queue.html" : "pathology-queue.html";
      const label = isRadiologist ? t("navigation.radiology_queue", "Radiology Queue") : t("navigation.pathology_lab", "Pathology & Lab Queue");
      const hint = isRadiologist
        ? t("dashboard.card_rad_hint", "Triage imaging studies, report and sign off with image upload")
        : t("dashboard.card_path_hint", "Triage samples, enter results and sign off with specimen image upload");
      actionCards.innerHTML = actionCard(href, "queue", label, hint);
    } else if (role === "pharmacist") {
      actionCards.innerHTML = actionCard("pharmacy-queue.html", "queue", t("navigation.pharmacy_queue", "Pharmacy Queue"), t("dashboard.card_pharm_hint", "View pending prescriptions and dispense medicines"));
    } else if (role === "blood_bank_staff") {
      actionCards.innerHTML = actionCard("blood-bank-queue.html", "queue", t("navigation.blood_bank", "Blood Bank"), t("dashboard.card_blood_hint", "Requests, crossmatch, inventory, donors, and billing"));
    } else if (role === "billing_staff") {
      actionCards.innerHTML = actionCard("billing-desk.html", "queue", t("billing_desk.title", "Billing Desk"), t("dashboard.card_bill_hint", "Create bills, collect payments, and track insurance claims"));
    }

    const moduleKey = (role === "pathology_staff" || role === "pharmacist" || role === "blood_bank_staff" || role === "billing_staff") ? null : ROLE_MODULE[role];
    const grid = document.getElementById("staffModuleGrid");
    grid.innerHTML = moduleKey
      ? `<div class="module-card readonly">
          <span class="module-card-icon">${MODULE_ICONS[moduleKey]}</span>
          <span class="module-card-label">${t("navigation." + moduleKey, moduleKey)}</span>
          <span class="module-card-soon">${t("dashboard.coming_soon", "Coming soon")}</span>
        </div>`
      : "";
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadProfile();

    window.addEventListener("i18n:languageChanged", () => {
      loadProfile();
    });
  });
})();
