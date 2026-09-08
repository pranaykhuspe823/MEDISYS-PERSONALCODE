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

  const DECISION_LABELS = { prescribe: "Prescription", order_tests: "Tests Ordered", admit: "Admission Requested" };
  function formatDecisionLabel(decision) {
    return String(decision || "")
      .split(",")
      .map((d) => DECISION_LABELS[d.trim()] || d.trim())
      .filter(Boolean)
      .join(" + ") || "Consultation";
  }

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "doctor") {
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

  async function loadPatients() {
    const res = await fetch("/api/doctor/patients", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("patientsTableBody");
    const emptyState = document.getElementById("patientsEmptyState");

    if (!data.success || data.patients.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.patients
      .map((p) => {
        const reportBits = [];
        if (p.completed_report_count > 0) reportBits.push(`${p.completed_report_count} ready`);
        if (p.pending_report_count > 0) reportBits.push(`${p.pending_report_count} pending`);
        return `<tr>
          <td>${escapeHtml(p.full_name || p.uhid)}</td>
          <td>${escapeHtml(p.phone || "—")}</td>
          <td>${reportBits.length ? escapeHtml(reportBits.join(", ")) : "—"}</td>
          <td><button type="button" class="wizard-suggest-btn view-patient-btn" data-uhid="${escapeHtml(p.uhid)}" data-name="${escapeHtml(p.full_name || p.uhid)}">View Chart</button></td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".view-patient-btn").forEach((btn) => {
      btn.addEventListener("click", () => loadChart(btn.dataset.uhid, btn.dataset.name));
    });
  }

  let currentPatientUhid = null;

  function renderPatientDetailsView(p) {
    const rows = [
      ["Full name", p.full_name || "—"],
      ["UHID", p.uhid],
      ["Date of birth", p.dob ? new Date(p.dob).toLocaleDateString() : "—"],
      ["Gender", p.gender || "—"],
      ["Phone", p.phone || "—"],
      ["Address", p.address || "—"],
      ["Emergency contact", p.emergency_contact_name ? `${p.emergency_contact_name}${p.emergency_contact_phone ? " · " + p.emergency_contact_phone : ""}` : "—"],
      ["ABHA ID", p.abha_id || "—"],
      ["Category", p.category || "—"],
    ];
    document.getElementById("patientDetailsView").innerHTML = rows
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join("");
  }

  function populatePatientEditForm(p) {
    document.getElementById("editFullName").value = p.full_name || "";
    document.getElementById("editDob").value = p.dob ? new Date(p.dob).toISOString().slice(0, 10) : "";
    document.getElementById("editGender").value = p.gender || "";
    document.getElementById("editPhone").value = p.phone || "";
    document.getElementById("editAddress").value = p.address || "";
    document.getElementById("editEmergencyContactName").value = p.emergency_contact_name || "";
    document.getElementById("editEmergencyContactPhone").value = p.emergency_contact_phone || "";
    document.getElementById("editAbhaId").value = p.abha_id || "";
    document.getElementById("editCategory").value = p.category || "walk-in";
  }

  function wirePatientEdit() {
    document.getElementById("editPatientBtn").addEventListener("click", async () => {
      if (!currentPatientUhid) return;
      const res = await fetch(`/api/patients/${encodeURIComponent(currentPatientUhid)}`, { credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) return;
      populatePatientEditForm(data.patient);
      document.getElementById("patientEditError").textContent = "";
      document.getElementById("patientDetailsView").hidden = true;
      document.getElementById("editPatientBtn").hidden = true;
      document.getElementById("patientDetailsForm").hidden = false;
    });

    document.getElementById("cancelEditPatientBtn").addEventListener("click", () => {
      document.getElementById("patientDetailsForm").hidden = true;
      document.getElementById("patientDetailsView").hidden = false;
      document.getElementById("editPatientBtn").hidden = false;
    });

    document.getElementById("savePatientBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("patientEditError");
      errorEl.textContent = "";
      const fullName = document.getElementById("editFullName").value.trim();
      if (!fullName) {
        errorEl.textContent = t('doctor_patients.name_required', 'Patient name is required.');
        return;
      }
      const btn = document.getElementById("savePatientBtn");
      btn.disabled = true;
      try {
        const res = await fetch(`/api/patients/${encodeURIComponent(currentPatientUhid)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            fullName,
            dob: document.getElementById("editDob").value,
            gender: document.getElementById("editGender").value,
            phone: document.getElementById("editPhone").value.trim(),
            address: document.getElementById("editAddress").value.trim(),
            emergencyContactName: document.getElementById("editEmergencyContactName").value.trim(),
            emergencyContactPhone: document.getElementById("editEmergencyContactPhone").value.trim(),
            abhaId: document.getElementById("editAbhaId").value.trim(),
            category: document.getElementById("editCategory").value,
          }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t('doctor_patients.could_not_save', 'Could not save patient details.');
          return;
        }
        document.getElementById("patientDetailsForm").hidden = true;
        document.getElementById("patientDetailsView").hidden = false;
        document.getElementById("editPatientBtn").hidden = false;
        document.getElementById("detailHeading").textContent = `Patient Chart — ${fullName}`;
        if (window.showToast) showToast(t('doctor_patients.updated_toast', 'Patient details updated for {name}.', { name: fullName }), "success");
        loadChart(currentPatientUhid, fullName);
        loadPatients();
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function loadChart(uhid, name) {
    currentPatientUhid = uhid;
    const [historyRes, patientRes] = await Promise.all([
      fetch(`/api/patients/${encodeURIComponent(uhid)}/history`, { credentials: "same-origin" }),
      fetch(`/api/patients/${encodeURIComponent(uhid)}`, { credentials: "same-origin" }),
    ]);
    const data = await historyRes.json();
    const patientData = await patientRes.json();
    if (!data.success) return;

    if (patientData.success) {
      renderPatientDetailsView(patientData.patient);
      name = patientData.patient.full_name || name;
    }
    document.getElementById("patientDetailsForm").hidden = true;
    document.getElementById("patientDetailsView").hidden = false;
    document.getElementById("editPatientBtn").hidden = false;

    document.getElementById("detailSection").hidden = false;
    document.getElementById("detailHeading").textContent = `Patient Chart — ${name}`;
    document.getElementById("detailSection").scrollIntoView({ behavior: "smooth", block: "start" });

    const consultationsFeed = document.getElementById("consultationsFeed");
    consultationsFeed.innerHTML =
      data.history.consultations
        .map((c) => {
          const label = formatDecisionLabel(c.decision);
          return `<div class="chart-feed-item">
            <strong>${escapeHtml(label)}</strong> — ${escapeHtml(c.symptoms || "—")}
            ${c.notes ? `<div>${escapeHtml(c.notes)}</div>` : ""}
            <div class="chart-feed-meta">${escapeHtml(new Date(c.created_at).toLocaleString())}</div>
          </div>`;
        })
        .join("") || `<p class="wizard-hint">No consultations recorded yet.</p>`;

    const reportsFeed = document.getElementById("reportsFeed");
    reportsFeed.innerHTML =
      (data.history.labOrders || [])
        .map((o) => {
          const DONE_STATUSES = ["completed", "verified"];
          const isDone = DONE_STATUSES.includes(o.status);
          const statusLabel =
            { pending: "Ordered", in_progress: "In Progress", reported: "Reporting", completed: "Ready", verified: "Ready" }[
              o.status
            ] || o.status;
          const statusClass = isDone ? "completed" : o.status === "in_progress" || o.status === "reported" ? "in-consultation" : "waiting";
          const fileLink = o.result_file_name
            ? `<a href="/api/lab-orders/${o.id}/result-file" target="_blank" rel="noopener" class="file-view-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                ${escapeHtml(o.result_file_name)}
              </a>`
            : "";
          const imageLinks = (o.images || [])
            .map(
              (img) =>
                `<a href="/api/lab-orders/${o.id}/images/${img.id}" target="_blank" rel="noopener" class="file-view-link">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                  ${escapeHtml(img.fileName)}
                </a>`
            )
            .join(" ");
          return `<div class="chart-feed-item">
            <strong>${escapeHtml(o.test_name)}</strong> (${escapeHtml(o.category || o.department || "")}) —
            <span class="queue-status ${statusClass}">${escapeHtml(statusLabel)}</span>
            ${isDone ? `<div>${escapeHtml(o.result_notes || "No notes")}${fileLink ? " &middot; " + fileLink : ""}${imageLinks ? " &middot; " + imageLinks : ""}</div>` : ""}
            <div class="chart-feed-meta">Ordered ${escapeHtml(new Date(o.created_at).toLocaleString())}</div>
          </div>`;
        })
        .join("") || `<p class="wizard-hint">No lab or radiology orders yet.</p>`;

    const admissionsFeed = document.getElementById("admissionsFeed");
    admissionsFeed.innerHTML =
      data.history.admissions
        .map(
          (a) => `<div class="chart-feed-item">
            Admission (${escapeHtml(a.status)})
            <div class="chart-feed-meta">${escapeHtml(new Date(a.created_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">No admissions.</p>`;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wirePatientEdit();
    loadPatients();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("opd_queue", loadPatients);
      MEDISYS_RT.on("ipd_admissions", loadPatients);
      MEDISYS_RT.on("lab_orders", loadPatients);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadPatients();
      if (currentPatientUhid) {
        const nameEl = document.getElementById("chartPatientTitle");
        const name = nameEl ? nameEl.textContent : "";
        loadChart(currentPatientUhid, name);
      }
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
