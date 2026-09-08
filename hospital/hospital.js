(function () {
  const MODULE_ICONS = {
    opd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 13l2 2 4-4"/></svg>`,
    radiology: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M9 4v14"/><circle cx="15" cy="12" r="2.5"/></svg>`,
    billing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6V2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`,
    pharmacy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(45 12 12)"><rect x="4" y="9" width="16" height="6" rx="3"/><line x1="12" y1="9" x2="12" y2="15"/></g></svg>`,
    pathology: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20h6M12 20v-4"/><path d="M6 20a7 7 0 0 1 12-5"/><path d="M10 12l-2-2 3-3 5 5-1.5 1.5"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>`,
    laboratory: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6M10 2v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3.5L14 8V2"/><path d="M7.5 15h9"/></svg>`,
  };

  const MODULE_LABELS = {
    opd: "module.opd",
    radiology: "module.radiology",
    billing: "module.billing",
    pharmacy: "module.pharmacy",
    pathology: "module.pathology",
    laboratory: "module.laboratory",
    blood_bank: "module.blood_bank",
    ipd: "module.ipd",
  };

  // These link to module-overview.html — a read-only oversight dashboard
  // (patients, doctors, statuses) built for the hospital admin, not the
  // staff operational tool (which has claim/dispense/verify actions meant
  // for the specific staff role, not the admin). See module-overview.js for
  // the per-module data mapping. Modules without an entry here (e.g. "ipd",
  // split across separate doctor/nurse pages with no single admin view yet,
  // and "blood_bank", which has no read API wired up for this page yet)
  // still fall back to the old readonly/coming-soon card.
  const MODULE_PAGES = {
    opd: "module-overview.html?module=opd",
    radiology: "module-overview.html?module=radiology",
    billing: "module-overview.html?module=billing",
    pharmacy: "module-overview.html?module=pharmacy",
    pathology: "module-overview.html?module=pathology",
    laboratory: "module-overview.html?module=laboratory",
  };

  function getModuleLabel(m) {
    const key = MODULE_LABELS[m] || `module.${m}`;
    const fallbacks = {
      opd: "OPD",
      radiology: "Radiology",
      billing: "Billing & Insurance",
      pharmacy: "Pharmacy",
      pathology: "Pathology",
      laboratory: "Laboratory",
      blood_bank: "Blood Bank",
      ipd: "IPD",
    };
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    return fallbacks[m] || m;
  }

  const ROLE_ICONS = {
    doctor: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5a3 3 0 0 0 6 0V3"/><path d="M9 3H7M15 3h2"/><path d="M12 11v4a5 5 0 0 0 10 0v-2"/><circle cx="21" cy="10" r="1.6"/></svg>`,
    nurse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="3.2"/><path d="M5.5 21c0-3.6 2.9-6.2 6.5-6.2S18.5 17.4 18.5 21"/><path d="M12 11.8v3.2M10.4 13.4h3.2"/></svg>`,
    pharmacist: MODULE_ICONS.pharmacy,
    pathology_staff: MODULE_ICONS.pathology,
    receptionist: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 13V9a5 5 0 0 1 10 0v4"/><circle cx="9" cy="16.5" r="1"/><circle cx="15" cy="16.5" r="1"/></svg>`,
    billing_staff: MODULE_ICONS.billing,
    blood_bank_staff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-4 5-6 8.5-6 11a6 6 0 0 0 12 0c0-2.5-2-6-6-11z"/></svg>`,
  };

  const ROLE_LABELS = {
    doctor: "Doctor",
    nurse: "Nurse",
    pharmacist: "Pharmacist",
    pathology_staff: "Pathologist",
    receptionist: "OPD",
    billing_staff: "Billing Staff",
    blood_bank_staff: "Blood Bank Staff",
  };

  const ROLE_KEYS = {
    doctor: "role.doctor",
    nurse: "role.nurse",
    pharmacist: "role.pharmacist",
    pathology_staff: "role.pathologist",
    receptionist: "role.opd",
    billing_staff: "role.billing_staff",
    blood_bank_staff: "role.blood_bank_staff",
  };

  function getRoleLabel(role) {
    const key = ROLE_KEYS[role] || `role.${role}`;
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    return ROLE_LABELS[role] || role;
  }

  function getRoleLabelPlural(role) {
    const key = `role.${role}_plural`;
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    return getRoleLabel(role) + "s";
  }

  const ROLE_FIELDS = {
    doctor: [
      { key: "specialization", label: "Specialization", type: "text" },
      { key: "qualification", label: "Qualification", type: "text" },
      { key: "licenseNumber", label: "Medical License No.", type: "text" },
      { key: "consultationFee", label: "Telemedicine Consultation Fee (₹)", type: "text" },
    ],
    nurse: [
      { key: "qualification", label: "Qualification", type: "text" },
      { key: "shift", label: "Shift", type: "select", options: ["Morning", "Evening", "Night"] },
      { key: "ward", label: "Ward", type: "text" },
    ],
    pharmacist: [
      { key: "licenseNumber", label: "License No.", type: "text" },
      { key: "qualification", label: "Qualification", type: "text" },
    ],
    pathology_staff: [
      {
        key: "designation",
        label: "Designation",
        type: "select",
        options: ["Pathologist", "Lab Assistant", "Radiologist"],
      },
      { key: "certification", label: "Certification", type: "text" },
      { key: "licenseNumber", label: "License No.", type: "text" },
    ],
    receptionist: [{ key: "shift", label: "Shift", type: "select", options: ["Morning", "Evening", "Night"] }],
    billing_staff: [
      { key: "department", label: "Department", type: "select", options: ["Billing", "Insurance", "Both"] },
    ],
    blood_bank_staff: [
      { key: "certification", label: "Certification", type: "text" },
      { key: "licenseNumber", label: "License No.", type: "text" },
    ],
  };

  const ROLE_DETAIL_SUMMARY = {
    doctor: (d) => d.specialization,
    nurse: (d) => [d.ward, d.shift].filter(Boolean).join(" · "),
    pharmacist: (d) => d.qualification,
    pathology_staff: (d) => d.designation,
    receptionist: (d) => d.shift,
    billing_staff: (d) => d.department,
    blood_bank_staff: (d) => d.certification,
  };

  const ROLE_LABELS_PLURAL = {
    receptionist: "OPD Staff",
    pathology_staff: "Pathology Staff",
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

  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === "function") {
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

    if (!data.user || data.user.role !== "hospital_admin") {
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

  async function loadHospital() {
    const grid = document.getElementById("hospitalModuleGrid");
    if (!grid) return;

    const res = await fetch("/api/hospital/me", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;

    const hospital = data.hospital;
    document.getElementById("hospitalName").textContent = hospital.name;

    const modules = (() => {
      try {
        return typeof hospital.modules === "string" ? JSON.parse(hospital.modules) : hospital.modules || [];
      } catch {
        return [];
      }
    })();

    function tOr(key, fallback) {
      if (window.i18n && typeof window.i18n.t === "function") {
        const res = window.i18n.t(key);
        if (res && res !== key) return res;
      }
      return fallback;
    }
    const openLabel = tOr("hospital_page.open_module", "Open");
    const soonLabel = tOr("hospital_page.coming_soon", "Coming soon");

    grid.innerHTML = modules
      .map((m) => {
        const href = MODULE_PAGES[m];
        const icon = `<span class="module-card-icon">${MODULE_ICONS[m] || ""}</span>`;
        const label = `<span class="module-card-label">${getModuleLabel(m)}</span>`;
        if (href) {
          return `<a class="module-card" href="${href}">${icon}${label}<span class="module-card-open">${openLabel}</span></a>`;
        }
        return `<div class="module-card readonly">${icon}${label}<span class="module-card-soon">${soonLabel}</span></div>`;
      })
      .join("");
  }

  async function loadOutbreakAlerts() {
    const section = document.getElementById("outbreakAlertsSection");
    const list = document.getElementById("outbreakAlertsList");
    if (!section || !list) return;

    const res = await fetch("/api/hospital/disease-alerts", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success || data.alerts.length === 0) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    list.innerHTML = data.alerts
      .map((a) => {
        const when = new Date(a.created_at).toLocaleString();
        return `
        <div class="outbreak-alert-card">
          <span class="outbreak-alert-icon">&#9888;</span>
          <div>
            <p class="outbreak-alert-title">${escapeHtml(a.diagnosis)} — ${t('hospital_page.possible_outbreak', 'possible outbreak')}</p>
            <p class="outbreak-alert-detail">${t('hospital_page.outbreak_detail', '{caseCount} cases recorded in the last {windowDays} days. SMS alert sent to {hospitalNotified} patient(s) at your hospital and {nearbyNotified} patient(s) in nearby areas.', { caseCount: a.case_count, windowDays: a.window_days, hospitalNotified: a.hospital_patients_notified, nearbyNotified: a.nearby_patients_notified })}</p>
            <p class="outbreak-alert-meta">${t('hospital_page.raised_at', 'Raised {when}', { when: escapeHtml(when) })}</p>
          </div>
        </div>`;
      })
      .join("");
  }

  // ---------- Hospital Overview: live stats, no dummy numbers ----------
  // Every figure comes straight from GET /api/hospital/overview, which
  // itself is a real, live aggregate over bills/pharmacy_invoices/
  // blood_billing/telemedicine_payments/patients/ipd_admissions/opd_visits/
  // users — see server/server.js. Refreshed on load and again whenever any
  // of those resources change elsewhere in the app (realtime, wired below).

  function formatCurrency(amount) {
    return "₹" + (Number(amount) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  }

  const DONUT_COLORS = ["#2e7d5b", "#4a5fd1", "#d99a2b", "#c0392b", "#8891a0", "#6a4fd1", "#0d5c50"];
  let lastOverviewData = null; // for Download Report — exports exactly what's on screen, nothing re-fetched

  function pctBadge(el, pct) {
    if (!el) return;
    const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
    const arrow = pct > 0 ? "↑" : pct < 0 ? "↓" : "•";
    el.className = "stat-pct-badge " + cls;
    el.textContent = `${arrow} ${Math.abs(pct)}%`;
  }

  function renderDonutChart(breakdown) {
    const chart = document.getElementById("donutChart");
    const legend = document.getElementById("donutLegend");
    const totalEl = document.getElementById("donutTotal");
    if (!chart || !legend) return;

    const total = breakdown.reduce((sum, d) => sum + Number(d.count), 0);
    totalEl.textContent = total.toLocaleString("en-IN");

    if (total === 0) {
      chart.style.background = "#eef1f6";
      legend.innerHTML = `<li class="donut-empty">${escapeHtml(t("hospital_page.no_opd_data", "No OPD visits for this date yet."))}</li>`;
      return;
    }

    let cursor = 0;
    const stops = breakdown.map((d, i) => {
      const pct = (Number(d.count) / total) * 100;
      const color = DONUT_COLORS[i % DONUT_COLORS.length];
      const segment = `${color} ${cursor}% ${cursor + pct}%`;
      cursor += pct;
      return { segment, color, pct };
    });
    chart.style.background = `conic-gradient(${stops.map((s) => s.segment).join(", ")})`;

    legend.innerHTML = breakdown
      .map((d, i) => {
        const pct = Math.round((Number(d.count) / total) * 100);
        return `<li>
          <span class="donut-legend-dot" style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></span>
          <span class="donut-legend-name">${escapeHtml(d.name)}</span>
          <span class="donut-legend-count">${d.count}</span>
          <span class="donut-legend-pct">${pct}%</span>
        </li>`;
      })
      .join("");
  }

  function downloadOverviewReport() {
    if (!lastOverviewData) return;
    const d = lastOverviewData;
    const rows = [
      ["Metric", "Value"],
      ["Date", d.date],
      ["Total Revenue", d.revenue.total],
      ["Revenue This Month", d.revenue.thisMonth],
      ["  - Billing Desk", d.revenue.breakdown.billingDesk],
      ["  - Pharmacy", d.revenue.breakdown.pharmacy],
      ["  - Blood Bank", d.revenue.breakdown.bloodBank],
      ["  - Telemedicine", d.revenue.breakdown.telemedicine],
      ["Total Expenses", d.expenses.total],
      ["Expenses This Month", d.expenses.thisMonth],
      ["Net (Revenue - Expenses)", d.net.total],
      ["Net This Month", d.net.thisMonth],
      ["Total Patients", d.patients.total],
      ["New Patients Today", d.patients.newToday],
      ["New Patients This Month", d.patients.newThisMonth],
      ["OPD Visits (selected date)", d.opdVisitsToday],
      ["OPD Visits This Month", d.opdVisitsThisMonth],
      ["Admitted Today", d.census.admittedToday],
      ["Currently Admitted", d.census.currentlyAdmitted],
      ["Discharged (selected date)", d.census.dischargedToday],
      ["Discharged This Month", d.census.dischargedThisMonth],
      ["Total Beds", d.beds.total],
      ["Occupied Beds", d.beds.occupied],
      ["Available Beds", d.beds.available],
      ["Occupancy Rate (%)", d.beds.occupancyPct],
      ["Total Staff", d.totalStaff],
    ];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hospital-report-${d.date}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function loadOverview() {
    const grid = document.getElementById("overviewGrid");
    if (!grid) return;
    try {
      const datePicker = document.getElementById("overviewDatePicker");
      const selectedDate = datePicker && datePicker.value ? datePicker.value : "";
      const res = await fetch(`/api/hospital/overview${selectedDate ? "?date=" + selectedDate : ""}`, { credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) return;
      lastOverviewData = data;
      if (datePicker && !datePicker.value) datePicker.value = data.date;

      document.getElementById("statTotalRevenue").textContent = formatCurrency(data.revenue.total);
      document.getElementById("statRevenueThisMonth").textContent = t("hospital_page.this_month_amount", "{amount} this month", {
        amount: formatCurrency(data.revenue.thisMonth),
      });
      pctBadge(document.getElementById("statRevenuePct"), data.revenue.pctChange);

      document.getElementById("statTotalExpenses").textContent = formatCurrency(data.expenses.total);
      document.getElementById("statExpensesThisMonth").textContent = t("hospital_page.this_month_amount", "{amount} this month", {
        amount: formatCurrency(data.expenses.thisMonth),
      });
      pctBadge(document.getElementById("statExpensesPct"), data.expenses.pctChange);

      document.getElementById("statNetRevenue").textContent = formatCurrency(data.net.total);
      document.getElementById("statNetThisMonth").textContent = t("hospital_page.this_month_amount", "{amount} this month", {
        amount: formatCurrency(data.net.thisMonth),
      });
      pctBadge(document.getElementById("statNetPct"), data.net.pctChange);

      document.getElementById("statTotalPatients").textContent = (data.patients.total || 0).toLocaleString("en-IN");
      document.getElementById("statNewPatients").textContent = t(
        "hospital_page.new_patients_sub",
        "+{today} today · +{month} this month",
        { today: data.patients.newToday, month: data.patients.newThisMonth }
      );
      pctBadge(document.getElementById("statPatientsPct"), data.patients.pctChange);

      // Patient Flow funnel
      document.getElementById("flowOpdToday").textContent = (data.opdVisitsToday || 0).toLocaleString("en-IN");
      document.getElementById("flowOpdMonth").textContent = t("hospital_page.this_month_count", "{count} this month", {
        count: data.opdVisitsThisMonth,
      });
      document.getElementById("flowAdmittedToday").textContent = (data.census.admittedToday || 0).toLocaleString("en-IN");
      document.getElementById("flowAdmittedMonth").textContent = t("hospital_page.this_month_count", "{count} this month", {
        count: data.census.admittedThisMonth,
      });
      document.getElementById("flowCurrentlyAdmitted").textContent = (data.census.currentlyAdmitted || 0).toLocaleString("en-IN");
      document.getElementById("flowDischargedMonth").textContent = t("hospital_page.discharged_sub", "{count} discharged this month", {
        count: data.census.dischargedThisMonth,
      });
      document.getElementById("flowDischargedToday").textContent = (data.census.dischargedToday || 0).toLocaleString("en-IN");
      document.getElementById("flowDischargedTodayMonth").textContent = t("hospital_page.this_month_count", "{count} this month", {
        count: data.census.dischargedThisMonth,
      });

      // Department donut
      const deptTitle = document.getElementById("deptChartTitle");
      if (deptTitle) {
        deptTitle.textContent = t("hospital_page.dept_opd_title_dated", "Department-wise OPD ({date})", { date: data.date });
      }
      renderDonutChart(data.departmentBreakdown || []);

      // Second row of mini cards
      document.getElementById("miniOpdToday").textContent = (data.opdVisitsToday || 0).toLocaleString("en-IN");
      document.getElementById("miniOpdMonth").textContent = t("hospital_page.this_month_count", "{count} this month", {
        count: data.opdVisitsThisMonth,
      });
      document.getElementById("miniCurrentlyAdmitted").textContent = (data.census.currentlyAdmitted || 0).toLocaleString("en-IN");
      document.getElementById("miniDischargedMonth").textContent = t("hospital_page.discharged_sub", "{count} discharged this month", {
        count: data.census.dischargedThisMonth,
      });
      document.getElementById("miniDischargedToday").textContent = (data.census.dischargedToday || 0).toLocaleString("en-IN");
      document.getElementById("miniDischargedTodayMonth").textContent = t("hospital_page.this_month_count", "{count} this month", {
        count: data.census.dischargedThisMonth,
      });
      document.getElementById("miniTotalBeds").textContent = (data.beds.total || 0).toLocaleString("en-IN");
      document.getElementById("miniAvailableBeds").textContent = t("hospital_page.beds_available", "{count} available", {
        count: data.beds.available,
      });
      document.getElementById("miniOccupancyRate").textContent = `${data.beds.occupancyPct}%`;
      document.getElementById("miniOccupiedBeds").textContent = t("hospital_page.beds_occupied", "{count} occupied", {
        count: data.beds.occupied,
      });
      document.getElementById("miniTotalStaff").textContent = (data.totalStaff || 0).toLocaleString("en-IN");
      document.getElementById("miniStaffSub").textContent = t("hospital_page.total_staff_sub", "{count} staff on record", {
        count: data.totalStaff,
      });

      const updatedHint = document.getElementById("overviewUpdatedHint");
      if (updatedHint) {
        updatedHint.textContent = t("hospital_page.overview_updated", "Live — last updated {time}", {
          time: new Date().toLocaleTimeString(),
        });
      }
    } catch (err) {
      // Leave the cards showing their last successfully loaded values.
    }
  }

  function wireOverviewControls() {
    const datePicker = document.getElementById("overviewDatePicker");
    const downloadBtn = document.getElementById("downloadReportBtn");
    if (datePicker) datePicker.addEventListener("change", loadOverview);
    if (downloadBtn) downloadBtn.addEventListener("click", downloadOverviewReport);
  }

  // ---------- Hospital Settings: custom logo ----------

  async function loadLogoPreview() {
    const box = document.getElementById("logoPreviewBox");
    if (!box) return;
    const img = document.getElementById("logoPreviewImg");
    const emptyState = document.getElementById("logoPreviewEmpty");
    const removeBtn = document.getElementById("removeLogoBtn");
    try {
      const res = await fetch("/api/hospital/me", { credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) return;
      if (data.hospital.logoUrl) {
        img.src = data.hospital.logoUrl + "?v=" + Date.now();
        img.hidden = false;
        emptyState.hidden = true;
        if (removeBtn) removeBtn.hidden = false;
      } else {
        img.hidden = true;
        emptyState.hidden = false;
        if (removeBtn) removeBtn.hidden = true;
      }
    } catch (err) {
      // Leave whatever was last shown.
    }
  }

  function wireHospitalLogoSettings() {
    const uploadBtn = document.getElementById("uploadLogoBtn");
    if (!uploadBtn) return;
    loadLogoPreview();

    uploadBtn.addEventListener("click", async () => {
      const errorEl = document.getElementById("logoError");
      const resultEl = document.getElementById("logoResult");
      errorEl.textContent = "";
      resultEl.textContent = "";
      const fileInput = document.getElementById("logoFileInput");
      const file = fileInput.files[0];
      if (!file) {
        errorEl.textContent = t("hospital_page.choose_logo_first", "Choose an image file first.");
        return;
      }
      const formData = new FormData();
      formData.append("logo", file);

      uploadBtn.disabled = true;
      try {
        const res = await fetch("/api/hospital/logo", { method: "POST", credentials: "same-origin", body: formData });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("hospital_page.logo_upload_failed", "Could not upload this logo.");
          return;
        }
        fileInput.value = "";
        resultEl.textContent = t("hospital_page.logo_upload_success", "Logo updated — your staff and patients will see it now.");
        if (window.showToast) showToast(t("hospital_page.logo_upload_success", "Logo updated — your staff and patients will see it now."), "success");
        loadLogoPreview();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        uploadBtn.disabled = false;
      }
    });

    const removeBtn = document.getElementById("removeLogoBtn");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        if (!confirm(t("hospital_page.confirm_remove_logo", "Remove your custom logo? Everyone will see the default CORE5 MEDISYS logo again."))) return;
        const errorEl = document.getElementById("logoError");
        errorEl.textContent = "";
        removeBtn.disabled = true;
        try {
          const res = await fetch("/api/hospital/logo", { method: "DELETE", credentials: "same-origin" });
          const data = await res.json();
          if (!data.success) {
            errorEl.textContent = data.message || t("hospital_page.logo_remove_failed", "Could not remove this logo.");
            return;
          }
          if (window.showToast) showToast(t("hospital_page.logo_removed_toast", "Logo removed."), "success");
          loadLogoPreview();
        } catch (err) {
          errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
        } finally {
          removeBtn.disabled = false;
        }
      });
    }
  }

  // ---------- Hospital Settings: footer brand name ----------

  async function loadBrandNameStatus() {
    const input = document.getElementById("brandNameInput");
    if (!input) return;
    const hint = document.getElementById("brandNameCurrentHint");
    const resetBtn = document.getElementById("resetBrandNameBtn");
    try {
      const res = await fetch("/api/hospital/me", { credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) return;
      const brandName = data.hospital.brandName;
      input.value = brandName || "";
      if (hint) {
        hint.textContent = brandName
          ? t("hospital_page.brand_name_current", "Currently showing: {name}", { name: brandName })
          : t("hospital_page.brand_name_using_default", "Currently showing the default: CORE5 MEDISYS.");
      }
      if (resetBtn) resetBtn.hidden = !brandName;
    } catch (err) {
      // Leave whatever was last shown.
    }
  }

  function wireHospitalBrandName() {
    const saveBtn = document.getElementById("saveBrandNameBtn");
    if (!saveBtn) return;
    loadBrandNameStatus();

    saveBtn.addEventListener("click", async () => {
      const errorEl = document.getElementById("brandNameError");
      const resultEl = document.getElementById("brandNameResult");
      errorEl.textContent = "";
      resultEl.textContent = "";
      const input = document.getElementById("brandNameInput");
      const brandName = input.value.trim();
      if (!brandName) {
        errorEl.textContent = t("hospital_page.brand_name_required", "Type a name, or use Reset to Default.");
        return;
      }

      saveBtn.disabled = true;
      try {
        const res = await fetch("/api/hospital/brand-name", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandName }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("hospital_page.brand_name_save_failed", "Could not save this name.");
          return;
        }
        resultEl.textContent = t("hospital_page.brand_name_save_success", "Footer updated — your staff and patients will see it now.");
        if (window.showToast) showToast(t("hospital_page.brand_name_save_success", "Footer updated — your staff and patients will see it now."), "success");
        loadBrandNameStatus();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        saveBtn.disabled = false;
      }
    });

    const resetBtn = document.getElementById("resetBrandNameBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        const errorEl = document.getElementById("brandNameError");
        const resultEl = document.getElementById("brandNameResult");
        errorEl.textContent = "";
        resultEl.textContent = "";
        resetBtn.disabled = true;
        try {
          const res = await fetch("/api/hospital/brand-name", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ brandName: "" }),
          });
          const data = await res.json();
          if (!data.success) {
            errorEl.textContent = data.message || t("hospital_page.brand_name_reset_failed", "Could not reset this name.");
            return;
          }
          if (window.showToast) showToast(t("hospital_page.brand_name_reset_success", "Reset to the default CORE5 MEDISYS branding."), "success");
          loadBrandNameStatus();
        } catch (err) {
          errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
        } finally {
          resetBtn.disabled = false;
        }
      });
    }
  }

  // ---------- Message a Staff Member ----------

  async function loadStaffOptionsForMessaging() {
    const select = document.getElementById("messageStaffSelect");
    if (!select) return;
    const res = await fetch("/api/hospital/staff", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    select.innerHTML = data.staff
      .map((s) => `<option value="${escapeHtml(s.user_id)}">${escapeHtml(s.full_name)} — ${escapeHtml(getRoleLabel(s.role))} (${escapeHtml(s.user_id)})</option>`)
      .join("");
  }

  async function loadSentMessages() {
    const body = document.getElementById("sentMessagesTableBody");
    const emptyState = document.getElementById("sentMessagesEmptyState");
    if (!body) return;
    const res = await fetch("/api/hospital/messages", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success || data.messages.length === 0) {
      body.innerHTML = "";
      if (emptyState) emptyState.hidden = false;
      return;
    }
    if (emptyState) emptyState.hidden = true;
    body.innerHTML = data.messages
      .map(
        (m) => `<tr>
          <td>${escapeHtml(m.to_name || m.to_user_id)}</td>
          <td>${escapeHtml(m.message)}</td>
          <td><span class="queue-status ${m.is_read ? "completed" : "waiting"}">${m.is_read ? escapeHtml(t("hospital_page.read_label", "Read")) : escapeHtml(t("hospital_page.unread_label", "Unread"))}</span></td>
          <td>${escapeHtml(new Date(m.created_at).toLocaleString())}</td>
        </tr>`
      )
      .join("");
  }

  function wireStaffMessaging() {
    const btn = document.getElementById("sendStaffMessageBtn");
    if (!btn) return;
    loadStaffOptionsForMessaging();
    loadSentMessages();

    btn.addEventListener("click", async () => {
      const errorEl = document.getElementById("messageStaffError");
      const resultEl = document.getElementById("messageStaffResult");
      errorEl.textContent = "";
      resultEl.textContent = "";
      const toUserId = document.getElementById("messageStaffSelect").value;
      const message = document.getElementById("messageStaffText").value.trim();
      if (!toUserId) {
        errorEl.textContent = t("hospital_page.choose_recipient", "Choose a staff member.");
        return;
      }
      if (!message) {
        errorEl.textContent = t("hospital_page.write_message", "Write a message first.");
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch("/api/hospital/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ toUserId, message }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("hospital_page.message_send_failed", "Could not send this message.");
          return;
        }
        document.getElementById("messageStaffText").value = "";
        resultEl.textContent = t("hospital_page.message_sent_confirm", "Message sent.");
        if (window.showToast) showToast(t("hospital_page.message_sent_confirm", "Message sent."), "success");
        loadSentMessages();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- Expense Log ----------

  async function loadExpenses() {
    const body = document.getElementById("expensesTableBody");
    const emptyState = document.getElementById("expensesEmptyState");
    if (!body) return;
    const res = await fetch("/api/hospital/expenses", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success || data.expenses.length === 0) {
      body.innerHTML = "";
      if (emptyState) emptyState.hidden = false;
      return;
    }
    if (emptyState) emptyState.hidden = true;
    body.innerHTML = data.expenses
      .map(
        (e) => `<tr>
          <td>${escapeHtml(e.category)}</td>
          <td>${formatCurrency(e.amount)}</td>
          <td>${escapeHtml(e.note || "—")}</td>
          <td>${escapeHtml(new Date(e.expense_date).toLocaleDateString())}</td>
          <td><button type="button" class="icon-btn-delete delete-expense-btn" data-id="${e.id}">${escapeHtml(t("common.delete", "Delete"))}</button></td>
        </tr>`
      )
      .join("");

    body.querySelectorAll(".delete-expense-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(t("hospital_page.confirm_delete_expense", "Delete this expense entry?"))) return;
        const res2 = await fetch(`/api/hospital/expenses/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
        const data2 = await res2.json();
        if (data2.success) {
          loadExpenses();
          loadOverview();
        }
      });
    });
  }

  function wireExpenseLog() {
    const btn = document.getElementById("addExpenseBtn");
    if (!btn) return;
    const dateInput = document.getElementById("expenseDate");
    if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
    loadExpenses();

    btn.addEventListener("click", async () => {
      const errorEl = document.getElementById("expenseError");
      errorEl.textContent = "";
      const category = document.getElementById("expenseCategory").value.trim();
      const amount = document.getElementById("expenseAmount").value;
      const note = document.getElementById("expenseNote").value.trim();
      const expenseDate = document.getElementById("expenseDate").value;
      if (!category || !amount || Number(amount) <= 0) {
        errorEl.textContent = t("hospital_page.expense_invalid", "Enter a category and an amount greater than 0.");
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch("/api/hospital/expenses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ category, amount: Number(amount), note, expenseDate }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("hospital_page.expense_add_failed", "Could not add this expense.");
          return;
        }
        document.getElementById("expenseCategory").value = "";
        document.getElementById("expenseAmount").value = "";
        document.getElementById("expenseNote").value = "";
        if (window.showToast) showToast(t("hospital_page.expense_added_toast", "Expense added."), "success");
        loadExpenses();
        loadOverview();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function loadStaffCount() {
    const hint = document.getElementById("staffCountHint");
    if (!hint) return;
    const res = await fetch("/api/hospital/staff", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    const count = data.staff.length;
    if (count === 0) {
      hint.textContent = window.i18n ? window.i18n.t("hospital_page.staff_count_zero") : "No staff registered yet";
    } else if (count === 1) {
      hint.textContent = window.i18n ? window.i18n.t("hospital_page.staff_count_one", { count: 1 }) : "1 staff member";
    } else {
      hint.textContent = window.i18n ? window.i18n.t("hospital_page.staff_count_other", { count }) : `${count} staff members`;
    }
  }

  function initRolePicker() {
    const grid = document.getElementById("roleGrid");
    if (!grid) return;

    grid.innerHTML = Object.keys(ROLE_LABELS)
      .map(
        (role) => `
        <label class="module-card" data-role="${role}">
          <input type="radio" name="roleChoice" value="${role}" />
          <span class="module-card-icon">${ROLE_ICONS[role]}</span>
          <span class="module-card-label">${getRoleLabel(role)}</span>
        </label>`
      )
      .join("");

    const form = document.getElementById("staffForm");
    const formTitle = document.getElementById("staffFormTitle");
    const fieldsContainer = document.getElementById("roleFieldsContainer");

    grid.querySelectorAll(".module-card").forEach((card) => {
      const input = card.querySelector("input");
      input.addEventListener("change", async () => {
        grid.querySelectorAll(".module-card").forEach((c) => c.classList.toggle("selected", c === card));
        const role = card.dataset.role;
        formTitle.textContent = `${getRoleLabel(role)} Details`;
        fieldsContainer.innerHTML = (ROLE_FIELDS[role] || [])
          .map((field) => {
            if (field.type === "select") {
              const options = field.options
                .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
                .join("");
              return `<label for="field_${field.key}">${escapeHtml(field.label)}</label>
                <select id="field_${field.key}" data-field="${field.key}">${options}</select>`;
            }
            return `<label for="field_${field.key}">${escapeHtml(field.label)}</label>
              <input type="text" id="field_${field.key}" data-field="${field.key}" />`;
          })
          .join("");

        if (role === "doctor") {
          fieldsContainer.innerHTML += `<label for="doctorDepartmentSelect">Department</label>
            <select id="doctorDepartmentSelect"><option value="">Loading departments...</option></select>`;
          const res = await fetch("/api/departments", { credentials: "same-origin" });
          const data = await res.json();
          const select = document.getElementById("doctorDepartmentSelect");
          select.innerHTML = data.success && data.departments.length
            ? `<option value="">Select a department</option>` +
              data.departments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("")
            : `<option value="">No departments set up yet</option>`;
        }

        form.hidden = false;
        form.dataset.role = role;
      });
    });
  }

  const DESIGNATION_PREFIXES = {
    Pathologist: "PA",
    "Lab Assistant": "LA",
    Radiologist: "RA",
  };

  function wireSuggestButtons() {
    document.getElementById("suggestStaffUserIdBtn").addEventListener("click", () => {
      const form = document.getElementById("staffForm");
      const role = form.dataset.role || "staff";
      const prefixMap = {
        doctor: "DR",
        nurse: "NR",
        pharmacist: "PH",
        pathology_staff: "PT",
        receptionist: "OPD",
        billing_staff: "BS",
        blood_bank_staff: "BB",
      };
      let prefix = prefixMap[role] || "ST";
      if (role === "pathology_staff") {
        const designationEl = document.getElementById("field_designation");
        prefix = DESIGNATION_PREFIXES[designationEl?.value] || prefix;
      }
      const digits = Math.floor(1000 + Math.random() * 90000);
      document.getElementById("staffUserIdCustom").value = `${prefix}-${digits}`;
    });

    document.getElementById("suggestStaffPasswordBtn").addEventListener("click", () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
      let pw = "";
      for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
      document.getElementById("staffPasswordCustom").value = pw;
    });
  }

  function initAddStaff() {
    const form = document.getElementById("staffForm");
    if (!form) return;

    initRolePicker();
    wireSuggestButtons();

    const errorEl = document.getElementById("staffFormError");
    const submitBtn = document.getElementById("submitStaffBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.textContent = "";

      const role = form.dataset.role;
      const details = {};
      form.querySelectorAll("[data-field]").forEach((el) => {
        details[el.dataset.field] = el.value;
      });

      submitBtn.disabled = true;
      try {
        const res = await fetch("/api/hospital/staff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            role,
            fullName: document.getElementById("fullName").value.trim(),
            email: document.getElementById("email").value.trim(),
            phone: document.getElementById("phone").value.trim(),
            details,
            departmentId: document.getElementById("doctorDepartmentSelect")?.value || undefined,
            userId: document.getElementById("staffUserIdCustom").value.trim(),
            password: document.getElementById("staffPasswordCustom").value.trim(),
          }),
        });
        const data = await res.json();

        if (!data.success) {
          errorEl.textContent = data.message || t('hospital_page.could_not_add_staff', 'Could not add staff member. Please try again.');
          return;
        }

        form.hidden = true;
        document.getElementById("roleGrid").hidden = true;
        document.getElementById("staffUserIdOutput").value = data.staff.userId;
        document.getElementById("staffPasswordOutput").value = data.staff.password;
        document.getElementById("staffResult").hidden = false;
      } catch (err) {
        errorEl.textContent = t('hospital_page.unable_to_reach_server_retry', 'Unable to reach the server. Please try again.');
      } finally {
        submitBtn.disabled = false;
      }
    });

    function wireCopyButton(buttonId, inputId) {
      document.getElementById(buttonId).addEventListener("click", () => {
        const input = document.getElementById(inputId);
        input.select();
        navigator.clipboard.writeText(input.value).catch(() => {});
      });
    }
    wireCopyButton("copyStaffUserIdBtn", "staffUserIdOutput");
    wireCopyButton("copyStaffPasswordBtn", "staffPasswordOutput");

    document.getElementById("addAnotherBtn").addEventListener("click", () => {
      form.reset();
      document.querySelectorAll(".module-card.selected").forEach((c) => c.classList.remove("selected"));
      document.getElementById("roleFieldsContainer").innerHTML = "";
      document.getElementById("staffResult").hidden = true;
      document.getElementById("roleGrid").hidden = false;
      form.hidden = true;
    });
  }

  // Persists across re-renders of #staffGroups (realtime "staff" updates,
  // language changes) so a checkbox someone already ticked doesn't reset
  // out from under them mid-selection.
  const selectedStaffIds = new Set();

  function updateStaffBulkBar() {
    const bar = document.getElementById("staffBulkBar");
    if (!bar) return;
    const checkboxes = document.querySelectorAll(".staff-select-checkbox");
    const total = checkboxes.length;
    if (total === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    document.getElementById("staffSelectedCount").textContent = t(
      "hospital_page.staff_selected_count",
      "{count} selected",
      { count: selectedStaffIds.size }
    );
    document.getElementById("resetPasswordBtn").disabled = selectedStaffIds.size === 0;
    const selectAll = document.getElementById("staffSelectAll");
    selectAll.checked = selectedStaffIds.size > 0 && selectedStaffIds.size === total;
    selectAll.indeterminate = selectedStaffIds.size > 0 && selectedStaffIds.size < total;
  }

  async function initStaffList() {
    const container = document.getElementById("staffGroups");
    if (!container) return;

    if (window.MEDISYS_RT && !container.dataset.rtWired) {
      container.dataset.rtWired = "true";
      MEDISYS_RT.on("staff", initStaffList);
    }

    const res = await fetch("/api/hospital/staff", { credentials: "same-origin" });
    const data = await res.json();

    if (!data.success || data.staff.length === 0) {
      document.getElementById("staffEmptyState").hidden = false;
      return;
    }

    const grouped = {};
    data.staff.forEach((s) => {
      grouped[s.role] = grouped[s.role] || [];
      grouped[s.role].push(s);
    });

    container.innerHTML = Object.keys(ROLE_LABELS)
      .filter((role) => grouped[role]?.length)
      .map((role) => {
        const entries = grouped[role];
        const cards = entries
          .map((s) => {
            const details = (() => {
              try {
                return typeof s.details === "string" ? JSON.parse(s.details) : s.details || {};
              } catch {
                return {};
              }
            })();
            const summaryFn = ROLE_DETAIL_SUMMARY[role];
            const summary = summaryFn ? summaryFn(details) : "";
            const added = new Date(s.created_at).toLocaleDateString();
            const checked = selectedStaffIds.has(s.user_id);
            return `
              <div class="staff-entry-card${checked ? " staff-selected" : ""}">
                <input type="checkbox" class="staff-select-checkbox" data-user-id="${escapeHtml(s.user_id)}" aria-label="${escapeHtml(t('hospital_page.select_staff_member', 'Select {name}', { name: s.full_name }))}" ${checked ? "checked" : ""} />
                <div class="staff-entry-name">${escapeHtml(s.full_name)}</div>
                ${role === "doctor" && s.department_name ? `<div class="staff-entry-detail">${escapeHtml(s.department_name)}</div>` : ""}
                ${summary ? `<div class="staff-entry-detail">${escapeHtml(summary)}</div>` : ""}
                <div class="staff-entry-detail">${escapeHtml(s.email || "—")}${s.phone ? " · " + escapeHtml(s.phone) : ""}</div>
                <div class="staff-entry-detail">${window.i18n ? window.i18n.t("hospital_page.added_on") : "Added"} ${escapeHtml(added)}</div>
                <span class="staff-entry-userid">${escapeHtml(s.user_id)}</span>
                ${role === "doctor" ? `
                <div class="staff-fee-row">
                  <label for="fee_${escapeHtml(s.user_id)}">Telemedicine fee (₹)</label>
                  <input type="number" min="0" step="1" id="fee_${escapeHtml(s.user_id)}" class="staff-fee-input" value="${escapeHtml(details.consultationFee || "")}" placeholder="Not set" />
                  <button type="button" class="staff-fee-save-btn" data-user-id="${escapeHtml(s.user_id)}">Save</button>
                  <span class="staff-fee-status" data-status-for="${escapeHtml(s.user_id)}"></span>
                </div>` : ""}
              </div>`;
          })
          .join("");

        return `
          <div class="staff-group-section">
            <h2 class="staff-group-heading">${getRoleLabelPlural(role)} <span class="staff-group-count">${entries.length}</span></h2>
            <div class="staff-roster-grid">${cards}</div>
          </div>`;
      })
      .join("");

    // Drop any selected user_id that no longer exists in this render (e.g.
    // removed elsewhere) so the count/select-all state stays accurate.
    const stillPresent = new Set([...container.querySelectorAll(".staff-select-checkbox")].map((cb) => cb.dataset.userId));
    [...selectedStaffIds].forEach((id) => {
      if (!stillPresent.has(id)) selectedStaffIds.delete(id);
    });

    container.querySelectorAll(".staff-select-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.userId;
        if (cb.checked) selectedStaffIds.add(id);
        else selectedStaffIds.delete(id);
        cb.closest(".staff-entry-card").classList.toggle("staff-selected", cb.checked);
        updateStaffBulkBar();
      });
    });
    updateStaffBulkBar();

    container.querySelectorAll(".staff-fee-save-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId;
        const input = document.getElementById(`fee_${userId}`);
        const statusEl = container.querySelector(`[data-status-for="${userId}"]`);
        const fee = input.value.trim();
        if (!fee || Number(fee) <= 0) {
          statusEl.textContent = t('hospital_page.enter_fee_valid', 'Enter a fee > 0.');
          statusEl.className = "staff-fee-status error";
          return;
        }
        btn.disabled = true;
        try {
          const res = await fetch(`/api/hospital/staff/${encodeURIComponent(userId)}/fee`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ consultationFee: Number(fee) }),
          });
          const data = await res.json();
          statusEl.textContent = data.success ? t('common.saved', 'Saved.') : data.message || t('hospital_page.could_not_save', 'Could not save.');
          statusEl.className = "staff-fee-status" + (data.success ? "" : " error");
        } catch {
          statusEl.textContent = t('hospital_page.unable_to_reach_server', 'Unable to reach the server.');
          statusEl.className = "staff-fee-status error";
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // Wired once — the bulk bar and reset panel live outside #staffGroups, so
  // unlike the per-card listeners above they survive every re-render.
  function wireStaffBulkPasswordReset() {
    const selectAllCb = document.getElementById("staffSelectAll");
    if (!selectAllCb) return;

    selectAllCb.addEventListener("change", () => {
      document.querySelectorAll(".staff-select-checkbox").forEach((cb) => {
        cb.checked = selectAllCb.checked;
        const id = cb.dataset.userId;
        if (selectAllCb.checked) selectedStaffIds.add(id);
        else selectedStaffIds.delete(id);
        cb.closest(".staff-entry-card").classList.toggle("staff-selected", cb.checked);
      });
      updateStaffBulkBar();
    });

    const panel = document.getElementById("resetPasswordPanel");
    const errorEl = document.getElementById("resetPasswordError");
    const resultEl = document.getElementById("resetPasswordResult");
    const pwdInput = document.getElementById("resetPasswordInput");
    const confirmInput = document.getElementById("resetPasswordConfirmInput");

    document.getElementById("resetPasswordBtn").addEventListener("click", () => {
      if (selectedStaffIds.size === 0) return;
      document.getElementById("resetPasswordTargetHint").textContent = t(
        "hospital_page.reset_password_target_hint",
        "This sets a new password for {count} staff member(s). Share it with them directly — they'll need it to log in.",
        { count: selectedStaffIds.size }
      );
      pwdInput.value = "";
      confirmInput.value = "";
      errorEl.textContent = "";
      resultEl.textContent = "";
      panel.hidden = false;
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
      pwdInput.focus();
    });

    document.getElementById("cancelResetPasswordBtn").addEventListener("click", () => {
      panel.hidden = true;
    });

    document.getElementById("confirmResetPasswordBtn").addEventListener("click", async () => {
      errorEl.textContent = "";
      const pwd = pwdInput.value;
      const confirmPwd = confirmInput.value;

      if (!pwd || !confirmPwd) {
        errorEl.textContent = t("hospital_page.password_required", "Enter and confirm the new password.");
        return;
      }
      if (pwd.length < 6) {
        errorEl.textContent = t("hospital_page.password_too_short", "Password must be at least 6 characters.");
        return;
      }
      if (pwd !== confirmPwd) {
        errorEl.textContent = t("hospital_page.passwords_dont_match", "Passwords don't match.");
        return;
      }
      if (selectedStaffIds.size === 0) {
        errorEl.textContent = t("hospital_page.select_at_least_one_staff", "Select at least one staff member.");
        return;
      }

      const btn = document.getElementById("confirmResetPasswordBtn");
      btn.disabled = true;
      try {
        const res = await fetch("/api/hospital/staff/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ userIds: [...selectedStaffIds], newPassword: pwd }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("hospital_page.reset_password_failed", "Could not reset password.");
          return;
        }
        resultEl.textContent = t("hospital_page.reset_password_success", "Password reset for {count} staff member(s).", {
          count: data.updatedCount,
        });
        if (window.showToast) showToast(t("hospital_page.reset_password_toast", "Password reset."), "success");

        selectedStaffIds.clear();
        selectAllCb.checked = false;
        setTimeout(() => {
          panel.hidden = true;
          resultEl.textContent = "";
        }, 3000);

        initStaffList();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function initDepartments() {
    const table = document.getElementById("departmentsTable");
    if (!table) return;

    async function loadDepartments() {
      const res = await fetch("/api/departments", { credentials: "same-origin" });
      const data = await res.json();
      const tbody = document.getElementById("departmentsTableBody");
      const emptyState = document.getElementById("departmentsEmptyState");

      if (!data.success || data.departments.length === 0) {
        tbody.innerHTML = "";
        emptyState.hidden = false;
        return;
      }
      emptyState.hidden = true;

      tbody.innerHTML = data.departments
        .map(
          (d) => `<tr>
            <td>${escapeHtml(d.name)}</td>
            <td><button type="button" class="icon-btn-delete delete-dept-btn" data-id="${d.id}" aria-label="Delete ${escapeHtml(d.name)}">&times;</button></td>
          </tr>`
        )
        .join("");

      tbody.querySelectorAll(".delete-dept-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm(t('hospital_page.confirm_remove_department', 'Remove this department? Doctors assigned to it will become unassigned.'))) return;
          await fetch(`/api/departments/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
          loadDepartments();
        });
      });
    }

    document.getElementById("addDepartmentBtn").addEventListener("click", async () => {
      const input = document.getElementById("departmentName");
      const errorEl = document.getElementById("departmentFormError");
      errorEl.textContent = "";
      const name = input.value.trim();
      if (!name) {
        errorEl.textContent = t('hospital_page.department_name_required', 'Department name is required.');
        return;
      }
      const res = await fetch("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('hospital_page.could_not_add_department', 'Could not add department.');
        return;
      }
      input.value = "";
      loadDepartments();
    });

    loadDepartments();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("departments", loadDepartments);
    }
  }

  const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  async function initNurseAssignment() {
    const modeSelect = document.getElementById("assignmentModeSelect");
    if (!modeSelect) return;

    const [staffRes, wardsRes] = await Promise.all([
      fetch("/api/hospital/staff", { credentials: "same-origin" }).then((r) => r.json()),
      fetch("/api/wards", { credentials: "same-origin" }).then((r) => r.json()),
    ]);
    const doctors = staffRes.success ? staffRes.staff.filter((s) => s.role === "doctor") : [];
    const nurses = staffRes.success ? staffRes.staff.filter((s) => s.role === "nurse") : [];
    const wards = wardsRes.success ? wardsRes.wards : [];

    function optionsFor(list) {
      return list.length
        ? list.map((s) => `<option value="${escapeHtml(s.user_id)}">${escapeHtml(s.full_name)}</option>`).join("")
        : `<option value="">None registered yet</option>`;
    }

    document.getElementById("rosterNurseSelect").innerHTML = optionsFor(nurses);
    document.getElementById("teamNurseSelect").innerHTML = optionsFor(nurses);
    document.getElementById("teamDoctorSelect").innerHTML = optionsFor(doctors);
    document.getElementById("rosterWardSelect").innerHTML = wards.length
      ? wards.map((w) => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join("")
      : `<option value="">No wards set up yet</option>`;

    const hospitalRes = await fetch("/api/hospital/me", { credentials: "same-origin" }).then((r) => r.json());
    const currentMode = hospitalRes.success ? hospitalRes.hospital.nurse_assignment_mode : "ward_based";
    modeSelect.value = currentMode;
    document.getElementById("teamsSection").hidden = currentMode !== "doctor_team";

    modeSelect.addEventListener("change", async () => {
      const hint = document.getElementById("modeSaveHint");
      hint.textContent = t('common.saving', 'Saving...');
      const res = await fetch("/api/hospital/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ nurseAssignmentMode: modeSelect.value }),
      });
      const data = await res.json();
      hint.textContent = data.success ? t('common.saved', 'Saved.') : data.message || t('hospital_page.could_not_save', 'Could not save.');
      document.getElementById("teamsSection").hidden = modeSelect.value !== "doctor_team";
      if (data.success) loadTeams();
    });

    async function loadRoster() {
      const res = await fetch("/api/nurse-roster", { credentials: "same-origin" });
      const data = await res.json();
      const tbody = document.getElementById("rosterTableBody");
      const emptyState = document.getElementById("rosterEmptyState");

      if (!data.success || data.roster.length === 0) {
        tbody.innerHTML = "";
        emptyState.hidden = false;
        return;
      }
      emptyState.hidden = true;

      tbody.innerHTML = data.roster
        .map(
          (r) => `<tr>
            <td>${escapeHtml(r.nurse_name || r.nurse_user_id)}</td>
            <td>${escapeHtml(r.ward_name || "—")}</td>
            <td>${escapeHtml(r.shift)}</td>
            <td>${DAY_LABELS[r.day_of_week] || r.day_of_week}</td>
            <td><button type="button" class="icon-btn-delete delete-roster-btn" data-id="${r.id}" aria-label="Remove">&times;</button></td>
          </tr>`
        )
        .join("");

      tbody.querySelectorAll(".delete-roster-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await fetch(`/api/nurse-roster/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
          loadRoster();
        });
      });
    }

    document.getElementById("addRosterBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("rosterFormError");
      errorEl.textContent = "";
      const nurseUserId = document.getElementById("rosterNurseSelect").value;
      const wardId = document.getElementById("rosterWardSelect").value;
      if (!nurseUserId || !wardId) {
        errorEl.textContent = t('hospital_page.nurse_ward_required', 'A registered nurse and an existing ward are required.');
        return;
      }
      const res = await fetch("/api/nurse-roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          nurseUserId,
          wardId,
          shift: document.getElementById("rosterShiftSelect").value,
          dayOfWeek: Number(document.getElementById("rosterDaySelect").value),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('hospital_page.could_not_add_roster', 'Could not add roster entry.');
        return;
      }
      loadRoster();
    });

    async function loadTeams() {
      const res = await fetch("/api/doctor-nurse-teams", { credentials: "same-origin" });
      const data = await res.json();
      const tbody = document.getElementById("teamsTableBody");
      const emptyState = document.getElementById("teamsEmptyState");

      if (!data.success || data.teams.length === 0) {
        tbody.innerHTML = "";
        emptyState.hidden = false;
        return;
      }
      emptyState.hidden = true;

      tbody.innerHTML = data.teams
        .map(
          (t) => `<tr>
            <td>${escapeHtml(t.doctor_name || t.doctor_user_id)}</td>
            <td>${escapeHtml(t.nurse_name || t.nurse_user_id)}</td>
            <td><button type="button" class="icon-btn-delete delete-team-btn" data-id="${t.id}" aria-label="Remove">&times;</button></td>
          </tr>`
        )
        .join("");

      tbody.querySelectorAll(".delete-team-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await fetch(`/api/doctor-nurse-teams/${btn.dataset.id}`, { method: "DELETE", credentials: "same-origin" });
          loadTeams();
        });
      });
    }

    document.getElementById("addTeamBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("teamFormError");
      errorEl.textContent = "";
      const doctorUserId = document.getElementById("teamDoctorSelect").value;
      const nurseUserId = document.getElementById("teamNurseSelect").value;
      if (!doctorUserId || !nurseUserId) {
        errorEl.textContent = t('hospital_page.doctor_nurse_required', 'A registered doctor and nurse are required.');
        return;
      }
      const res = await fetch("/api/doctor-nurse-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ doctorUserId, nurseUserId }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('hospital_page.could_not_add_team', 'Could not add team.');
        return;
      }
      loadTeams();
    });

    loadRoster();
    loadTeams();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("nurse_roster", () => {
        loadRoster();
        loadTeams();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadHospital();
    loadStaffCount();
    loadOutbreakAlerts();
    wireOverviewControls();
    loadOverview();
    wireHospitalLogoSettings();
    wireHospitalBrandName();
    wireStaffMessaging();
    wireExpenseLog();
    initAddStaff();
    initStaffList();
    wireStaffBulkPasswordReset();
    initDepartments();
    initNurseAssignment();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("staff", loadStaffCount);
      MEDISYS_RT.on("staff", loadOverview);
      MEDISYS_RT.on("hospitals", loadHospital);
      MEDISYS_RT.on("disease_alerts", (payload) => {
        loadOutbreakAlerts();
        if (window.showToast) {
          showToast(t('hospital_page.outbreak_toast', '⚠ Outbreak alert: {diagnosis} — {caseCount} recent cases.', { diagnosis: payload.diagnosis, caseCount: payload.caseCount }), "error");
        }
      });
      // The dashboard should feel genuinely live — refresh the overview
      // stat cards whenever anything that feeds them changes anywhere else
      // in the app, not just on page load.
      ["patients", "ipd_admissions", "opd_queue", "billing_payments", "pharmacy_invoices", "bloodbank_billing", "hospital_expenses"].forEach(
        (resource) => MEDISYS_RT.on(resource, loadOverview)
      );
      MEDISYS_RT.on("hospital_expenses", loadExpenses);
      MEDISYS_RT.on("staff_messages_sent", loadSentMessages);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadHospital();
      loadStaffCount();
      initRolePicker();
      initStaffList();
    });
  });
})();
