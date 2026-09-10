// Shared Mantra RD Service client — the local fingerprint scanner bridge.
// Used by any staff page that offers fingerprint-based ABHA lookup
// (staff/registration.js, staff/patient-checkin.js). Include this script
// BEFORE the page's own script tag; it exposes everything as window.RdService
// so callers don't duplicate this logic (see MEDISYS's staff pages for the
// established root-level shared-module pattern, e.g. medicine-autocomplete.js).
//
// The Mantra MFS110 scanner is driven by the "Mantra RD Service" app that
// runs locally on the staff PC and exposes a small HTTP server on
// 127.0.0.1:11100 using the standard RD Service verbs (DEVICEINFO, CAPTURE)
// instead of GET/POST. It always answers with HTTP 200 — even on failure (no
// device, timeout, bad capture) — so every response has to be parsed for
// errCode/errInfo out of the XML body rather than trusted from the status
// code.
(function () {
  const RD_SERVICE_BASE_URL = "http://127.0.0.1:11100";

  function parseRdServiceError(xmlText) {
    const errCodeMatch = xmlText.match(/errCode="([^"]*)"/);
    const errInfoMatch = xmlText.match(/errInfo="([^"]*)"/);
    return { errCode: errCodeMatch ? errCodeMatch[1] : null, errInfo: errInfoMatch ? errInfoMatch[1] : "" };
  }

  // fetch() deliberately gives no way to tell "nothing is listening on this
  // port" apart from "the browser blocked this request before it ever left
  // the page" — both surface as the exact same generic TypeError: Failed to
  // fetch, with no further detail exposed to JS. That's intentional browser
  // security (an untrusted page can't be allowed to use error/timing
  // differences to port-scan a user's local network), not something client
  // code can work around, so this message has to name multiple possible
  // real causes rather than guess one.
  //
  // History, so nobody re-diagnoses this from scratch: this exact symptom
  // (curl to RD Service always succeeding, every browser fetch() failing
  // identically regardless of whether RD Service was even running) was
  // chased for a while as a Chrome Private Network Access issue before
  // being root-caused via Chrome DevTools Protocol inspection on
  // 2026-09-09 — zero Network.requestWillBeSent events were firing for the
  // RD Service call at all, meaning it was blocked by this app's own
  // Content-Security-Policy connect-src directive (server/server.js),
  // before ever becoming a network request; a real PNA block would still
  // show the request, then fail it with a blockedReason. Fixed once,
  // server-side, by adding http://127.0.0.1:11100 to connect-src — no
  // per-PC browser configuration needed for the localhost deployment this
  // app expects. PNA (or an actual LAN-IP/domain access pattern) remains a
  // real possible cause if this error resurfaces in a setup where MEDISYS
  // is reached over the network rather than localhost on the same PC as
  // the scanner — that's a different, unsolved deployment question.
  function rdServiceUnreachableError() {
    const err = new Error(
      "Can't reach the Mantra RD Service. Either it isn't running, or this browser is blocking the local connection — see the checklist below."
    );
    err.code = "RD_UNREACHABLE";
    return err;
  }

  // The captured <PidData>'s quality score (qScore, 0-100) sits in the
  // <Resp> element alongside errCode/errInfo — unencrypted, unlike the
  // actual print data in <Data>, which UIDAI's spec requires RD Service to
  // return pre-encrypted so only ABDM can ever decrypt it. qScore is as
  // close to "did this scan come out clean" as this app can show; there is
  // no way to render the real fingerprint image itself.
  function parseCaptureQuality(xmlText) {
    const qScoreMatch = xmlText.match(/qScore="([^"]*)"/);
    return qScoreMatch && qScoreMatch[1] !== "" ? Number(qScoreMatch[1]) : null;
  }

  async function deviceInfo() {
    let res;
    try {
      res = await fetch(`${RD_SERVICE_BASE_URL}/rd/info`, { method: "DEVICEINFO" });
    } catch {
      throw rdServiceUnreachableError();
    }
    const text = await res.text();
    const { errCode, errInfo } = parseRdServiceError(text);
    if (errCode && errCode !== "0") {
      const err = new Error(errInfo || `RD Service device check failed (errCode ${errCode}).`);
      err.code = "RD_ERROR";
      throw err;
    }
    // Some RD Service builds (confirmed against a live Mantra L1/AVDM service
    // on 2026-09-09) don't put errCode/errInfo on /rd/info at all — with no
    // scanner plugged in it still answers what looks like a clean
    // <DeviceInfo>, just with an empty srno. Without this check the UI would
    // report "ready" the moment RD Service is merely running, regardless of
    // whether a device is actually attached.
    const srnoMatch = text.match(/name="srno"\s+value="([^"]*)"/);
    if (srnoMatch && srnoMatch[1].trim() === "") {
      const err = new Error("No fingerprint device detected — plug in the MFS110 and try again.");
      err.code = "NO_DEVICE";
      throw err;
    }
    return text;
  }

  async function capture() {
    const pidOptions =
      '<PidOptions ver="1.0"><Opts fCount="1" fType="2" pCount="0" format="0" pidVer="2.0" timeout="20000" posh="UNKNOWN" env="P" /></PidOptions>';
    // RD Service's own PidOptions timeout="20000" (ms) should make it answer
    // within 20s either way (a capture or a timeout errCode) — this abort is
    // just a hard backstop in case the service hangs without honoring that,
    // so the UI never gets stuck showing "Place finger on the scanner…"
    // forever.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25000);
    let res;
    try {
      res = await fetch(`${RD_SERVICE_BASE_URL}/rd/capture`, {
        method: "CAPTURE",
        headers: { "Content-Type": "text/xml" },
        body: pidOptions,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        const e = new Error("Fingerprint capture timed out — no finger detected on the scanner. Try again.");
        e.code = "CAPTURE_TIMEOUT";
        throw e;
      }
      throw rdServiceUnreachableError();
    } finally {
      clearTimeout(abortTimer);
    }
    const text = await res.text();
    const { errCode, errInfo } = parseRdServiceError(text);
    if (errCode && errCode !== "0") {
      const err = new Error(errInfo || `Fingerprint capture failed (errCode ${errCode}).`);
      err.code = "RD_ERROR";
      throw err;
    }
    return text; // full <PidData> XML block, forwarded to the server as pidXml
  }

  // Dev/demo only: a well-formed but entirely fake capture, used solely so
  // the biometric flow can be exercised without real MFS110 hardware.
  // Callers must only ever fall back to this when the server has confirmed
  // ABDM_PROVIDER=mock (see GET /api/abha/status) — mock.js's verifyBio()
  // accepts any capture that merely looks like a PID block, so this
  // satisfies it the same way a real scan would, purely for testing. It
  // must never be used against nha/ekacare.
  function buildMockPidXml() {
    return '<PidData><Resp errCode="0" errInfo="Success" fCount="1" fType="2" qScore="70" /><DeviceInfo dpId="MOCK.DEV.001" rdsId="MOCK.RDSERVICE.001" rdsVer="1.0.0" mi="MFS100" mc="MANTRA" /><Data type="X">mock-capture-for-testing</Data></PidData>';
  }

  window.RdService = {
    deviceInfo,
    capture,
    parseCaptureQuality,
    buildMockPidXml,
  };
})();
