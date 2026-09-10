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

  const METHOD_BADGE_CLASS = {
    manual: "method-badge-manual",
    mobile_otp: "method-badge-mobile_otp",
    aadhaar_otp: "method-badge-aadhaar_otp",
    fingerprint: "method-badge-fingerprint",
    all_three: "method-badge-all_three",
  };

  const METHOD_LABEL_KEYS = {
    manual: ["opd_registrations.method_manual", "Manual"],
    mobile_otp: ["opd_registrations.method_mobile_otp", "Mobile OTP"],
    aadhaar_otp: ["opd_registrations.method_aadhaar_otp", "Aadhaar OTP"],
    fingerprint: ["opd_registrations.method_fingerprint", "Fingerprint"],
    all_three: ["opd_registrations.method_all_three", "All 3 Methods"],
  };

  function methodLabel(method) {
    const [key, fallback] = METHOD_LABEL_KEYS[method] || [null, method];
    return key ? t(key, fallback) : fallback;
  }

  function methodBadge(method) {
    const cls = METHOD_BADGE_CLASS[method] || "method-badge-manual";
    return `<span class="method-badge ${cls}">${escapeHtml(methodLabel(method))}</span>`;
  }

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

  let currentMethod = "all";

  function renderSummary(summary) {
    const summaryLine = document.getElementById("summaryLine");
    if (!summary || summary.total === 0) {
      summaryLine.textContent = t("opd_registrations.no_registrations", "No registrations for this filter today.");
      return;
    }
    const breakdown = ["all_three", "fingerprint", "mobile_otp", "aadhaar_otp", "manual"]
      .filter((m) => summary[m] > 0)
      .map((m) => `${summary[m]} ${methodLabel(m)}`)
      .join(", ");
    summaryLine.textContent = t("opd_registrations.summary_line", "{total} today — {breakdown}", {
      total: summary.total,
      breakdown,
    });
  }

  function renderTable(registrations) {
    const tbody = document.getElementById("registrationsTableBody");
    const emptyState = document.getElementById("registrationsEmptyState");

    if (registrations.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = registrations
      .map((r) => {
        const time = r.created_at
          ? new Date(r.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—";
        return `
          <tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${escapeHtml(r.uhid || "—")}</td>
            <td>${escapeHtml(r.abha_id || "—")}</td>
            <td>${methodBadge(r.abha_verification_method || "manual")}</td>
            <td>${escapeHtml(time)}</td>
          </tr>`;
      })
      .join("");
  }

  async function loadRegistrations() {
    const summaryLine = document.getElementById("summaryLine");
    summaryLine.textContent = t("common.loading", "Loading…");
    try {
      const url = currentMethod === "all" ? "/api/opd/registrations" : `/api/opd/registrations?method=${encodeURIComponent(currentMethod)}`;
      const res = await fetch(url, { credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) {
        summaryLine.textContent = data.message || t("common.server_error", "Unable to reach the server. Please try again.");
        return;
      }
      renderSummary(data.summary);
      renderTable(data.registrations);
    } catch (err) {
      summaryLine.textContent = t("common.server_error", "Unable to reach the server. Please try again.");
    }
  }

  function wireFilterChips() {
    const chips = document.querySelectorAll(".registrations-filter-chip");
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        chips.forEach((c) => c.setAttribute("aria-selected", "false"));
        chip.setAttribute("aria-selected", "true");
        currentMethod = chip.dataset.method;
        loadRegistrations();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireFilterChips();
    await loadRegistrations();

    window.addEventListener("i18n:languageChanged", () => {
      if (window.i18n) window.i18n.applyTranslations();
      loadRegistrations();
    });
  });
})();
