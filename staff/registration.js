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
          .map((p) => {
            const age = p.dob ? `, DOB ${new Date(p.dob).toLocaleDateString()}` : "";
            return `
              <div class="staff-entry-card">
                <div class="staff-entry-name">${escapeHtml(p.full_name)}</div>
                <div class="staff-entry-detail">${escapeHtml(p.gender || "—")}${age}</div>
                <div class="staff-entry-detail">${escapeHtml(p.phone || "—")}</div>
                <div class="staff-entry-detail">${escapeHtml(p.category || "—")}</div>
                <span class="staff-entry-userid">${escapeHtml(p.uhid)}</span>
              </div>`;
          })
          .join("");

        if (data.patients.length === 0) {
          results.innerHTML = `<p class="portal-subtitle">${t('registration.no_matching_patients', 'No matching patients found.')}</p>`;
        }
      }, 300);
    });
  }

  // Shared between wireAbhaFetch() and wireForm(): null (never attempted),
  // 'pending' (attempted but the ABHA provider was down/timed out — don't
  // block registration, just flag it for a later retry), 'not_found' (ABDM
  // confirmed no linked ABHA), or 'verified' (successfully fetched/verified).
  // ABHA verification is optional here — registration is never blocked on
  // it; this is only tracked so the patient record remembers whether/how
  // it was checked.
  let abhaLinkStatus = null;

  // RD Service client (rdServiceDeviceInfo/rdServiceCapture/etc.) lives in
  // the shared ../rd-service-client.js — see window.RdService, included on
  // this page before registration.js.
  const rdServiceDeviceInfo = window.RdService.deviceInfo;
  const rdServiceCapture = window.RdService.capture;
  const parseCaptureQuality = window.RdService.parseCaptureQuality;
  const buildMockPidXml = window.RdService.buildMockPidXml;

  function wireAbhaFetch() {
    // All three lookup methods (Mobile / Aadhaar / Fingerprint) are always
    // visible at once — no toggle swapping fields in and out (that read as
    // several different "portals" to staff), and no per-block button either
    // (that read as duplicate "Fetch Details" buttons). Staff fill in
    // exactly one block's field(s) and press the ONE common button below
    // all three (commonFetchBtn) — it inspects which block has data and
    // routes to that method. Mirrors staff/abha-creation.js's layout.
    const mobileInput = document.getElementById("abhaMobileInput");
    const aadhaarInput = document.getElementById("abhaAadhaarInput");
    const aadhaarMobileInput = document.getElementById("abhaAadhaarMobileInput");
    const commonFetchBtn = document.getElementById("abhaCommonFetchBtn");
    const otpSection = document.getElementById("abhaOtpSection");
    const otpInput = document.getElementById("abhaOtpInput");
    const verifyBtn = document.getElementById("abhaVerifyBtn");
    const bioAadhaarInput = document.getElementById("abhaBioAadhaarInput");
    const bioMobileInput = document.getElementById("abhaBioMobileInput");
    const bioDeviceStatus = document.getElementById("abhaBioDeviceStatus");
    const bioCaptureResult = document.getElementById("abhaBioCaptureResult");
    const bioQualityText = document.getElementById("abhaBioQualityText");
    const errorEl = document.getElementById("abhaError");
    const verifiedBadge = document.getElementById("abhaVerifiedBadge");
    const notFoundEl = document.getElementById("abhaNotFound");
    const sandboxEnrollToggle = document.getElementById("abhaSandboxEnrollToggle");
    const enrollSection = document.getElementById("abhaEnrollSection");
    const enrollAadhaarInput = document.getElementById("abhaEnrollAadhaarInput");
    const enrollFetchBtn = document.getElementById("abhaEnrollFetchBtn");
    const enrollOtpSection = document.getElementById("abhaEnrollOtpSection");
    const enrollOtpInput = document.getElementById("abhaEnrollOtpInput");
    const enrollMobileInput = document.getElementById("abhaEnrollMobileInput");
    const enrollVerifyBtn = document.getElementById("abhaEnrollVerifyBtn");

    let currentTxnId = null;
    let currentKind = null; // 'login' (mobile OTP) | 'enroll' (Aadhaar OTP)
    let bioDeviceChecked = false; // only probe the RD Service once per page load
    let bioDeviceReady = false; // set by checkRdServiceDevice() — gates the fingerprint branch of commonFetchBtn below
    let bioMockProvider = false; // set from /api/abha/status — gates the simulated-capture fallback below

    function hideCaptureQuality() {
      bioCaptureResult.hidden = true;
      bioCaptureResult.classList.remove("quality-fair", "quality-poor");
    }

    // Shows a "the scan came out clean" indicator using qScore — this is NOT
    // a preview of the fingerprint itself (see the warning note in the HTML:
    // RD Service always returns the print pre-encrypted, so no app, MEDISYS
    // included, can ever render the actual image). Thresholds are a rough
    // usability convention, not an ABDM/UIDAI-specified cutoff.
    function showCaptureQuality(pidXml) {
      const qScore = parseCaptureQuality(pidXml);
      bioCaptureResult.hidden = false;
      bioCaptureResult.classList.remove("quality-fair", "quality-poor");
      if (qScore === null) {
        bioQualityText.textContent = t('registration.bio_captured_no_score', 'Fingerprint captured.');
      } else if (qScore >= 50) {
        bioQualityText.textContent = t('registration.bio_captured_good', 'Fingerprint captured — good quality ({score}/100).', { score: qScore });
      } else if (qScore >= 25) {
        bioCaptureResult.classList.add("quality-fair");
        bioQualityText.textContent = t('registration.bio_captured_fair', 'Fingerprint captured — fair quality ({score}/100). Consider re-scanning.', { score: qScore });
      } else {
        bioCaptureResult.classList.add("quality-poor");
        bioQualityText.textContent = t('registration.bio_captured_poor', 'Weak capture ({score}/100) — please re-scan.', { score: qScore });
      }
    }

    async function checkRdServiceDevice() {
      bioDeviceStatus.textContent = t('registration.bio_checking_device', 'Checking for the Mantra RD Service…');
      bioDeviceReady = false;
      try {
        const statusRes = await fetch("/api/abha/status", { credentials: "same-origin" });
        const statusData = await statusRes.json();
        bioMockProvider = Boolean(statusData.mock);
      } catch {
        bioMockProvider = false; // unreachable/unclear — never assume mock, just fall through to the real device check
      }

      try {
        await rdServiceDeviceInfo();
        bioDeviceStatus.textContent = t('registration.bio_device_ready', 'Fingerprint scanner detected — ready to scan.');
        bioDeviceReady = true;
      } catch (err) {
        if (bioMockProvider) {
          // No physical scanner needed to demo the flow in mock mode — the
          // common Fetch Details button stays usable for this block and
          // simulates a capture instead.
          bioDeviceStatus.textContent = t(
            'registration.bio_mock_fallback',
            'No physical scanner detected — mock ABDM provider active, so filling in this block will simulate a capture for testing.'
          );
          bioDeviceReady = true;
        } else {
          bioDeviceStatus.textContent = t(
            'registration.bio_device_missing',
            'Mantra RD Service not detected on this machine ({error}). Make sure it is running and the MFS110 is plugged in.',
            { error: err.message }
          );
          bioDeviceReady = false;
        }
      }
    }

    function resetFlow() {
      otpSection.hidden = true;
      otpInput.value = "";
      errorEl.textContent = "";
      notFoundEl.hidden = true;
      enrollSection.hidden = true;
      verifiedBadge.hidden = true;
      hideCaptureQuality();
      currentTxnId = null;
      currentKind = null;
      abhaLinkStatus = null;
      document.getElementById("abhaVerificationMethod").value = "manual";
    }

    function applyProfile(profile, method) {
      if (profile.name) document.getElementById("fullName").value = profile.name;
      if (profile.dob) document.getElementById("dob").value = profile.dob;
      if (profile.gender) document.getElementById("gender").value = profile.gender;
      if (profile.mobile) document.getElementById("phone").value = profile.mobile;
      if (profile.address) document.getElementById("address").value = profile.address;
      document.getElementById("abhaId").value = profile.abhaNumber || "";
      document.getElementById("abhaAddress").value = profile.abhaAddress || "";
      document.getElementById("abhaVerificationMethod").value = method;

      abhaLinkStatus = "verified";
      verifiedBadge.hidden = false;
      otpSection.hidden = true;
      enrollSection.hidden = true;
      notFoundEl.hidden = true;
      errorEl.textContent = "";
      if (window.showToast) {
        showToast(
          profile.mock ? t('registration.abha_mock_fetched', 'ABHA details fetched (mock data — configure ABDM_PROVIDER for live lookups).') : t('registration.abha_fetched', 'ABHA details fetched and applied.'),
          "success"
        );
      }
    }

    // Option 1: Mobile Number — sends an OTP to that mobile via the login
    // flow (/api/abha/request-otp), same as before. Called from
    // commonFetchBtn below, not its own button.
    async function doMobileFetch(value) {
      const res = await fetch("/api/abha/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ type: "mobile", value }),
      });
      const data = await res.json();
      if (!data.success) {
        if (data.notFound) {
          abhaLinkStatus = "not_found";
          notFoundEl.hidden = false;
          return;
        }
        if (data.providerDown) abhaLinkStatus = "pending";
        errorEl.textContent = data.message || t('registration.could_not_send_otp', 'Could not send OTP. Please try again.');
        return;
      }
      currentTxnId = data.txnId;
      currentKind = "login";
      otpSection.hidden = false;
      otpInput.focus();
      if (window.showToast) {
        showToast(data.mock ? t('registration.mock_otp_sent', 'Mock OTP sent — use 111111.') : t('registration.otp_sent_mobile', 'OTP sent to the registered mobile.'), "success");
      }
    }

    // Option 2: Aadhaar Number — goes through the SAME ABDM enrollment call
    // staff/abha-creation.html uses (enrol/byAadhaar), not the login/OTP
    // call Mobile Number uses above — enrollment has proven reliably
    // working today (X-token/profile-fetch issues only ever hit the login
    // path), and it returns full details either way, whether the Aadhaar
    // already has an ABHA or not — same behavior as Create ABHA. That call
    // requires a mobile number alongside the OTP verify step. Called from
    // commonFetchBtn below, not its own button.
    async function doAadhaarFetch(value, mobile) {
      const res = await fetch("/api/abha/enroll/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ aadhaar: value }),
      });
      const data = await res.json();
      if (!data.success) {
        if (data.notFound) {
          abhaLinkStatus = "not_found";
          notFoundEl.hidden = false;
          return;
        }
        if (data.providerDown) abhaLinkStatus = "pending";
        errorEl.textContent = data.message || t('registration.could_not_send_otp', 'Could not send OTP. Please try again.');
        return;
      }
      currentTxnId = data.txnId;
      currentKind = "enroll";
      otpSection.hidden = false;
      otpInput.focus();
      if (window.showToast) {
        showToast(data.mock ? t('registration.mock_otp_sent', 'Mock OTP sent — use 111111.') : t('registration.otp_sent_aadhaar', 'OTP sent to the Aadhaar-linked mobile.'), "success");
      }
    }

    async function doVerify(endpoint, body, method) {
      verifyBtn.disabled = true;
      errorEl.textContent = "";
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.success) {
          if (data.notFound) {
            abhaLinkStatus = "not_found";
            otpSection.hidden = true;
            notFoundEl.hidden = false;
          } else {
            if (data.providerDown) abhaLinkStatus = "pending";
            errorEl.textContent = data.message || t('registration.verification_failed', 'Verification failed. Please try again.');
          }
          return;
        }
        applyProfile(data.profile, method);
      } catch (err) {
        abhaLinkStatus = "pending";
        errorEl.textContent = t('registration.unable_reach_server_manual', 'Unable to reach the server. You can continue with manual registration below.');
      } finally {
        verifyBtn.disabled = false;
      }
    }

    verifyBtn.addEventListener("click", () => {
      const otp = otpInput.value.trim();
      if (!otp) {
        errorEl.textContent = t('registration.enter_otp_first', 'Enter the OTP first.');
        return;
      }
      if (!currentTxnId) {
        errorEl.textContent = t('registration.otp_expired', 'Please fetch details again — this OTP request has expired.');
        return;
      }
      if (currentKind === "enroll") {
        // Reached when Option 2 (Aadhaar Number) sent this OTP via
        // /api/abha/enroll/request-otp above — the mobile number comes from
        // its own dedicated field, not the main form's Phone field, which
        // is empty at this point in a fresh registration.
        const mobile = aadhaarMobileInput.value.trim();
        doVerify("/api/abha/enroll/verify-otp", { txnId: currentTxnId, otp, mobile }, "aadhaar_otp");
      } else {
        // currentKind === "login" — Option 1 (Mobile Number) is the only
        // path left that uses the login/OTP call.
        doVerify("/api/abha/verify-otp", { txnId: currentTxnId, otp }, "mobile_otp");
      }
    });

    // Fingerprint verification — unlike the OTP flows above this is one-shot:
    // the RD Service capture itself is the biometric proof, so there's no
    // separate request/verify txnId round-trip. The staff member enters the
    // Aadhaar number to check the fingerprint against; commonFetchBtn below
    // triggers the actual scan+verify together in a single call — there's
    // no separate "Scan Fingerprint" button any more.
    async function doBioScan(aadhaar, mobile) {
      const previousStatus = bioDeviceStatus.textContent;
      bioDeviceStatus.textContent = t('registration.bio_scanning', 'Place finger on the scanner…');
      try {
        let pidXml;
        try {
          pidXml = await rdServiceCapture();
          bioDeviceStatus.textContent = t('registration.bio_verifying', 'Verifying with ABHA…');
        } catch (captureErr) {
          // Only ever simulate a capture when the server has confirmed
          // ABDM_PROVIDER=mock (see checkRdServiceDevice()) — against a real
          // provider a capture failure surfaces as a real error below.
          if (!bioMockProvider) throw captureErr;
          pidXml = buildMockPidXml();
          bioDeviceStatus.textContent = t(
            'registration.bio_mock_capture',
            'Using a simulated fingerprint capture (mock ABDM provider) — verifying with ABHA…'
          );
        }
        showCaptureQuality(pidXml);
        const res = await fetch("/api/abha/verify-bio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ aadhaar, mobile, pidXml }),
        });
        const data = await res.json();
        if (!data.success) {
          if (data.notFound) {
            abhaLinkStatus = "not_found";
            notFoundEl.hidden = false;
          } else {
            if (data.providerDown) abhaLinkStatus = "pending";
            errorEl.textContent = data.message || t('registration.verification_failed', 'Verification failed. Please try again.');
          }
          return;
        }
        applyProfile(data.profile, "fingerprint");
      } catch (err) {
        abhaLinkStatus = "pending";
        errorEl.textContent = err.message || t('registration.bio_scan_failed', 'Fingerprint scan failed. Please try again.');
      } finally {
        bioDeviceStatus.textContent = previousStatus;
      }
    }

    // The ONE common button for all three options above (see the HTML
    // comment on #abhaCommonFetchBtn) — figures out which single block has
    // data filled in and routes to that method's fetch function. Staff
    // should fill in exactly one block and leave the other two blank.
    commonFetchBtn.addEventListener("click", async () => {
      resetFlow();

      const mobileFilled = mobileInput.value.trim() !== "";
      const aadhaarFilled = aadhaarInput.value.trim() !== "" || aadhaarMobileInput.value.trim() !== "";
      const bioFilled = bioAadhaarInput.value.trim() !== "" || bioMobileInput.value.trim() !== "";
      const filledCount = [mobileFilled, aadhaarFilled, bioFilled].filter(Boolean).length;

      if (filledCount === 0) {
        errorEl.textContent = t('registration.fill_one_option', 'Fill in one of the three options above first (Mobile Number, Aadhaar Number, or Fingerprint).');
        return;
      }
      if (filledCount > 1) {
        errorEl.textContent = t('registration.fill_only_one_option', 'Fill in only ONE of the three options above, then fetch — clear the others first.');
        return;
      }

      commonFetchBtn.disabled = true;
      try {
        if (mobileFilled) {
          const value = mobileInput.value.trim();
          if (!/^[6-9]\d{9}$/.test(value)) {
            errorEl.textContent = t('registration.enter_valid_mobile', 'Enter a valid 10-digit mobile number.');
            return;
          }
          await doMobileFetch(value);
        } else if (aadhaarFilled) {
          const value = aadhaarInput.value.trim();
          if (!/^\d{12}$/.test(value)) {
            errorEl.textContent = t('registration.enter_valid_aadhaar', 'Enter a valid 12-digit Aadhaar number.');
            return;
          }
          const mobile = aadhaarMobileInput.value.trim();
          if (!/^[6-9]\d{9}$/.test(mobile)) {
            errorEl.textContent = t('registration.enter_valid_mobile', 'Enter a valid 10-digit mobile number for this lookup.');
            return;
          }
          await doAadhaarFetch(value, mobile);
        } else {
          const aadhaar = bioAadhaarInput.value.trim();
          if (!/^\d{12}$/.test(aadhaar)) {
            errorEl.textContent = t('registration.enter_valid_aadhaar', 'Enter a valid 12-digit Aadhaar number.');
            return;
          }
          const mobile = bioMobileInput.value.trim();
          if (!/^[6-9]\d{9}$/.test(mobile)) {
            errorEl.textContent = t('registration.enter_valid_mobile', 'Enter a valid 10-digit mobile number for this lookup.');
            return;
          }
          if (!bioDeviceReady) {
            errorEl.textContent = bioDeviceStatus.textContent || t('registration.bio_device_missing_short', 'Fingerprint scanner not ready — see the status above.');
            return;
          }
          await doBioScan(aadhaar, mobile);
        }
      } catch (err) {
        abhaLinkStatus = "pending";
        errorEl.textContent = err.message || t('registration.unable_reach_server_manual', 'Unable to reach the server. You can continue with manual registration below.');
      } finally {
        commonFetchBtn.disabled = false;
      }
    });

    // Sandbox-only test-ABHA creation — deliberately tucked behind a collapsed
    // toggle inside the "not found" box (not a primary action) so it can't be
    // mistaken for the right move on a real patient. Real patients should
    // self-create via the official ABHA app/portal (see the guidance text
    // above this toggle) — MEDISYS never creates ABHA accounts on their behalf.
    sandboxEnrollToggle.addEventListener("click", () => {
      enrollSection.hidden = !enrollSection.hidden;
      if (!enrollSection.hidden) enrollAadhaarInput.focus();
    });

    enrollFetchBtn.addEventListener("click", async () => {
      const aadhaar = enrollAadhaarInput.value.trim();
      if (!/^\d{12}$/.test(aadhaar)) {
        errorEl.textContent = t('registration.enter_valid_aadhaar', 'Enter a valid 12-digit Aadhaar number.');
        return;
      }
      enrollFetchBtn.disabled = true;
      errorEl.textContent = "";
      try {
        const res = await fetch("/api/abha/enroll/request-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ aadhaar }),
        });
        const data = await res.json();
        if (!data.success) {
          if (data.providerDown) abhaLinkStatus = "pending";
          errorEl.textContent = data.message || t('registration.could_not_send_otp', 'Could not send OTP. Please try again.');
          return;
        }
        currentTxnId = data.txnId;
        currentKind = "enroll";
        enrollOtpSection.hidden = false;
        enrollOtpInput.value = "";
        enrollOtpInput.focus();
        if (window.showToast) {
          showToast(data.mock ? t('registration.mock_otp_sent', 'Mock OTP sent — use 111111.') : t('registration.otp_sent_aadhaar', 'OTP sent to the Aadhaar-linked mobile.'), "success");
        }
      } catch (err) {
        abhaLinkStatus = "pending";
        errorEl.textContent = t('registration.unable_reach_server_manual', 'Unable to reach the server. You can continue with manual registration below.');
      } finally {
        enrollFetchBtn.disabled = false;
      }
    });

    enrollVerifyBtn.addEventListener("click", async () => {
      const otp = enrollOtpInput.value.trim();
      const mobile = enrollMobileInput.value.trim();
      if (!otp) {
        errorEl.textContent = t('registration.enter_otp_first', 'Enter the OTP first.');
        return;
      }
      if (!/^[6-9]\d{9}$/.test(mobile)) {
        errorEl.textContent = t('registration.enter_valid_mobile', 'Enter a valid 10-digit mobile number for the new ABHA.');
        return;
      }
      if (!currentTxnId) {
        errorEl.textContent = t('registration.otp_expired', 'Please send the OTP again — this request has expired.');
        return;
      }
      enrollVerifyBtn.disabled = true;
      errorEl.textContent = "";
      try {
        const res = await fetch("/api/abha/enroll/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ txnId: currentTxnId, otp, mobile }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t('registration.verification_failed', 'Verification failed. Please try again.');
          return;
        }
        applyProfile(data.profile, "aadhaar_otp");
      } catch (err) {
        abhaLinkStatus = "pending";
        errorEl.textContent = t('registration.unable_reach_server_manual', 'Unable to reach the server. You can continue with manual registration below.');
      } finally {
        enrollVerifyBtn.disabled = false;
      }
    });

    // ABHA fields are hand-editable now (staff can type a patient's existing
    // ABHA straight from their card/app). If someone edits away what a
    // successful OTP fetch just filled in, the "Verified via ABHA" claim is
    // no longer true — drop it back to unverified rather than leave a stale
    // badge next to a hand-typed value.
    const abhaIdField = document.getElementById("abhaId");
    const abhaAddressField = document.getElementById("abhaAddress");
    function clearVerifiedOnManualEdit() {
      if (!verifiedBadge.hidden) {
        verifiedBadge.hidden = true;
        abhaLinkStatus = null;
        document.getElementById("abhaVerificationMethod").value = "manual";
      }
    }
    abhaIdField.addEventListener("input", clearVerifiedOnManualEdit);
    abhaAddressField.addEventListener("input", clearVerifiedOnManualEdit);

    // Fingerprint block is always visible now (no toggle gating it), so
    // probe the RD Service once, right away, instead of waiting for a
    // biometric-mode switch that no longer exists.
    if (!bioDeviceChecked) {
      bioDeviceChecked = true;
      checkRdServiceDevice();
    }

    // Hand-off from staff/patient-checkin.js and staff/abha-creation.js:
    // both stash an already-verified profile here and redirect into this
    // page rather than making staff re-verify from scratch. sessionStorage
    // (not localStorage) so it can't linger across tabs/days — consumed
    // once and removed immediately either way, verified data or not.
    try {
      const pendingRaw = sessionStorage.getItem("medisysPendingAbhaProfile");
      if (pendingRaw) {
        sessionStorage.removeItem("medisysPendingAbhaProfile");
        const pending = JSON.parse(pendingRaw);
        if (pending && pending.profile && pending.method) {
          applyProfile(pending.profile, pending.method);
          if (window.showToast) {
            showToast(
              t('registration.abha_handoff_applied', 'ABHA details applied — review and complete registration below.'),
              "success"
            );
          }
        }
      }
    } catch {
      // Malformed/stale sessionStorage entry — ignore, staff falls back to
      // fetching via ABHA normally on this page.
    }
  }

  function wireForm() {
    const form = document.getElementById("patientForm");
    const errorEl = document.getElementById("patientFormError");
    const submitBtn = document.getElementById("submitPatientBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorEl.textContent = "";

      const fullName = document.getElementById("fullName").value.trim();
      if (!fullName) {
        errorEl.textContent = t('registration.name_required', 'Patient name is required.');
        return;
      }

      submitBtn.disabled = true;
      try {
        const res = await fetch("/api/patients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            fullName,
            dob: document.getElementById("dob").value,
            gender: document.getElementById("gender").value,
            phone: document.getElementById("phone").value.trim(),
            address: document.getElementById("address").value.trim(),
            emergencyContactName: document.getElementById("emergencyContactName").value.trim(),
            emergencyContactPhone: document.getElementById("emergencyContactPhone").value.trim(),
            abhaId: document.getElementById("abhaId").value.trim(),
            abhaAddress: document.getElementById("abhaAddress").value.trim(),
            abhaVerified: !document.getElementById("abhaVerifiedBadge").hidden,
            abhaLinkStatus,
            abhaVerificationMethod: document.getElementById("abhaVerificationMethod").value,
            category: document.getElementById("category").value,
            uhid: document.getElementById("uhidCustom").value.trim(),
            password: document.getElementById("patientPasswordCustom").value.trim(),
          }),
        });
        const data = await res.json();

        if (!data.success) {
          errorEl.textContent = data.message || t('registration.error_create', 'Could not register patient. Please try again.');
          return;
        }

        form.hidden = true;
        document.getElementById("uhidOutput").value = data.patient.uhid;
        document.getElementById("patientPasswordOutput").value = data.patient.password;
        document.getElementById("patientResult").hidden = false;
        if (window.showToast) showToast(t('registration.patient_registered_toast', '{patient} {name} {registeredLabel} {uhid}', { patient: t('registration.patient', 'Patient'), name: fullName, registeredLabel: t('registration.registered_uhid', 'registered — UHID'), uhid: data.patient.uhid }), "success");
      } catch (err) {
        errorEl.textContent = t('common.server_error', 'Unable to reach the server. Please try again.');
      } finally {
        submitBtn.disabled = false;
      }
    });

    function wireCopyButton(buttonId, inputId) {
      document.getElementById(buttonId).addEventListener("click", () => {
        const input = document.getElementById(inputId);
        input.select();
        navigator.clipboard.writeText(input.value).catch(() => {});
      });
    }
    wireCopyButton("copyUhidBtn", "uhidOutput");
    wireCopyButton("copyPatientPasswordBtn", "patientPasswordOutput");

    document.getElementById("suggestPatientPasswordBtn").addEventListener("click", () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
      let pw = "";
      for (let i = 0; i < 10; i++) pw += chars[Math.floor(Math.random() * chars.length)];
      document.getElementById("patientPasswordCustom").value = pw;
    });

    // Suggests what the auto-generated UHID would look like (PAT-<hospital
    // code>-<number>) without waiting for submit — staff can still edit or
    // clear it; leaving it blank still auto-generates normally at submit
    // time. This is a preview only (see /api/patients/next-uhid on the
    // server) — the real UHID is assigned at insert time, so a rare race
    // with another concurrent registration is caught by the same
    // "already in use" check a hand-typed UHID goes through.
    document.getElementById("suggestUhidBtn").addEventListener("click", async () => {
      const btn = document.getElementById("suggestUhidBtn");
      const uhidInput = document.getElementById("uhidCustom");
      btn.disabled = true;
      try {
        const res = await fetch("/api/patients/next-uhid", { credentials: "same-origin" });
        const data = await res.json();
        if (data.success) {
          uhidInput.value = data.uhid;
        } else if (window.showToast) {
          showToast(data.message || t('registration.uhid_suggest_failed', 'Could not suggest a UHID. Please try again.'), "error");
        }
      } catch {
        if (window.showToast) {
          showToast(t('common.server_error', 'Unable to reach the server. Please try again.'), "error");
        }
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("registerAnotherBtn").addEventListener("click", () => {
      form.reset();
      form.hidden = false;
      document.getElementById("patientResult").hidden = true;
      document.getElementById("abhaVerifiedBadge").hidden = true;
      document.getElementById("abhaOtpSection").hidden = true;
      document.getElementById("abhaNotFound").hidden = true;
      document.getElementById("abhaEnrollSection").hidden = true;
      document.getElementById("abhaEnrollOtpSection").hidden = true;
      document.getElementById("abhaEnrollError").textContent = "";
      document.getElementById("abhaEnrollAadhaarInput").value = "";
      document.getElementById("abhaEnrollOtpInput").value = "";
      document.getElementById("abhaEnrollMobileInput").value = "";
      document.getElementById("abhaBioCaptureResult").hidden = true;
      document.getElementById("abhaBioCaptureResult").classList.remove("quality-fair", "quality-poor");
      document.getElementById("abhaError").textContent = "";
      document.getElementById("abhaMobileInput").value = "";
      document.getElementById("abhaAadhaarInput").value = "";
      document.getElementById("abhaBioAadhaarInput").value = "";
      document.getElementById("abhaBioMobileInput").value = "";
      document.getElementById("abhaAadhaarMobileInput").value = "";
      document.getElementById("abhaVerificationMethod").value = "manual";
      abhaLinkStatus = null;
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireSearch();
    wireAbhaFetch();
    wireForm();

    window.addEventListener("i18n:languageChanged", () => {
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
