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

  let selectedVisit = null;

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

  function getStatusDisplay(s) {
    const key = `opd.status_${s}`;
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    const fallbacks = {
      waiting: "Waiting",
      in_consultation: "In Consultation",
      "in-consultation": "In Consultation",
      completed: "Completed",
      cancelled: "Cancelled",
    };
    return fallbacks[s] || s;
  }

  async function loadQueue() {
    const res = await fetch("/api/opd/queue", { credentials: "same-origin" });
    const data = await res.json();
    const list = document.getElementById("queueList");
    const emptyState = document.getElementById("queueEmptyState");

    const visits = data.success ? data.queue : [];

    if (visits.length === 0) {
      list.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const docLabel = window.i18n ? window.i18n.t("common.doctor") : "Doctor";

    list.innerHTML = visits
      .map(
        (v) => `
        <div class="staff-entry-card portal-row" data-visit-id="${v.id}" data-patient-uhid="${escapeHtml(
          v.patient_uhid
        )}" data-patient-name="${escapeHtml(v.patient_name || v.patient_uhid)}" style="margin-bottom: 10px;" tabindex="0">
          <div class="staff-entry-name">#${v.token_number} — ${escapeHtml(v.patient_name || v.patient_uhid)}
            <span class="queue-status ${escapeHtml(v.status)}">${escapeHtml(getStatusDisplay(v.status))}</span>
          </div>
          <div class="staff-entry-detail">${escapeHtml(docLabel)}: ${escapeHtml(v.doctor_name || v.doctor_user_id)}</div>
        </div>`
      )
      .join("");

    list.querySelectorAll(".portal-row").forEach((card) => {
      card.addEventListener("click", () => {
        selectedVisit = {
          id: card.dataset.visitId,
          patientUhid: card.dataset.patientUhid,
          patientName: card.dataset.patientName,
        };
        const titleLabel = window.i18n ? window.i18n.t("vitals.log_vitals_title") : "Log Vitals";
        document.getElementById("vitalsFormTitle").textContent = `${titleLabel} — ${selectedVisit.patientName}`;
        document.getElementById("vitalsFormSection").hidden = false;
        document.getElementById("vitalsFormError").textContent = "";
      });
    });
  }

  function wireForm() {
    document.getElementById("saveVitalsBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("vitalsFormError");
      errorEl.textContent = "";

      if (!selectedVisit) {
        errorEl.textContent = window.i18n ? window.i18n.t("vitals.select_patient_first") : "Please select a patient from the queue first.";
        return;
      }

      const res = await fetch("/api/vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          patientUhid: selectedVisit.patientUhid,
          opdVisitId: selectedVisit.id,
          bp: document.getElementById("bp").value.trim(),
          temperature: document.getElementById("temperature").value.trim(),
          weight: document.getElementById("weight").value.trim(),
          spo2: document.getElementById("spo2").value.trim(),
        }),
      });
      const data = await res.json();

      if (!data.success) {
        errorEl.textContent = data.message || (window.i18n ? window.i18n.t("vitals.save_error") : "Could not save vitals.");
        return;
      }

      errorEl.style.color = "#0a7d3a";
      errorEl.textContent = window.i18n ? window.i18n.t("vitals.save_success") : "Vitals saved.";
      ["bp", "temperature", "weight", "spo2"].forEach((id) => (document.getElementById(id).value = ""));
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireForm();
    loadQueue();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("opd_queue", loadQueue);
      MEDISYS_RT.on("ipd_admissions", loadQueue);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadQueue();
    });
  });
})();
