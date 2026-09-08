(function () {
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

  const STATUS_LABELS = {
    pending_activation: "Pending Activation",
    active: "Active",
  };

  function getStatusLabel(s) {
    const key = s === "pending_activation" ? "admin.status_pending" : s === "active" ? "admin.status_active" : null;
    if (key && window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    return STATUS_LABELS[s] || s;
  }

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();

    if (!data.user || data.user.role !== "superadmin") {
      window.location.href = "../index";
      return null;
    }

    const portalUserEl = document.getElementById("portalUser");
    if (portalUserEl) {
      portalUserEl.textContent = data.user.fullName || data.user.userId;
    }
    return data.user;
  }

  function wireLogout() {
    const logoutBtn = document.getElementById("logoutBtn");
    if (!logoutBtn) return;
    logoutBtn.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
  }

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

  const TRASH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4v2H4V5h4V4a1 1 0 0 1 1-1zm-2 6h2v9H7V9zm4 0h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7z"/></svg>`;

  async function deleteHospital(id, name) {
    const msg = window.i18n && typeof window.i18n.t === "function"
      ? window.i18n.t("admin.delete_hospital_confirm", { name })
      : `Permanently delete "${name}" and its entire database? This cannot be undone.`;
    const confirmed = window.confirm(msg);
    if (!confirmed) return false;

    const res = await fetch(`/api/hospitals/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    const data = await res.json();

    if (!data.success) {
      alert(data.message || t('admin.could_not_delete_hospital', 'Could not delete hospital. Please try again.'));
      return false;
    }
    return true;
  }

  async function initDashboard() {
    const table = document.getElementById("hospitalTable");
    const tbody = document.getElementById("hospitalTableBody");
    const emptyState = document.getElementById("emptyState");
    if (!table) return;

    if (window.MEDISYS_RT && !table.dataset.rtWired) {
      table.dataset.rtWired = "true";
      MEDISYS_RT.on("hospitals", initDashboard);
    }

    const res = await fetch("/api/hospitals", { credentials: "same-origin" });
    const data = await res.json();

    if (!data.success || data.hospitals.length === 0) {
      emptyState.hidden = false;
      table.hidden = true;
      return;
    }

    tbody.innerHTML = data.hospitals
      .map((h) => {
        const registered = new Date(h.created_at).toLocaleDateString();
        const statusLabel = getStatusLabel(h.status);
        return `<tr class="portal-row" data-id="${h.id}" tabindex="0">
          <td>${escapeHtml(h.name)}</td>
          <td>${escapeHtml([h.city, h.state].filter(Boolean).join(", ") || "—")}</td>
          <td>${escapeHtml(h.bed_count ?? "—")}</td>
          <td>${escapeHtml(h.admin_name || h.admin_email)}<br/><small>${escapeHtml(h.admin_user_id || "—")}</small></td>
          <td><span class="status-badge ${escapeHtml(h.status)}">${escapeHtml(statusLabel)}</span></td>
          <td>${escapeHtml(registered)}</td>
          <td>
            <button type="button" class="icon-btn-delete" data-id="${h.id}" data-name="${escapeHtml(h.name)}" aria-label="Delete ${escapeHtml(h.name)}" title="Delete hospital">
              ${TRASH_ICON}
            </button>
          </td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".portal-row").forEach((row) => {
      const goToDetail = () => {
        window.location.href = `hospital.html?id=${row.dataset.id}`;
      };
      row.addEventListener("click", goToDetail);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") goToDetail();
      });
    });

    tbody.querySelectorAll(".icon-btn-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const deleted = await deleteHospital(btn.dataset.id, btn.dataset.name);
        if (deleted) initDashboard();
      });
    });

    table.hidden = false;
    emptyState.hidden = true;
  }

  async function initHospitalDetail() {
    const container = document.getElementById("hospitalDetail");
    if (!container) return;

    const id = new URLSearchParams(window.location.search).get("id");
    const res = await fetch(`/api/hospitals/${id}`, { credentials: "same-origin" });
    const data = await res.json();

    const noneSelectedLabel = window.i18n ? window.i18n.t("admin.none_selected") : "None selected";
    const notFoundLabel = window.i18n ? window.i18n.t("admin.hospital_not_found") : "Hospital not found.";

    if (!data.success) {
      container.innerHTML = `<p class="form-error">${escapeHtml(data.message || notFoundLabel)}</p>`;
      return;
    }

    const h = data.hospital;
    const modules = (() => {
      try {
        const parsed = typeof h.modules === "string" ? JSON.parse(h.modules) : h.modules;
        return (parsed || []).map((m) => getModuleLabel(m)).join(", ") || noneSelectedLabel;
      } catch {
        return noneSelectedLabel;
      }
    })();
    const statusLabel = getStatusLabel(h.status);
    const registered = new Date(h.created_at).toLocaleString();

    document.getElementById("hospitalName").textContent = h.name;

    container.innerHTML = `
      <div class="wizard-review">
        <h3>Status</h3>
        <dl>
          <dt>Current Status</dt>
          <dd><span class="status-badge ${escapeHtml(h.status)}">${escapeHtml(statusLabel)}</span></dd>
          <dt>Registered</dt><dd>${escapeHtml(registered)}</dd>
          <dt>Admin User ID</dt><dd>${escapeHtml(h.admin_user_id || "—")}</dd>
        </dl>

        <h3>Legal &amp; facility details</h3>
        <dl>
          <dt>Facility Name</dt><dd>${escapeHtml(h.name)}</dd>
          <dt>License Number</dt><dd>${escapeHtml(h.license_number || "—")}</dd>
          <dt>PAN</dt><dd>${escapeHtml(h.pan || "—")}</dd>
          <dt>HFR ID</dt><dd>${escapeHtml(h.hfr_id || "—")}</dd>
        </dl>

        <h3>Address &amp; operations</h3>
        <dl>
          <dt>Address</dt><dd>${escapeHtml([h.address, h.city, h.state, h.pincode].filter(Boolean).join(", ") || "—")}</dd>
          <dt>Beds</dt><dd>${escapeHtml(h.bed_count ?? "—")}</dd>
          <dt>Avg. OPD Volume / day</dt><dd>${escapeHtml(h.opd_volume ?? "—")}</dd>
        </dl>

        <h3>Client admin contact</h3>
        <dl>
          <dt>Admin Name</dt><dd>${escapeHtml(h.admin_name || "—")}</dd>
          <dt>Admin Email</dt><dd>${escapeHtml(h.admin_email)}</dd>
        </dl>

        <h3>Modules enabled</h3>
        <dl><dt>Modules</dt><dd>${escapeHtml(modules)}</dd></dl>

        <h3>Compliance</h3>
        <dl><dt>DPDP Consent</dt><dd>${h.dpdp_consent ? "Confirmed" : "Not confirmed"}</dd></dl>
      </div>
      <div class="portal-danger-zone">
        <button type="button" class="portal-danger-btn" id="deleteHospitalBtn">${TRASH_ICON} Delete Hospital</button>
      </div>
    `;

    document.getElementById("deleteHospitalBtn").addEventListener("click", async () => {
      const deleted = await deleteHospital(h.id, h.name);
      if (deleted) window.location.href = "dashboard";
    });
  }

  function initWizard() {
    const form = document.getElementById("wizardForm");
    if (!form) return;

    const steps = Array.from(form.querySelectorAll(".wizard-step[data-step]")).filter(
      (el) => el.dataset.step !== "result"
    );
    const resultPanel = form.querySelector('.wizard-step[data-step="result"]');
    const stepperItems = Array.from(document.querySelectorAll(".stepper-item"));
    const backBtn = document.getElementById("wizardBack");
    const nextBtn = document.getElementById("wizardNext");
    const activateBtn = document.getElementById("wizardActivate");
    const errorEl = document.getElementById("wizardError");
    const totalSteps = steps.length;
    let current = 1;

    form.querySelectorAll(".module-card").forEach((card) => {
      const input = card.querySelector('input[type="checkbox"]');
      card.classList.toggle("selected", input.checked);
      input.addEventListener("change", () => {
        card.classList.toggle("selected", input.checked);
      });
    });

    function suggestShortCode() {
      const words = form.name.value
        .toUpperCase()
        .replace(/[^A-Z\s]/g, "")
        .split(/\s+/)
        .filter(Boolean);
      let code = words.map((w) => w[0]).join("").slice(0, 5);
      if (code.length < 3) code = (words[0] || "HOSP").slice(0, 3);
      return code || "HOSP";
    }

    document.getElementById("suggestUserIdBtn").addEventListener("click", () => {
      const digits = Math.floor(1000 + Math.random() * 90000);
      document.getElementById("adminUserIdCustom").value = `AD-${suggestShortCode()}-${digits}`;
    });

    document.getElementById("suggestPasswordBtn").addEventListener("click", () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
      let pw = "";
      for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
      document.getElementById("adminPasswordCustom").value = pw;
    });

    function showStep(stepNum) {
      steps.forEach((el) => {
        el.hidden = Number(el.dataset.step) !== stepNum;
      });
      stepperItems.forEach((el) => {
        const n = Number(el.dataset.step);
        el.classList.toggle("active", n === stepNum);
        el.classList.toggle("done", n < stepNum);
      });
      backBtn.hidden = stepNum === 1;
      nextBtn.hidden = stepNum === totalSteps;
      activateBtn.hidden = stepNum !== totalSteps;
      errorEl.textContent = "";

      if (stepNum === totalSteps) {
        renderReview();
      }
    }

    function validateStep(stepNum) {
      const stepEl = steps.find((el) => Number(el.dataset.step) === stepNum);
      const required = stepEl.querySelectorAll("[required]");
      for (const field of required) {
        if (field.type === "checkbox" ? !field.checked : !field.value.trim()) {
          errorEl.textContent = t('admin.fill_required_fields', 'Please fill in all required fields before continuing.');
          field.focus();
          return false;
        }
      }
      return true;
    }

    function collectData() {
      const modules = Array.from(form.querySelectorAll('input[name="modules"]:checked')).map(
        (el) => el.value
      );
      return {
        name: form.name.value.trim(),
        licenseNumber: form.licenseNumber.value.trim(),
        pan: form.pan.value.trim(),
        hfrId: form.hfrId.value.trim(),
        address: form.address.value.trim(),
        city: form.city.value.trim(),
        state: form.state.value.trim(),
        pincode: form.pincode.value.trim(),
        bedCount: form.bedCount.value ? Number(form.bedCount.value) : null,
        opdVolume: form.opdVolume.value ? Number(form.opdVolume.value) : null,
        adminName: form.adminName.value.trim(),
        adminEmail: form.adminEmail.value.trim(),
        adminUserId: form.adminUserIdCustom.value.trim(),
        adminPassword: form.adminPasswordCustom.value.trim(),
        modules,
        dpdpConsent: form.dpdpConsent.checked,
      };
    }

    function renderReview() {
      const d = collectData();
      const moduleLabels = d.modules.map((m) => getModuleLabel(m)).join(", ") || "None selected";
      const review = document.getElementById("wizardReview");
      review.innerHTML = `
        <h3>Legal &amp; facility details</h3>
        <dl>
          <dt>Facility Name</dt><dd>${escapeHtml(d.name)}</dd>
          <dt>License Number</dt><dd>${escapeHtml(d.licenseNumber || "—")}</dd>
          <dt>PAN</dt><dd>${escapeHtml(d.pan || "—")}</dd>
          <dt>HFR ID</dt><dd>${escapeHtml(d.hfrId || "—")}</dd>
        </dl>
        <h3>Address &amp; operations</h3>
        <dl>
          <dt>Address</dt><dd>${escapeHtml([d.address, d.city, d.state, d.pincode].filter(Boolean).join(", ") || "—")}</dd>
          <dt>Beds</dt><dd>${escapeHtml(d.bedCount ?? "—")}</dd>
          <dt>Avg. OPD Volume / day</dt><dd>${escapeHtml(d.opdVolume ?? "—")}</dd>
        </dl>
        <h3>Client admin contact</h3>
        <dl>
          <dt>Admin Name</dt><dd>${escapeHtml(d.adminName || "—")}</dd>
          <dt>Admin Email</dt><dd>${escapeHtml(d.adminEmail)}</dd>
          <dt>Admin User ID</dt><dd>${escapeHtml(d.adminUserId || "Auto-generated at activation")}</dd>
          <dt>Admin Password</dt><dd>${d.adminPassword ? "Custom (set by you)" : "Auto-generated at activation"}</dd>
        </dl>
        <h3>Modules enabled</h3>
        <dl><dt>Modules</dt><dd>${escapeHtml(moduleLabels)}</dd></dl>
        <h3>Compliance</h3>
        <dl><dt>DPDP Consent</dt><dd>${d.dpdpConsent ? "Confirmed" : "Not confirmed"}</dd></dl>
      `;
    }

    nextBtn.addEventListener("click", () => {
      if (!validateStep(current)) return;
      current = Math.min(current + 1, totalSteps);
      showStep(current);
    });

    backBtn.addEventListener("click", () => {
      current = Math.max(current - 1, 1);
      showStep(current);
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!validateStep(totalSteps)) return;

      activateBtn.disabled = true;
      try {
        const res = await fetch("/api/hospitals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(collectData()),
        });
        const data = await res.json();

        if (!data.success) {
          errorEl.textContent = data.message || t('admin.could_not_register_hospital', 'Could not register hospital. Please try again.');
          return;
        }

        steps.forEach((el) => (el.hidden = true));
        document.getElementById("stepper").hidden = true;
        backBtn.hidden = true;
        nextBtn.hidden = true;
        activateBtn.hidden = true;

        document.getElementById("adminUserIdOutput").value = data.admin.userId;
        document.getElementById("adminPasswordOutput").value = data.admin.password;
        resultPanel.hidden = false;
      } catch (err) {
        errorEl.textContent = t('common.unable_to_reach_server', 'Unable to reach the server. Please try again.');
      } finally {
        activateBtn.disabled = false;
      }
    });

    function wireCopyButton(buttonId, inputId) {
      document.getElementById(buttonId).addEventListener("click", () => {
        const input = document.getElementById(inputId);
        input.select();
        navigator.clipboard.writeText(input.value).catch(() => {});
      });
    }
    wireCopyButton("copyUserIdBtn", "adminUserIdOutput");
    wireCopyButton("copyPasswordBtn", "adminPasswordOutput");

    showStep(current);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    initDashboard();
    initWizard();
    initHospitalDetail();

    window.addEventListener("i18n:languageChanged", () => {
      initDashboard();
      initHospitalDetail();
    });
  });
})();
