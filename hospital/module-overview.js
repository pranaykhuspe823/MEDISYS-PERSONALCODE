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

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d)) return escapeHtml(v);
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  }

  function fmtDateTime(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (isNaN(d)) return escapeHtml(v);
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function inr(v) {
    const n = Number(v) || 0;
    return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function badge(value) {
    if (value === null || value === undefined || value === "") return "—";
    const cls = "status-" + String(value).toLowerCase().replace(/\s+/g, "_");
    return `<span class="ov-badge ${cls}">${escapeHtml(value)}</span>`;
  }

  // Shared column shape for the three lab-orders-backed modules (radiology,
  // pathology, laboratory) — they only differ in which rows are included.
  const LAB_ORDER_COLUMNS = [
    { key: "patient_name", label: () => t("hospital_page.ov_col_patient", "Patient") },
    { key: "test_name", label: () => t("hospital_page.ov_col_test", "Test / Study") },
    { key: "doctor_name", label: () => t("hospital_page.ov_col_ordering_doctor", "Ordering Doctor") },
    { key: "assigned_to_name", label: () => t("hospital_page.ov_col_assigned_to", "Assigned To"), empty: () => t("hospital_page.ov_unclaimed", "Unclaimed") },
    { key: "priority", label: () => t("hospital_page.ov_col_priority", "Priority"), badge: true },
    { key: "status", label: () => t("hospital_page.ov_col_status", "Status"), badge: true },
    { key: "created_at", label: () => t("hospital_page.ov_col_ordered", "Ordered"), formatter: fmtDateTime },
  ];

  // ---- module registry ----
  // Each module maps to a read endpoint the backend already authorizes
  // hospital_admin for (see server/server.js: requireBillingStaff,
  // requireRole(...,"hospital_admin"), requireTenantUser) — this page never
  // calls any staff mutation endpoint (claim/dispense/verify/collect etc.),
  // it is read-only by construction.
  //
  // Note on Pathology vs Laboratory: the data model has one "Pathology"
  // department covering both tissue/biopsy work (category "Histopathology")
  // and routine blood/urine/serology testing (Hematology, Biochemistry,
  // Microbiology, Serology). There's no separate "Laboratory" department in
  // the schema, so this page splits that one department by category to give
  // the two dashboard modules distinct, non-overlapping content. Adjust the
  // filterRows below if that split doesn't match how your hospital actually
  // divides the two teams.
  const MODULES = {
    opd: {
      title: () => t("hospital_page.overview_opd_title", "OPD — Queue"),
      subtitle: () => t("hospital_page.overview_opd_subtitle", "Every OPD visit for the selected date — patient, doctor, and status."),
      topic: "opd_queue",
      dataKey: "queue",
      needsDate: true,
      endpoint: (date) => `/api/opd/queue?date=${encodeURIComponent(date)}`,
      columns: [
        { key: "token_number", label: () => t("hospital_page.ov_col_token", "Token") },
        { key: "patient_name", label: () => t("hospital_page.ov_col_patient", "Patient") },
        { key: "doctor_name", label: () => t("hospital_page.ov_col_doctor", "Doctor") },
        { key: "slot_time", label: () => t("hospital_page.ov_col_slot", "Slot") },
        { key: "source", label: () => t("hospital_page.ov_col_source", "Source") },
        { key: "status", label: () => t("hospital_page.ov_col_status", "Status"), badge: true },
      ],
    },
    radiology: {
      title: () => t("hospital_page.overview_radiology_title", "Radiology — Orders"),
      subtitle: () => t("hospital_page.overview_radiology_subtitle", "Every radiology order: who ordered it, who it's assigned to, and its status."),
      topic: "lab_orders",
      dataKey: "orders",
      endpoint: () => `/api/lab-orders?department=Radiology`,
      columns: LAB_ORDER_COLUMNS,
    },
    pathology: {
      title: () => t("hospital_page.overview_pathology_title", "Pathology — Histopathology Orders"),
      subtitle: () => t("hospital_page.overview_pathology_subtitle", "Tissue/biopsy-based pathology orders. Routine blood/urine/serology tests are under Laboratory."),
      topic: "lab_orders",
      dataKey: "orders",
      endpoint: () => `/api/lab-orders?department=Pathology`,
      filterRows: (r) => r.category === "Histopathology",
      columns: LAB_ORDER_COLUMNS,
    },
    laboratory: {
      title: () => t("hospital_page.overview_laboratory_title", "Laboratory — Test Orders"),
      subtitle: () => t("hospital_page.overview_laboratory_subtitle", "Hematology, biochemistry, microbiology, and serology test orders. Biopsy-based pathology is under Pathology."),
      topic: "lab_orders",
      dataKey: "orders",
      endpoint: () => `/api/lab-orders?department=Pathology`,
      filterRows: (r) => r.category !== "Histopathology",
      columns: LAB_ORDER_COLUMNS,
    },
    pharmacy: {
      title: () => t("hospital_page.overview_pharmacy_title", "Pharmacy — Medicine Orders"),
      subtitle: () => t("hospital_page.overview_pharmacy_subtitle", "Every prescribed medicine, its dispense status, and who dispensed it."),
      topic: "pharmacy_orders",
      dataKey: "orders",
      endpoint: () => `/api/pharmacy-orders`,
      columns: [
        { key: "patient_name", label: () => t("hospital_page.ov_col_patient", "Patient") },
        { key: "medicine_name", label: () => t("hospital_page.ov_col_medicine", "Medicine") },
        { key: "dosage", label: () => t("hospital_page.ov_col_dosage", "Dosage") },
        { key: "duration", label: () => t("hospital_page.ov_col_duration", "Duration") },
        { key: "status", label: () => t("hospital_page.ov_col_status", "Status"), badge: true },
        { key: "dispensed_by", label: () => t("hospital_page.ov_col_dispensed_by", "Dispensed By") },
        { key: "created_at", label: () => t("hospital_page.ov_col_prescribed", "Prescribed"), formatter: fmtDateTime },
      ],
    },
    billing: {
      title: () => t("hospital_page.overview_billing_title", "Billing & Insurance — Bills"),
      subtitle: () => t("hospital_page.overview_billing_subtitle", "Every bill raised, amounts, and payment status."),
      topic: "billing_bills",
      dataKey: "bills",
      endpoint: () => `/api/billing/bills`,
      columns: [
        { key: "bill_no", label: () => t("hospital_page.ov_col_bill_no", "Bill No") },
        { key: "patient_name", label: () => t("hospital_page.ov_col_patient", "Patient") },
        { key: "department", label: () => t("hospital_page.ov_col_department", "Department") },
        { key: "doctor_name", label: () => t("hospital_page.ov_col_doctor", "Doctor") },
        { key: "bill_date", label: () => t("hospital_page.ov_col_date", "Date"), formatter: fmtDate },
        { key: "total_amount", label: () => t("hospital_page.ov_col_total", "Total"), formatter: inr },
        { key: "paid_amount", label: () => t("hospital_page.ov_col_paid", "Paid"), formatter: inr },
        { key: "balance_amount", label: () => t("hospital_page.ov_col_balance", "Balance"), formatter: inr },
        { key: "status", label: () => t("hospital_page.ov_col_status", "Status"), badge: true },
      ],
    },
  };

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

  let allRows = [];
  let config = null;
  let dateValue = todayStr();

  function renderTable() {
    const table = document.getElementById("overviewTable");
    const headRow = document.getElementById("overviewHeadRow");
    const body = document.getElementById("overviewBody");
    const emptyEl = document.getElementById("overviewEmpty");
    const query = (document.getElementById("ovSearch")?.value || "").trim().toLowerCase();

    const rows = query
      ? allRows.filter((r) => config.columns.some((c) => String(r[c.key] ?? "").toLowerCase().includes(query)))
      : allRows;

    headRow.innerHTML = config.columns.map((c) => `<th>${escapeHtml(c.label())}</th>`).join("");
    body.innerHTML = rows
      .map((r) => {
        const cells = config.columns
          .map((c) => {
            const raw = r[c.key];
            if (c.badge) return `<td>${badge(raw)}</td>`;
            if (raw === null || raw === undefined || raw === "") {
              return `<td>${escapeHtml(typeof c.empty === "function" ? c.empty() : c.empty || "—")}</td>`;
            }
            return `<td>${c.formatter ? c.formatter(raw) : escapeHtml(raw)}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");

    const count = document.getElementById("ovCount");
    if (count) count.textContent = `${rows.length} ${rows.length === 1 ? t("hospital_page.ov_row", "row") : t("hospital_page.ov_rows", "rows")}`;

    table.hidden = rows.length === 0;
    emptyEl.hidden = rows.length !== 0;
  }

  async function loadData() {
    const errorEl = document.getElementById("overviewError");
    errorEl.hidden = true;
    try {
      const res = await fetch(config.endpoint(dateValue), { credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t("hospital_page.ov_load_error", "Could not load this module's data.");
        errorEl.hidden = false;
        document.getElementById("overviewTable").hidden = true;
        document.getElementById("overviewEmpty").hidden = true;
        return;
      }
      let rows = data[config.dataKey] || [];
      if (config.filterRows) rows = rows.filter(config.filterRows);
      allRows = rows;
      renderTable();
    } catch (err) {
      errorEl.textContent = t("hospital_page.ov_unreachable", "Unable to reach the server. Please try again.");
      errorEl.hidden = false;
    }
  }

  function buildToolbar() {
    const toolbar = document.getElementById("overviewToolbar");
    let html = `<input type="search" id="ovSearch" placeholder="${escapeHtml(t("hospital_page.ov_search_placeholder", "Search this table…"))}" />`;
    if (config.needsDate) {
      html += `<input type="date" id="ovDate" value="${dateValue}" />`;
    }
    html += `<span class="overview-count" id="ovCount"></span>`;
    toolbar.innerHTML = html;

    document.getElementById("ovSearch").addEventListener("input", renderTable);
    if (config.needsDate) {
      document.getElementById("ovDate").addEventListener("change", (e) => {
        dateValue = e.target.value || todayStr();
        loadData();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();

    const params = new URLSearchParams(window.location.search);
    const moduleKey = params.get("module");
    config = MODULES[moduleKey];

    if (!config) {
      document.getElementById("overviewTitle").textContent = t("hospital_page.ov_unknown_module_title", "Unknown module");
      document.getElementById("overviewSubtitle").textContent = t(
        "hospital_page.ov_unknown_module_hint",
        "This module doesn't have an overview yet — go back to the dashboard and pick one from the Modules list."
      );
      return;
    }

    document.getElementById("overviewTitle").textContent = config.title();
    document.getElementById("overviewSubtitle").textContent = config.subtitle();
    document.title = `MEDISYS - ${config.title()}`;

    buildToolbar();
    await loadData();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on(config.topic, loadData);
    }

    window.addEventListener("i18n:languageChanged", () => {
      document.getElementById("overviewTitle").textContent = config.title();
      document.getElementById("overviewSubtitle").textContent = config.subtitle();
      buildToolbar();
      renderTable();
    });
  });
})();
