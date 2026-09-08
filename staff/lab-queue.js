(function () {
  let department = "Pathology";
  let activeOrderId = null;

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
    // hospital_admin gets read/oversight access too, mirroring the backend
    // routes (GET /api/lab-orders etc. already allow hospital_admin) — staff-
    // only mutation endpoints still enforce pathology_staff server-side, so
    // an admin viewing this page can't silently act as the technician.
    if (!data.user || (data.user.role !== "pathology_staff" && data.user.role !== "hospital_admin")) {
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

  async function configureForDesignation() {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    const designation = (data.success && data.profile.details && data.profile.details.designation) || "";
    department = designation === "Radiologist" ? "Radiology" : "Pathology";

    document.getElementById("queueHeading").textContent =
      department === "Radiology" ? t("navigation.radiology_queue", "Radiology Queue") : t("navigation.pathology_lab", "Pathology & Lab Queue");
    document.getElementById("queueSubtitle").textContent =
      department === "Radiology"
        ? t("dashboard.card_rad_hint", "Imaging orders sent by doctors, waiting to be claimed and reported.")
        : t("dashboard.card_path_hint", "Pathology and lab test orders sent by doctors, waiting to be claimed and resulted.");
  }

  async function loadUnclaimed() {
    const res = await fetch(`/api/lab-orders?department=${encodeURIComponent(department)}&scope=unclaimed`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    const tbody = document.getElementById("unclaimedTableBody");
    const emptyState = document.getElementById("unclaimedEmptyState");

    if (!data.success || data.orders.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.orders
      .map(
        (o) => `<tr>
          <td>${escapeHtml(o.patient_name || o.patient_uhid)}</td>
          <td>${escapeHtml(o.test_name)}</td>
          <td>Dr. ${escapeHtml(o.doctor_name || o.doctor_user_id)}</td>
          <td>${escapeHtml(new Date(o.created_at).toLocaleString())}</td>
          <td><button type="button" class="wizard-suggest-btn claim-btn" data-id="${o.id}">Claim</button></td>
        </tr>`
      )
      .join("");

    tbody.querySelectorAll(".claim-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const res = await fetch(`/api/lab-orders/${btn.dataset.id}/claim`, {
          method: "POST",
          credentials: "same-origin",
        });
        const data = await res.json();
        if (!data.success) {
          alert(data.message || t('lab_queue.could_not_claim_order', 'Could not claim this order.'));
          return;
        }
        loadUnclaimed();
        loadMine();
      });
    });
  }

  async function loadMine() {
    const res = await fetch(`/api/lab-orders?department=${encodeURIComponent(department)}&scope=mine`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    const tbody = document.getElementById("myQueueTableBody");
    const emptyState = document.getElementById("myQueueEmptyState");

    if (!data.success || data.orders.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.orders
      .map(
        (o) => `<tr>
          <td>${escapeHtml(o.patient_name || o.patient_uhid)}</td>
          <td>${escapeHtml(o.test_name)}</td>
          <td>Dr. ${escapeHtml(o.doctor_name || o.doctor_user_id)}</td>
          <td>${escapeHtml(new Date(o.created_at).toLocaleString())}</td>
          <td><button type="button" class="wizard-suggest-btn complete-btn" data-id="${o.id}" data-test="${escapeHtml(o.test_name)}" data-doctor="${escapeHtml(o.doctor_name || o.doctor_user_id)}" data-patient="${escapeHtml(o.patient_name || o.patient_uhid)}">Upload Result</button></td>
        </tr>`
      )
      .join("");

    tbody.querySelectorAll(".complete-btn").forEach((btn) => {
      btn.addEventListener("click", () =>
        openCompleteForm(btn.dataset.id, btn.dataset.test, btn.dataset.doctor, btn.dataset.patient)
      );
    });
  }

  async function loadCompleted() {
    const res = await fetch(`/api/lab-orders?department=${encodeURIComponent(department)}&scope=completed`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    const tbody = document.getElementById("completedTableBody");
    const emptyState = document.getElementById("completedEmptyState");

    if (!data.success || data.orders.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.orders
      .slice(0, 20)
      .map((o) => {
        const fileLink = o.result_file_name
          ? `<a href="/api/lab-orders/${o.id}/result-file" target="_blank" rel="noopener" class="file-view-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>${escapeHtml(o.result_file_name)}</a>`
          : "";
        return `<tr>
          <td>${escapeHtml(o.patient_name || o.patient_uhid)}</td>
          <td>${escapeHtml(o.test_name)}</td>
          <td>Dr. ${escapeHtml(o.doctor_name || o.doctor_user_id)}</td>
          <td>${escapeHtml(o.result_notes || "—")}${fileLink ? " " + fileLink : ""}</td>
          <td>${o.completed_at ? escapeHtml(new Date(o.completed_at).toLocaleString()) : "—"}</td>
        </tr>`;
      })
      .join("");
  }

  function openCompleteForm(orderId, testName, doctorName, patientName) {
    activeOrderId = orderId;
    document.getElementById("completeTitle").textContent = `${testName} — ${patientName}`;
    document.getElementById("completeSendToLine").textContent = `This result will be sent to Dr. ${doctorName}, who ordered it.`;
    document.getElementById("resultNotes").value = "";
    document.getElementById("resultFile").value = "";
    document.getElementById("resultFileName").textContent = "";
    document.getElementById("completeFormError").textContent = "";
    document.getElementById("completeSection").hidden = false;
    document.getElementById("completeSection").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function wireCompleteForm() {
    document.getElementById("resultFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      document.getElementById("resultFileName").textContent = file ? `Selected: ${file.name}` : "";
    });

    document.getElementById("cancelCompleteBtn").addEventListener("click", () => {
      activeOrderId = null;
      document.getElementById("completeSection").hidden = true;
    });

    document.getElementById("submitCompleteBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("completeFormError");
      errorEl.textContent = "";
      if (!activeOrderId) return;

      const formData = new FormData();
      formData.append("resultNotes", document.getElementById("resultNotes").value.trim());
      const fileInput = document.getElementById("resultFile");
      if (fileInput.files[0]) {
        formData.append("file", fileInput.files[0]);
      }

      const res = await fetch(`/api/lab-orders/${activeOrderId}/complete`, {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('lab_queue.could_not_complete_order', 'Could not complete this order.');
        return;
      }

      activeOrderId = null;
      document.getElementById("completeSection").hidden = true;
      loadMine();
      loadCompleted();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireCompleteForm();
    await configureForDesignation();
    loadUnclaimed();
    loadMine();
    loadCompleted();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("lab_orders", () => {
        loadUnclaimed();
        loadMine();
        loadCompleted();
      });
    }

    window.addEventListener("i18n:languageChanged", () => {
      configureForDesignation();
    });
  });
})();
