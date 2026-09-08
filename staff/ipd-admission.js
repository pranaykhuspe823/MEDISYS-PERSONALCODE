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

  let selectedPatient = null;

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

  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
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
          results.innerHTML = `<p class="portal-subtitle">${t('registration.no_matching_patients', 'No matching patients found.')}</p>`;
        }

        results.querySelectorAll(".portal-row").forEach((card) => {
          card.addEventListener("click", () => {
            selectedPatient = { uhid: card.dataset.uhid, fullName: card.dataset.name };
            document.getElementById("selectedPatientHint").textContent = `${t('ipd.selected', 'Selected')}: ${selectedPatient.fullName} (${selectedPatient.uhid})`;
          });
        });
      }, 300);
    });
  }

  async function loadDoctors() {
    const res = await fetch("/api/opd/doctors", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    const select = document.getElementById("doctorSelect");
    select.innerHTML = data.doctors
      .map((d) => `<option value="${escapeHtml(d.user_id)}">${escapeHtml(d.full_name)}</option>`)
      .join("");
  }

  function wireForm() {
    const form = document.getElementById("admissionForm");
    const errorEl = document.getElementById("admissionFormError");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.textContent = "";

      if (!selectedPatient) {
        errorEl.textContent = t('ipd.select_patient_first', 'Please search for and select a patient first.');
        return;
      }

      try {
        const res = await fetch("/api/ipd/admissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            patientUhid: selectedPatient.uhid,
            admittingDoctorUserId: document.getElementById("doctorSelect").value,
            consentObtained: document.getElementById("consentObtained").checked,
            idProofNote: document.getElementById("idProofNote").value.trim(),
          }),
        });
        const data = await res.json();

        if (!data.success) {
          errorEl.textContent = data.message || t('ipd.could_not_create_admission', 'Could not create admission request.');
          return;
        }

        form.hidden = true;
        document.getElementById("admissionResult").hidden = false;
      } catch (err) {
        errorEl.textContent = t('common.server_error', 'Unable to reach the server. Please try again.');
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireSearch();
    wireForm();
    loadDoctors();

    window.addEventListener("i18n:languageChanged", () => {
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
