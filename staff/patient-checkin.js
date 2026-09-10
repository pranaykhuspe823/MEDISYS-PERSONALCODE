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

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || !data.user.hospitalId || data.user.role === "patient") {
      window.location.href = "../index.html";
      return null;
    }
    document.getElementById("portalUser").textContent = data.user.fullName || data.user.userId;
    return data.user;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index.html";
    });
  }

  // RD Service client lives in the shared ../rd-service-client.js — see
  // window.RdService, included on this page before this script.
  const rdServiceDeviceInfo = window.RdService.deviceInfo;
  const rdServiceCapture = window.RdService.capture;
  const parseCaptureQuality = window.RdService.parseCaptureQuality;
  const buildMockPidXml = window.RdService.buildMockPidXml;

  // ---------- "Found" patient summary + quick links ----------

  function renderFoundSummary(patient) {
    const dl = document.getElementById("foundPatientSummary");
    const lastVisit = patient.last_visit_at
      ? new Date(patient.last_visit_at).toLocaleDateString()
      : t("checkin.no_prior_visits", "No prior visits on record");
    dl.innerHTML = `
      <dt>${t("common.patient", "Patient")}</dt><dd>${escapeHtml(patient.full_name)}</dd>
      <dt>${t("patient.uhid", "UHID")}</dt><dd>${escapeHtml(patient.uhid)}</dd>
      <dt>${t("registration.abha_id", "ABHA ID")}</dt><dd>${escapeHtml(patient.abha_id || "—")}</dd>
      <dt>${t("checkin.last_visit", "Last Visit")}</dt><dd>${escapeHtml(lastVisit)}</dd>
    `;

    document.getElementById("addToQueueLink").href = `opd?uhid=${encodeURIComponent(patient.uhid)}&name=${encodeURIComponent(patient.full_name)}`;
    document.getElementById("goToBillingLink").href = `billing-desk?uhid=${encodeURIComponent(patient.uhid)}`;

    const viewBtn = document.getElementById("viewRecordBtn");
    const recordSection = document.getElementById("foundPatientRecord");
    recordSection.hidden = true;
    viewBtn.onclick = async () => {
      if (!recordSection.hidden) {
        recordSection.hidden = true;
        return;
      }
      await loadFullRecord(patient.uhid);
      recordSection.hidden = false;
    };

    document.getElementById("checkinResultFound").hidden = false;
    document.getElementById("checkinResultNotFound").hidden = true;
  }

  async function loadFullRecord(uhid) {
    const detailsDl = document.getElementById("foundPatientDetails");
    const visitsEl = document.getElementById("foundPatientVisits");
    detailsDl.innerHTML = `<dt>${t("common.loading", "Loading...")}</dt><dd></dd>`;
    visitsEl.innerHTML = "";
    try {
      const [detailRes, historyRes] = await Promise.all([
        fetch(`/api/patients/${encodeURIComponent(uhid)}`, { credentials: "same-origin" }),
        fetch(`/api/patients/${encodeURIComponent(uhid)}/history`, { credentials: "same-origin" }),
      ]);
      const detailData = await detailRes.json();
      const historyData = await historyRes.json();

      if (detailData.success) {
        const p = detailData.patient;
        detailsDl.innerHTML = `
          <dt>${t("registration.dob", "Date of Birth")}</dt><dd>${escapeHtml(p.dob ? new Date(p.dob).toLocaleDateString() : "—")}</dd>
          <dt>${t("patient.gender", "Gender")}</dt><dd>${escapeHtml(p.gender || "—")}</dd>
          <dt>${t("registration.phone", "Phone")}</dt><dd>${escapeHtml(p.phone || "—")}</dd>
          <dt>${t("registration.address", "Address")}</dt><dd>${escapeHtml(p.address || "—")}</dd>
          <dt>${t("registration.category", "Patient Category")}</dt><dd>${escapeHtml(p.category || "—")}</dd>
        `;
      }

      if (historyData.success && historyData.history.consultations.length > 0) {
        visitsEl.innerHTML = historyData.history.consultations
          .slice(0, 5)
          .map(
            (c) => `
            <div class="staff-entry-card">
              <div class="staff-entry-name">${escapeHtml(new Date(c.created_at).toLocaleDateString())} &mdash; ${escapeHtml(c.doctor_name || "—")}</div>
              <div class="staff-entry-detail">${escapeHtml(c.decision || "—")}</div>
            </div>`
          )
          .join("");
      } else {
        visitsEl.innerHTML = `<p class="portal-empty">${t("checkin.no_prior_visits", "No prior visits on record")}</p>`;
      }
    } catch {
      detailsDl.innerHTML = "";
      visitsEl.innerHTML = `<p class="form-error">${t("common.server_error", "Unable to reach the server. Please try again.")}</p>`;
    }
  }

  function showNotFound(profile, method) {
    try {
      sessionStorage.setItem("medisysPendingAbhaProfile", JSON.stringify({ profile, method }));
    } catch {
      // sessionStorage unavailable (private browsing, etc.) — Complete
      // Registration link below still works, staff just re-fetches ABHA
      // on the registration page instead of it being pre-filled.
    }
    document.getElementById("checkinResultFound").hidden = true;
    document.getElementById("checkinResultNotFound").hidden = false;
  }

  async function resolveByAbha(profile, method) {
    try {
      const res = await fetch("/api/patients/resolve-by-abha", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ abhaId: profile.abhaNumber, abhaAddress: profile.abhaAddress, mobile: profile.mobile }),
      });
      const data = await res.json();
      if (!data.success) {
        document.getElementById("abhaError").textContent = data.message || t("checkin.lookup_failed", "Could not look up this patient. Please try again.");
        return;
      }
      if (data.found) {
        renderFoundSummary(data);
      } else {
        showNotFound(profile, method);
      }
    } catch {
      document.getElementById("abhaError").textContent = t("common.server_error", "Unable to reach the server. Please try again.");
    }
  }

  // ---------- ABHA verification (mirrors staff/registration.js's ABHA
  // fetch flow — same routes, same RD Service client — but on success this
  // page resolves a local record instead of filling a registration form) ----------

  function wireAbhaVerify() {
    const typeMobile = document.getElementById("abhaTypeMobile");
    const typeAadhaar = document.getElementById("abhaTypeAadhaar");
    const typeBiometric = document.getElementById("abhaTypeBiometric");
    const identifierRow = document.getElementById("abhaIdentifierRow");
    const identifierInput = document.getElementById("abhaIdentifierInput");
    const fetchBtn = document.getElementById("abhaFetchBtn");
    const otpSection = document.getElementById("abhaOtpSection");
    const otpInput = document.getElementById("abhaOtpInput");
    const verifyBtn = document.getElementById("abhaVerifyBtn");
    const bioSection = document.getElementById("abhaBioSection");
    const bioAadhaarInput = document.getElementById("abhaBioAadhaarInput");
    const bioDeviceStatus = document.getElementById("abhaBioDeviceStatus");
    const bioScanBtn = document.getElementById("abhaBioScanBtn");
    const bioCaptureResult = document.getElementById("abhaBioCaptureResult");
    const bioQualityText = document.getElementById("abhaBioQualityText");
    const errorEl = document.getElementById("abhaError");
    const notFoundEl = document.getElementById("abhaNotFound");

    let currentTxnId = null;
    let bioDeviceChecked = false;
    let bioMockProvider = false;

    function currentIdType() {
      if (typeBiometric.checked) return "biometric";
      return typeAadhaar.checked ? "aadhaar" : "mobile";
    }

    function hideCaptureQuality() {
      bioCaptureResult.hidden = true;
      bioCaptureResult.classList.remove("quality-fair", "quality-poor");
    }

    function showCaptureQuality(pidXml) {
      const qScore = parseCaptureQuality(pidXml);
      bioCaptureResult.hidden = false;
      bioCaptureResult.classList.remove("quality-fair", "quality-poor");
      if (qScore === null) {
        bioQualityText.textContent = t("registration.bio_captured_no_score", "Fingerprint captured.");
      } else if (qScore >= 50) {
        bioQualityText.textContent = t("registration.bio_captured_good", "Fingerprint captured — good quality ({score}/100).", { score: qScore });
      } else if (qScore >= 25) {
        bioCaptureResult.classList.add("quality-fair");
        bioQualityText.textContent = t("registration.bio_captured_fair", "Fingerprint captured — fair quality ({score}/100). Consider re-scanning.", { score: qScore });
      } else {
        bioCaptureResult.classList.add("quality-poor");
        bioQualityText.textContent = t("registration.bio_captured_poor", "Weak capture ({score}/100) — please re-scan.", { score: qScore });
      }
    }

    async function checkRdServiceDevice() {
      bioDeviceStatus.textContent = t("registration.bio_checking_device", "Checking for the Mantra RD Service…");
      bioScanBtn.disabled = true;
      try {
        const statusRes = await fetch("/api/abha/status", { credentials: "same-origin" });
        const statusData = await statusRes.json();
        bioMockProvider = Boolean(statusData.mock);
      } catch {
        bioMockProvider = false;
      }
      try {
        await rdServiceDeviceInfo();
        bioDeviceStatus.textContent = t("registration.bio_device_ready", "Fingerprint scanner detected — ready to scan.");
        bioScanBtn.disabled = false;
      } catch (err) {
        if (bioMockProvider) {
          bioDeviceStatus.textContent = t(
            "registration.bio_mock_fallback",
            'No physical scanner detected — mock ABDM provider active, so "Scan Fingerprint" will simulate a capture for testing.'
          );
          bioScanBtn.disabled = false;
        } else {
          bioDeviceStatus.textContent = t(
            "registration.bio_device_missing",
            "Mantra RD Service not detected on this machine ({error}). Make sure it is running and the MFS110 is plugged in.",
            { error: err.message }
          );
          bioScanBtn.disabled = true;
        }
      }
    }

    function resetFlow() {
      otpSection.hidden = true;
      otpInput.value = "";
      errorEl.textContent = "";
      notFoundEl.hidden = true;
      hideCaptureQuality();
      currentTxnId = null;
      document.getElementById("checkinResultFound").hidden = true;
      document.getElementById("checkinResultNotFound").hidden = true;
    }

    function updatePlaceholder() {
      const type = currentIdType();
      identifierInput.placeholder = type === "aadhaar" ? "Enter 12-digit Aadhaar number" : "Enter 10-digit mobile number";
      identifierInput.value = "";
      bioAadhaarInput.value = "";
      identifierRow.hidden = type === "biometric";
      bioSection.hidden = type !== "biometric";
      resetFlow();
      if (type === "biometric" && !bioDeviceChecked) {
        bioDeviceChecked = true;
        checkRdServiceDevice();
      }
    }
    typeMobile.addEventListener("change", updatePlaceholder);
    typeAadhaar.addEventListener("change", updatePlaceholder);
    typeBiometric.addEventListener("change", updatePlaceholder);

    fetchBtn.addEventListener("click", async () => {
      resetFlow();
      const type = currentIdType();
      const value = identifierInput.value.trim();
      if (!value) {
        errorEl.textContent = `Enter a ${type === "aadhaar" ? "Aadhaar" : "mobile"} number first.`;
        return;
      }
      fetchBtn.disabled = true;
      try {
        const res = await fetch("/api/abha/request-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ type, value }),
        });
        const data = await res.json();
        if (!data.success) {
          if (data.notFound) {
            notFoundEl.hidden = false;
            return;
          }
          errorEl.textContent = data.message || t("registration.could_not_send_otp", "Could not send OTP. Please try again.");
          return;
        }
        currentTxnId = data.txnId;
        otpSection.hidden = false;
        otpInput.focus();
        if (window.showToast) {
          showToast(data.mock ? t("registration.mock_otp_sent", "Mock OTP sent — use 111111.") : t("registration.otp_sent_mobile", "OTP sent to the registered mobile."), "success");
        }
      } catch {
        errorEl.textContent = t("registration.unable_reach_server_manual", "Unable to reach the server. You can continue with manual registration below.");
      } finally {
        fetchBtn.disabled = false;
      }
    });

    verifyBtn.addEventListener("click", async () => {
      const otp = otpInput.value.trim();
      if (!otp) {
        errorEl.textContent = t("registration.enter_otp_first", "Enter the OTP first.");
        return;
      }
      if (!currentTxnId) {
        errorEl.textContent = t("registration.otp_expired", "Please fetch details again — this OTP request has expired.");
        return;
      }
      verifyBtn.disabled = true;
      errorEl.textContent = "";
      try {
        const res = await fetch("/api/abha/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ txnId: currentTxnId, otp }),
        });
        const data = await res.json();
        if (!data.success) {
          if (data.notFound) {
            otpSection.hidden = true;
            notFoundEl.hidden = false;
          } else {
            errorEl.textContent = data.message || t("registration.verification_failed", "Verification failed. Please try again.");
          }
          return;
        }
        otpSection.hidden = true;
        await resolveByAbha(data.profile, currentIdType() === "aadhaar" ? "aadhaar_otp" : "mobile_otp");
      } catch {
        errorEl.textContent = t("registration.unable_reach_server_manual", "Unable to reach the server. You can continue with manual registration below.");
      } finally {
        verifyBtn.disabled = false;
      }
    });

    bioScanBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      const aadhaar = bioAadhaarInput.value.trim();
      if (!/^\d{12}$/.test(aadhaar)) {
        errorEl.textContent = t("registration.enter_valid_aadhaar", "Enter a valid 12-digit Aadhaar number.");
        return;
      }
      bioScanBtn.disabled = true;
      const previousStatus = bioDeviceStatus.textContent;
      bioDeviceStatus.textContent = t("registration.bio_scanning", "Place finger on the scanner…");
      try {
        let pidXml;
        try {
          pidXml = await rdServiceCapture();
          bioDeviceStatus.textContent = t("registration.bio_verifying", "Verifying with ABHA…");
        } catch (captureErr) {
          if (!bioMockProvider) throw captureErr;
          pidXml = buildMockPidXml();
          bioDeviceStatus.textContent = t("registration.bio_mock_capture", "Using a simulated fingerprint capture (mock ABDM provider) — verifying with ABHA…");
        }
        showCaptureQuality(pidXml);
        const res = await fetch("/api/abha/verify-bio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ aadhaar, pidXml }),
        });
        const data = await res.json();
        if (!data.success) {
          if (data.notFound) {
            notFoundEl.hidden = false;
          } else {
            errorEl.textContent = data.message || t("registration.verification_failed", "Verification failed. Please try again.");
          }
          return;
        }
        await resolveByAbha(data.profile, "fingerprint");
      } catch (err) {
        errorEl.textContent = err.message || t("registration.bio_scan_failed", "Fingerprint scan failed. Please try again.");
      } finally {
        bioDeviceStatus.textContent = previousStatus;
        bioScanBtn.disabled = false;
      }
    });

    updatePlaceholder();
  }

  // ---------- Manual search fallback ----------

  function wireManualSearch() {
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
        const res = await fetch(`/api/patients/search?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
        const data = await res.json();
        if (!data.success) return;

        results.innerHTML = data.patients
          .map(
            (p) => `
            <div class="staff-entry-card portal-row" data-uhid="${escapeHtml(p.uhid)}" tabindex="0">
              <div class="staff-entry-name">${escapeHtml(p.full_name)}</div>
              <div class="staff-entry-detail">${escapeHtml(p.phone || "—")}</div>
              <span class="staff-entry-userid">${escapeHtml(p.uhid)}</span>
            </div>`
          )
          .join("");

        if (data.patients.length === 0) {
          results.innerHTML = `<p class="portal-subtitle">${t("registration.no_matching_patients", "No matching patients found.")}</p>`;
        }

        // A direct pick from a name/phone/UHID search already has the UHID —
        // no ABHA identifier to resolve by, so this goes straight to the
        // existing patient-detail route rather than through resolve-by-abha.
        results.querySelectorAll("[data-uhid]").forEach((card) => {
          card.addEventListener("click", async () => {
            const detailRes = await fetch(`/api/patients/${encodeURIComponent(card.dataset.uhid)}`, { credentials: "same-origin" });
            const detailData = await detailRes.json();
            if (detailData.success) {
              renderFoundSummary({
                uhid: detailData.patient.uhid,
                full_name: detailData.patient.full_name,
                abha_id: detailData.patient.abha_id,
                last_visit_at: null,
              });
            }
          });
        });
      }, 300);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireAbhaVerify();
    wireManualSearch();

    window.addEventListener("i18n:languageChanged", () => {
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
