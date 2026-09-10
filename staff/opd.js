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

  let selectedPatient = null;
  let selectedSlot = null;

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

  function wireSearch() {
    const input = document.getElementById("patientSearch");
    const results = document.getElementById("searchResults");
    let debounceTimer;

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (!q) {
        results.innerHTML = "";
        return;
      }
      debounceTimer = setTimeout(async () => {
        const res = await fetch(`/api/patients/search?q=${encodeURIComponent(q)}`, {
          credentials: "same-origin",
        });
        const data = await res.json();
        if (!data.success) return;

        results.innerHTML = data.patients
          .map(
            (p) => `
            <div class="staff-entry-card portal-row" data-uhid="${escapeHtml(p.uhid)}" data-name="${escapeHtml(p.full_name)}" tabindex="0">
              <div class="staff-entry-name">${escapeHtml(p.full_name)}</div>
              <div class="staff-entry-detail">${escapeHtml(p.phone || "—")}</div>
              <span class="staff-entry-userid">${escapeHtml(p.uhid)}</span>
            </div>`
          )
          .join("");

        if (data.patients.length === 0) {
          const noMatchMsg = window.i18n ? window.i18n.t("opd.no_matching_patients") : "No matching patients found.";
          results.innerHTML = `<p class="portal-subtitle">${escapeHtml(noMatchMsg)}</p>`;
        }

        results.querySelectorAll(".portal-row").forEach((card) => {
          card.addEventListener("click", () => {
            selectedPatient = { uhid: card.dataset.uhid, fullName: card.dataset.name };
            const hintText = window.i18n
              ? window.i18n.t("opd.selected_patient_hint", { name: selectedPatient.fullName, uhid: selectedPatient.uhid })
              : `Selected: ${selectedPatient.fullName} (${selectedPatient.uhid})`;
            document.getElementById("selectedPatientHint").textContent = hintText;
            document.getElementById("bookingSection").hidden = false;
            loadSlots();
          });
        });
      }, 300);
    });
  }

  async function loadDepartments() {
    const res = await fetch("/api/departments", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    const select = document.getElementById("departmentSelect");
    const allDeptLabel = window.i18n ? window.i18n.t("opd.all_departments") : "All Departments";
    select.innerHTML =
      `<option value="">${escapeHtml(allDeptLabel)}</option>` +
      data.departments.map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join("");
  }

  async function loadDoctors() {
    const departmentId = document.getElementById("departmentSelect").value;
    const url = departmentId
      ? `/api/opd/doctors?departmentId=${encodeURIComponent(departmentId)}`
      : "/api/opd/doctors";
    const res = await fetch(url, { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    const select = document.getElementById("doctorSelect");
    const noDocLabel = window.i18n ? window.i18n.t("opd.no_doctors") : "No doctors in this department";
    select.innerHTML = data.doctors.length
      ? data.doctors
          .map((d) => `<option value="${escapeHtml(d.user_id)}">${escapeHtml(d.full_name)}</option>`)
          .join("")
      : `<option value="">${escapeHtml(noDocLabel)}</option>`;
    loadSlots();
  }

  async function loadSlots() {
    const doctorUserId = document.getElementById("doctorSelect").value;
    const visitDate = document.getElementById("visitDate").value;
    const slotGrid = document.getElementById("slotGrid");
    const bookBtn = document.getElementById("bookSlotBtn");
    selectedSlot = null;
    bookBtn.disabled = true;

    if (!doctorUserId || !visitDate) {
      slotGrid.innerHTML = "";
      return;
    }

    const res = await fetch(
      `/api/opd/slots?doctorUserId=${encodeURIComponent(doctorUserId)}&date=${encodeURIComponent(visitDate)}`,
      { credentials: "same-origin" }
    );
    const data = await res.json();
    if (!data.success) return;

    const noScheduleMsg = window.i18n ? window.i18n.t("opd.no_schedule") : "No schedule set for this doctor on this day.";
    slotGrid.innerHTML = data.slots.length
      ? data.slots
          .map((s) => `<button type="button" class="slot-btn" data-slot="${escapeHtml(s)}">${escapeHtml(s)}</button>`)
          .join("")
      : `<p class="portal-subtitle">${escapeHtml(noScheduleMsg)}</p>`;

    slotGrid.querySelectorAll(".slot-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        slotGrid.querySelectorAll(".slot-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedSlot = btn.dataset.slot;
        bookBtn.disabled = false;
      });
    });
  }

  async function bookVisit(slotTime, confirmDuplicate) {
    const errorEl = document.getElementById("opdFormError");
    errorEl.textContent = "";

    if (!selectedPatient) {
      errorEl.textContent = t('opd.select_patient_first', 'Please search for and select a patient first.');
      return;
    }

    const doctorUserId = document.getElementById("doctorSelect").value;
    const visitDate = document.getElementById("visitDate").value;
    if (!doctorUserId || !visitDate) {
      errorEl.textContent = t('opd.pick_doctor_date', 'Please pick a doctor and date.');
      return;
    }

    const bookBtn = document.getElementById("bookSlotBtn");
    const walkInBtn = document.getElementById("walkInBtn");
    bookBtn.disabled = true;
    walkInBtn.disabled = true;
    try {
      const res = await fetch("/api/opd/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          patientUhid: selectedPatient.uhid,
          doctorUserId,
          visitDate,
          slotTime: slotTime || undefined,
          confirmDuplicate: confirmDuplicate || undefined,
        }),
      });
      const data = await res.json();

      if (!data.success) {
        if (data.duplicateWarning) {
          const list = data.existingVisits
            .map((v) => `  • ${v.doctorName} — ${v.visitDate}${v.slotTime ? " " + t('opd.at_time', 'at') + " " + v.slotTime : " (" + t('appointments.walk_in', 'walk-in') + ")"}`)
            .join("\n");
          const proceed = confirm(
            t('opd.duplicate_booking_confirm', '{name} already has {count} unresolved booking(s):\n\n{list}\n\nBook another one anyway?', { name: selectedPatient.fullName, count: data.existingVisits.length, list })
          );
          if (proceed) {
            bookBtn.disabled = false;
            walkInBtn.disabled = false;
            return bookVisit(slotTime, true);
          }
          errorEl.textContent = window.i18n ? window.i18n.t("opd.booking_cancelled") : "Booking cancelled — patient already has a pending visit.";
          return;
        }
        errorEl.textContent = data.message || (window.i18n ? window.i18n.t("opd.booking_error") : "Could not book visit. Please try again.");
        return;
      }

      document.getElementById("bookingConfirmation").textContent = t('opd.token_issued', 'Token #{token} issued. {confirmation}', { token: data.visit.tokenNumber, confirmation: data.confirmation });
      if (window.showToast) showToast(t('opd.token_booked_toast', 'Token #{token} booked for {name}.', { token: data.visit.tokenNumber, name: selectedPatient.fullName }), "success");
      loadSlots();
      loadQueue();
    } catch (err) {
      errorEl.textContent = window.i18n ? window.i18n.t("opd.network_error") : "Unable to reach the server. Please try again.";
    } finally {
      bookBtn.disabled = false;
      walkInBtn.disabled = false;
    }
  }

  async function loadQueue() {
    const res = await fetch("/api/opd/queue", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("queueTableBody");
    const emptyState = document.getElementById("queueEmptyState");

    if (!data.success || data.queue.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const walkInLabel = window.i18n ? window.i18n.t("registration.walk_in") : "Walk-in";
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

  async function loadNeedsAdmission() {
    const res = await fetch("/api/ipd/admissions?status=requested", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("needsAdmissionTableBody");
    const emptyState = document.getElementById("needsAdmissionEmptyState");

    if (!data.success || data.admissions.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const awaitingBedLabel = window.i18n ? window.i18n.t("opd.awaiting_bed") : "awaiting bed";
    tbody.innerHTML = data.admissions
      .map(
        (a) => `<tr>
          <td>${escapeHtml(a.patient_name || a.patient_uhid)}</td>
          <td>${escapeHtml(a.doctor_name || a.admitting_doctor_user_id || "—")}</td>
          <td>${escapeHtml(new Date(a.created_at).toLocaleString())}</td>
          <td><span class="queue-status waiting">${escapeHtml(awaitingBedLabel)}</span></td>
        </tr>`
      )
      .join("");
  }

  async function loadWardPatients() {
    const res = await fetch("/api/ipd/admissions?status=admitted", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("wardPatientsTableBody");
    const emptyState = document.getElementById("wardPatientsEmptyState");

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
          <td>${escapeHtml(a.doctor_name || a.admitting_doctor_user_id || "—")}</td>
          <td>${escapeHtml(a.ward_name || "—")}</td>
          <td>${escapeHtml(a.bed_number || "—")}</td>
          <td>${escapeHtml(a.admitted_at ? new Date(a.admitted_at).toLocaleString() : "—")}</td>
        </tr>`
      )
      .join("");
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireSearch();

    // Deep-link from staff/patient-checkin.js's "Add to Today's OPD Queue"
    // quick link — pre-selects the patient exactly as if staff had searched
    // and clicked their result, so Check-In → OPD doesn't force a re-search
    // for someone already just identified.
    const urlParams = new URLSearchParams(window.location.search);
    const deepLinkUhid = urlParams.get("uhid");
    const deepLinkName = urlParams.get("name");
    if (deepLinkUhid) {
      selectedPatient = { uhid: deepLinkUhid, fullName: deepLinkName || deepLinkUhid };
      const hintText = window.i18n
        ? window.i18n.t("opd.selected_patient_hint", { name: selectedPatient.fullName, uhid: selectedPatient.uhid })
        : `Selected: ${selectedPatient.fullName} (${selectedPatient.uhid})`;
      document.getElementById("selectedPatientHint").textContent = hintText;
      document.getElementById("bookingSection").hidden = false;
    }

    loadQueue();
    loadNeedsAdmission();
    loadWardPatients();

    const todayStr = new Date().toISOString().slice(0, 10);
    document.getElementById("visitDate").value = todayStr;
    document.getElementById("visitDate").min = todayStr;
    document.getElementById("departmentSelect").addEventListener("change", loadDoctors);
    document.getElementById("doctorSelect").addEventListener("change", loadSlots);
    document.getElementById("visitDate").addEventListener("change", loadSlots);
    document.getElementById("bookSlotBtn").addEventListener("click", () => bookVisit(selectedSlot));
    document.getElementById("walkInBtn").addEventListener("click", () => bookVisit(null));

    await loadDepartments();
    await loadDoctors();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("opd_queue", loadQueue);
      MEDISYS_RT.on("consultations", loadQueue);
      MEDISYS_RT.on("ipd_admissions", () => {
        loadNeedsAdmission();
        loadWardPatients();
      });
      MEDISYS_RT.on("wards_beds", loadWardPatients);
      MEDISYS_RT.on("departments", loadDepartments);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadDepartments();
      loadDoctors();
      loadQueue();
      loadNeedsAdmission();
      loadWardPatients();
    });
  });
})();
