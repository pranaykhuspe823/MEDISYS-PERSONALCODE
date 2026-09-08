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

  let currentAdmissionId = null;

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

  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }

  async function loadAdmissions() {
    const res = await fetch("/api/ipd/admissions?status=admitted", { credentials: "same-origin" });
    const data = await res.json();
    const select = document.getElementById("admissionSelect");
    if (!data.success || data.admissions.length === 0) {
      select.innerHTML = `<option value="">${t('doctor_ipd.no_admitted_patients', 'No admitted patients')}</option>`;
      return;
    }
    select.innerHTML =
      `<option value="">${t('doctor_ipd.select_patient', 'Select a patient')}</option>` +
      data.admissions
        .map((a) => `<option value="${a.id}">${escapeHtml(a.patient_name || a.patient_uhid)} (${escapeHtml(a.ward_name || "")} ${escapeHtml(a.bed_number || "")})</option>`)
        .join("");
  }

  async function loadChart(admissionId) {
    const res = await fetch(`/api/ipd/admissions/${admissionId}`, { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;

    currentAdmissionId = admissionId;
    document.getElementById("workspace").hidden = false;

    document.getElementById("vitalsFeed").innerHTML =
      data.vitals
        .map(
          (v) => `<div class="chart-feed-item">
            BP ${escapeHtml(v.bp || "—")}, Temp ${escapeHtml(v.temperature || "—")}, Weight ${escapeHtml(v.weight || "—")}, SpO2 ${escapeHtml(v.spo2 || "—")}
            <div class="chart-feed-meta">${escapeHtml(new Date(v.recorded_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">${t('doctor_ipd.no_vitals_logged', 'No vitals logged yet.')}</p>`;

    document.getElementById("notesFeed").innerHTML =
      data.notes
        .map(
          (n) => `<div class="chart-feed-item">
            <span class="note-type-badge ${escapeHtml(n.note_type)}">${escapeHtml(n.note_type.replace("_", " "))}</span>${escapeHtml(n.message)}
            <div class="chart-feed-meta">by ${escapeHtml(n.flagged_by)} &middot; ${escapeHtml(new Date(n.created_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">${t('doctor_ipd.no_notes', 'No notes yet.')}</p>`;

    document.getElementById("ordersFeed").innerHTML =
      data.orders
        .map(
          (o) => `<div class="chart-feed-item">
            <strong>${escapeHtml(o.order_type)}</strong>: ${escapeHtml(o.description)}
            <div class="chart-feed-meta">${escapeHtml(new Date(o.created_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">${t('doctor_ipd.no_orders_issued', 'No orders issued yet.')}</p>`;
  }

  function wireVoiceDictation() {
    if (!window.MedisysVoice) return;
    MedisysVoice.mount(document.getElementById("voiceDictate"), {
      onResult: (data) => {
        const noteEl = document.getElementById("roundNote");
        noteEl.value = noteEl.value ? `${noteEl.value}\n${data.notes || ""}` : data.notes || "";

        if ((data.medicines || []).length) {
          const lines = data.medicines.map(
            (m) => `${m.name}${m.dosage ? " — " + m.dosage : ""}${m.duration ? ` for ${m.duration}d` : ""}${m.foodInstruction ? ", " + m.foodInstruction : ""}`
          );
          document.getElementById("orderType").value = "medicine";
          const orderEl = document.getElementById("orderDescription");
          orderEl.value = orderEl.value ? `${orderEl.value}\n${lines.join("\n")}` : lines.join("\n");
        }
      },
      onError: (message) => {
        document.getElementById("ipdError").textContent = message;
      },
    });
  }

  function wireActions() {
    document.getElementById("admissionSelect").addEventListener("change", (e) => {
      if (e.target.value) loadChart(e.target.value);
      else document.getElementById("workspace").hidden = true;
    });

    document.getElementById("postRoundNoteBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("ipdError");
      errorEl.textContent = "";
      const message = document.getElementById("roundNote").value.trim();
      if (!message || !currentAdmissionId) {
        errorEl.textContent = t('doctor_ipd.note_required', 'Note message is required.');
        return;
      }
      const res = await fetch(`/api/ipd/admissions/${currentAdmissionId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ noteType: "doctor_round", message }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('doctor_ipd.could_not_post_note', 'Could not post note.');
        return;
      }
      document.getElementById("roundNote").value = "";
      loadChart(currentAdmissionId);
    });

    document.getElementById("issueOrderBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("ipdError");
      errorEl.textContent = "";
      const description = document.getElementById("orderDescription").value.trim();
      if (!description || !currentAdmissionId) {
        errorEl.textContent = t('doctor_ipd.order_required', 'Order description is required.');
        return;
      }
      const res = await fetch(`/api/ipd/admissions/${currentAdmissionId}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          orderType: document.getElementById("orderType").value,
          description,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t('doctor_ipd.could_not_issue_order', 'Could not issue order.');
        return;
      }
      document.getElementById("orderDescription").value = "";
      loadChart(currentAdmissionId);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireActions();
    wireVoiceDictation();
    loadAdmissions();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("ipd_admissions", loadAdmissions);
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadAdmissions();
      if (currentAdmissionId) loadChart(currentAdmissionId);
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
