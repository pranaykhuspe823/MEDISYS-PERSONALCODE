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

  let hospitalName = "";
  let lastProfile = null; // kept for the Print/Save and Register buttons after a successful creation

  // ---------- Result screen ----------

  function renderResult(profile, method) {
    const titleEl = document.getElementById("creationResultTitle");
    const hintEl = document.getElementById("creationResultHint");
    const dl = document.getElementById("creationResultDetails");

    // The real ABDM provider (nha.js) doesn't currently surface whether this
    // call created a brand-new ABHA or found one that already existed for
    // this Aadhaar — only mock.js/ekacare.js set profile.newlyCreated. Rather
    // than guess at an unconfirmed distinction, this shows a neutral outcome
    // when that flag is simply absent, and a specific one when a provider
    // does report it — see server/abdmProviders/nha.js's verifyEnrollmentOtp/
    // verifyBio for where that flag would need to come from if ABDM's real
    // response ever turns out to carry one.
    if (profile.newlyCreated === true) {
      titleEl.textContent = t("abha_creation.created_title", "ABHA Created");
      hintEl.textContent = t("abha_creation.created_hint", "A brand-new ABHA has been created for this Aadhaar number.");
    } else if (profile.newlyCreated === false) {
      titleEl.textContent = t("abha_creation.existing_title", "This Aadhaar Already Has an ABHA");
      hintEl.textContent = t("abha_creation.existing_hint", "No new account was created — here are the existing ABHA details for this Aadhaar number.");
    } else {
      titleEl.textContent = t("abha_creation.ready_title", "ABHA Ready");
      hintEl.textContent = t(
        "abha_creation.ready_hint",
        "Verified successfully. Whether this is a newly created ABHA or one that already existed couldn't be confirmed from the provider's response — either way, these are the account's current details."
      );
    }

    const rows = [
      [t("registration.abha_id", "ABHA ID"), profile.abhaNumber],
      [t("abha_creation.abha_address", "ABHA Address"), profile.abhaAddress],
      [t("common.patient", "Patient"), profile.name],
      [t("registration.dob", "Date of Birth"), profile.dob],
      [t("patient.gender", "Gender"), profile.gender],
      [t("registration.phone", "Mobile"), profile.mobile],
      [t("registration.address", "Address"), profile.address],
    ];
    dl.innerHTML = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "—")}</dd>`).join("");

    lastProfile = { ...profile, verificationMethod: method };
    document.getElementById("creationFormCard").hidden = true;
    document.getElementById("creationResult").hidden = false;
    if (window.showToast) {
      showToast(t("abha_creation.success_toast", "ABHA verified successfully."), "success");
    }
  }

  function wirePrint() {
    document.getElementById("creationPrintBtn").addEventListener("click", () => {
      if (!lastProfile) return;
      document.getElementById("printHospitalName").textContent = hospitalName || "MEDISYS Hospital";
      document.getElementById("printSheetDate").textContent = new Date().toLocaleString();
      const rows = [
        [t("registration.abha_id", "ABHA ID"), lastProfile.abhaNumber],
        [t("abha_creation.abha_address", "ABHA Address"), lastProfile.abhaAddress],
        [t("common.patient", "Patient"), lastProfile.name],
        [t("registration.dob", "Date of Birth"), lastProfile.dob],
        [t("patient.gender", "Gender"), lastProfile.gender],
        [t("registration.phone", "Mobile"), lastProfile.mobile],
        [t("registration.address", "Address"), lastProfile.address],
      ];
      document.getElementById("printSheetDetails").innerHTML = rows
        .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "—")}</dd>`)
        .join("");
      const sheet = document.getElementById("abhaCardPrintSheet");
      sheet.hidden = false;
      window.print();
      sheet.hidden = true;
    });
  }

  function wireRegisterHandoff() {
    document.getElementById("creationRegisterBtn").addEventListener("click", () => {
      if (!lastProfile) return;
      // Same hand-off mechanism staff/patient-checkin.js's "not found" path
      // already uses — sessionStorage, consumed once by
      // staff/registration.js's applyProfileFields() on load. Reused as-is,
      // not a second implementation.
      try {
        sessionStorage.setItem(
          "medisysPendingAbhaProfile",
          JSON.stringify({ profile: lastProfile, method: lastProfile.verificationMethod })
        );
      } catch {
        // sessionStorage unavailable — registration page still works, just
        // without the pre-fill.
      }
      window.location.href = "registration";
    });
  }

  function resetForm() {
    document.getElementById("creationFormCard").hidden = false;
    document.getElementById("creationResult").hidden = true;
    document.getElementById("creationAadhaarInput").value = "";
    document.getElementById("creationMobileInput").value = "";
    document.getElementById("creationMethodAadhaar").checked = true;
    document.getElementById("creationError").textContent = "";
    document.getElementById("creationOtpSection").hidden = true;
    document.getElementById("creationOtpInput").value = "";
    lastProfile = null;
    updateMethodVisibility();
  }

  // ---------- Method toggle + verification ----------

  let currentTxnId = null;
  let bioDeviceChecked = false;
  let bioMockProvider = false;

  const methodAadhaar = () => document.getElementById("creationMethodAadhaar").checked;

  function updateMethodVisibility() {
    const aadhaarMethod = methodAadhaar();
    document.getElementById("creationOtpRow").hidden = !aadhaarMethod;
    document.getElementById("creationOtpSection").hidden = true;
    document.getElementById("creationBioSection").hidden = aadhaarMethod;
    document.getElementById("creationError").textContent = "";
    currentTxnId = null;
    if (!aadhaarMethod && !bioDeviceChecked) {
      bioDeviceChecked = true;
      checkRdServiceDevice();
    }
  }

  function validAadhaar() {
    return /^\d{12}$/.test(document.getElementById("creationAadhaarInput").value.trim());
  }
  function validMobile() {
    return /^[6-9]\d{9}$/.test(document.getElementById("creationMobileInput").value.trim());
  }

  async function checkRdServiceDevice() {
    const statusEl = document.getElementById("creationBioDeviceStatus");
    const scanBtn = document.getElementById("creationBioScanBtn");
    statusEl.textContent = t("registration.bio_checking_device", "Checking for the Mantra RD Service…");
    scanBtn.disabled = true;
    try {
      const statusRes = await fetch("/api/abha/status", { credentials: "same-origin" });
      const statusData = await statusRes.json();
      bioMockProvider = Boolean(statusData.mock);
    } catch {
      bioMockProvider = false;
    }
    try {
      await rdServiceDeviceInfo();
      statusEl.textContent = t("registration.bio_device_ready", "Fingerprint scanner detected — ready to scan.");
      scanBtn.disabled = false;
    } catch (err) {
      if (bioMockProvider) {
        statusEl.textContent = t(
          "registration.bio_mock_fallback",
          'No physical scanner detected — mock ABDM provider active, so "Scan Fingerprint" will simulate a capture for testing.'
        );
        scanBtn.disabled = false;
      } else {
        statusEl.textContent = t(
          "registration.bio_device_missing",
          "Mantra RD Service not detected on this machine ({error}). Make sure it is running and the MFS110 is plugged in.",
          { error: err.message }
        );
        scanBtn.disabled = true;
      }
    }
  }

  function wireMethodToggle() {
    document.getElementById("creationMethodAadhaar").addEventListener("change", updateMethodVisibility);
    document.getElementById("creationMethodBiometric").addEventListener("change", updateMethodVisibility);
    updateMethodVisibility();
  }

  function wireAadhaarOtp() {
    const errorEl = document.getElementById("creationError");
    const sendBtn = document.getElementById("creationSendOtpBtn");
    const otpSection = document.getElementById("creationOtpSection");
    const otpInput = document.getElementById("creationOtpInput");
    const verifyBtn = document.getElementById("creationVerifyOtpBtn");

    sendBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      if (!validAadhaar()) {
        errorEl.textContent = t("registration.enter_valid_aadhaar", "Enter a valid 12-digit Aadhaar number.");
        return;
      }
      sendBtn.disabled = true;
      try {
        const res = await fetch("/api/abha/enroll/request-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ aadhaar: document.getElementById("creationAadhaarInput").value.trim() }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("registration.could_not_send_otp", "Could not send OTP. Please try again.");
          return;
        }
        currentTxnId = data.txnId;
        otpSection.hidden = false;
        otpInput.value = "";
        otpInput.focus();
        if (window.showToast) {
          showToast(data.mock ? t("registration.mock_otp_sent", "Mock OTP sent — use 111111.") : t("registration.otp_sent_aadhaar", "OTP sent to the Aadhaar-linked mobile."), "success");
        }
      } catch {
        errorEl.textContent = t("registration.unable_reach_server_manual", "Unable to reach the server. Please try again.");
      } finally {
        sendBtn.disabled = false;
      }
    });

    verifyBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      const otp = otpInput.value.trim();
      if (!otp) {
        errorEl.textContent = t("registration.enter_otp_first", "Enter the OTP first.");
        return;
      }
      if (!validMobile()) {
        errorEl.textContent = t("registration.enter_valid_mobile", "Enter a valid 10-digit mobile number for the new ABHA.");
        return;
      }
      if (!currentTxnId) {
        errorEl.textContent = t("registration.otp_expired", "Please send the OTP again — this request has expired.");
        return;
      }
      verifyBtn.disabled = true;
      try {
        const res = await fetch("/api/abha/enroll/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ txnId: currentTxnId, otp, mobile: document.getElementById("creationMobileInput").value.trim() }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("registration.verification_failed", "Verification failed. Please try again.");
          return;
        }
        renderResult(data.profile, "aadhaar_otp");
      } catch {
        errorEl.textContent = t("registration.unable_reach_server_manual", "Unable to reach the server. Please try again.");
      } finally {
        verifyBtn.disabled = false;
      }
    });
  }

  function wireFingerprint() {
    const errorEl = document.getElementById("creationError");
    const scanBtn = document.getElementById("creationBioScanBtn");
    const statusEl = document.getElementById("creationBioDeviceStatus");
    const captureResult = document.getElementById("creationBioCaptureResult");
    const qualityText = document.getElementById("creationBioQualityText");

    // The device check normally only runs once (the first time Fingerprint
    // is selected — see updateMethodVisibility()) — if RD Service wasn't
    // ready yet at that exact moment (still starting, scanner plugged in a
    // second late), it never re-checks on its own, even though the device
    // may be fine seconds later. This lets staff force a fresh check
    // without reloading the whole page.
    document.getElementById("creationBioRecheckBtn").addEventListener("click", () => {
      checkRdServiceDevice();
    });

    function showCaptureQuality(pidXml) {
      const qScore = parseCaptureQuality(pidXml);
      captureResult.hidden = false;
      captureResult.classList.remove("quality-fair", "quality-poor");
      if (qScore === null) {
        qualityText.textContent = t("registration.bio_captured_no_score", "Fingerprint captured.");
      } else if (qScore >= 50) {
        qualityText.textContent = t("registration.bio_captured_good", "Fingerprint captured — good quality ({score}/100).", { score: qScore });
      } else if (qScore >= 25) {
        captureResult.classList.add("quality-fair");
        qualityText.textContent = t("registration.bio_captured_fair", "Fingerprint captured — fair quality ({score}/100). Consider re-scanning.", { score: qScore });
      } else {
        captureResult.classList.add("quality-poor");
        qualityText.textContent = t("registration.bio_captured_poor", "Weak capture ({score}/100) — please re-scan.", { score: qScore });
      }
    }

    scanBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      if (!validAadhaar()) {
        errorEl.textContent = t("registration.enter_valid_aadhaar", "Enter a valid 12-digit Aadhaar number.");
        return;
      }
      if (!validMobile()) {
        errorEl.textContent = t("registration.enter_valid_mobile", "Enter a valid 10-digit mobile number for the new ABHA.");
        return;
      }
      scanBtn.disabled = true;
      const previousStatus = statusEl.textContent;
      statusEl.textContent = t("registration.bio_scanning", "Place finger on the scanner…");
      try {
        let pidXml;
        try {
          pidXml = await rdServiceCapture();
          statusEl.textContent = t("registration.bio_verifying", "Verifying with ABHA…");
        } catch (captureErr) {
          if (!bioMockProvider) throw captureErr;
          pidXml = buildMockPidXml();
          statusEl.textContent = t("registration.bio_mock_capture", "Using a simulated fingerprint capture (mock ABDM provider) — verifying with ABHA…");
        }
        showCaptureQuality(pidXml);
        const aadhaar = document.getElementById("creationAadhaarInput").value.trim();
        const mobile = document.getElementById("creationMobileInput").value.trim();
        const res = await fetch("/api/abha/verify-bio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ aadhaar, mobile, pidXml }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t("registration.verification_failed", "Verification failed. Please try again.");
          return;
        }
        // /api/abha/verify-bio DOES require this mobile number now (ABDM's
        // bio auth path needs it just like the Aadhaar-OTP enrollment path —
        // see the fix note on abdmProviders/nha.js's verifyBio(), 2026-09-09)
        // — still falling back to what staff entered here in case the
        // server ever omits it from the returned profile.
        const profile = { ...data.profile, mobile: data.profile.mobile || mobile };
        renderResult(profile, "fingerprint");
      } catch (err) {
        errorEl.textContent = err.message || t("registration.bio_scan_failed", "Fingerprint scan failed. Please try again.");
      } finally {
        statusEl.textContent = previousStatus;
        scanBtn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    hospitalName = user.hospitalName || "";
    wireLogout();
    wireMethodToggle();
    wireAadhaarOtp();
    wireFingerprint();
    wirePrint();
    wireRegisterHandoff();
    document.getElementById("creationAnotherBtn").addEventListener("click", resetForm);

    window.addEventListener("i18n:languageChanged", () => {
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
