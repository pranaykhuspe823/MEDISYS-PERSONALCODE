/*
 * MEDISYS hands-free Patient Recall widget — Phase 1.
 *
 * Press-and-hold the button to record — say something natural like "Give me
 * Ramesh Kumar's details", or add a complaint ("Ramesh Kumar, chest pain")
 * — then release to send. See parseNameAndComplaint() in
 * server/voiceQuery.js for every phrasing this understands.
 * The clip is POSTed to POST /api/voice/query (server/voiceQuery.js), which
 * runs it through the free local Whisper STT service (voice-recall-stt/ —
 * no API key, no per-request cost; or a mock transcript in dev if that
 * service isn't running — see server/.env's VOICE_QUERY_MOCK_TRANSCRIPT),
 * matches the patient (today's queue first, then full search), and returns
 * a prioritized briefing. This widget speaks that briefing's spokenSummary
 * back via the Web Speech API and renders the same data visually, for
 * sighted confirmation while testing.
 *
 * Bluetooth earbuds: recording explicitly targets the earbud's mic
 * (deviceId, not the OS default — see resolvePreferredInputDeviceId()
 * below), and that mic stream is deliberately kept open through the
 * spoken reply (see the comment in stopAndSend()) so the earbud's
 * bidirectional hands-free link doesn't drop before speak() plays —
 * without that, TTS can fall back to the laptop speaker. A hardware-gesture
 * trigger (as opposed to press-and-hold on this page) still needs a native
 * shell around this same POST /api/voice/query flow — that part isn't
 * built here. Phase 3 (ambiguous-match voice confirmation loop) is
 * intentionally NOT implemented here yet — an ambiguous response is spoken
 * and listed, with no way to resolve it from this screen yet.
 */
(function () {
  const MIC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

  const INPUT_DEVICE_KEY = "medisysVoiceRecallInputDeviceId";

  // Windows/Chrome label Bluetooth mics this way (e.g. "Headset (Pixel Buds
  // Hands-Free AG Audio)"); a plain "Bluetooth" also shows up on some OSes.
  function isLikelyEarbudLabel(label) {
    return /bluetooth|airpods|earbud|buds|headset|hands-free|hfp/i.test(label || "");
  }

  // getUserMedia({ audio: true }) leaves the OS to pick the default input,
  // which is often still the laptop's built-in mic even with earbuds
  // connected (especially before anything has put the Bluetooth link into
  // its bidirectional hands-free profile). Explicitly targeting the earbud's
  // deviceId is the only reliable way to guarantee the recording actually
  // comes from it. Device labels are only populated once mic permission has
  // been granted at least once on this page (e.g. by this widget itself, or
  // by the dictation mic in language/voice-widget.js) — until then this
  // falls back to null and the caller uses the OS default for that one call.
  async function resolvePreferredInputDeviceId() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
      const saved = localStorage.getItem(INPUT_DEVICE_KEY);
      if (saved && inputs.some((d) => d.deviceId === saved)) return saved;
      const earbud = inputs.find((d) => isLikelyEarbudLabel(d.label));
      return earbud ? earbud.deviceId : null;
    } catch {
      return null;
    }
  }

  // Called after a successful getUserMedia grant, when we didn't already
  // have an explicit device choice — labels are populated now, so remember
  // the earbud (if any) for the next press.
  async function rememberEarbudIfFound() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const earbud = devices.find((d) => d.kind === "audioinput" && isLikelyEarbudLabel(d.label));
      if (earbud) localStorage.setItem(INPUT_DEVICE_KEY, earbud.deviceId);
    } catch {
      // best-effort only
    }
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

  // Cancels anything still queued/speaking before starting the new
  // briefing — a doctor moving fast between patients shouldn't hear two
  // briefings overlap or queue up behind each other. `onDone` fires once
  // speech finishes (or immediately if there's nothing to speak) so the
  // caller can release the mic stream only after the reply has played —
  // see the "Deliberately keep the mic open" comment in mount() below.
  function speak(text, onDone) {
    if (!window.speechSynthesis || !text) {
      if (onDone) onDone();
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.0;
    if (onDone) {
      utter.onend = onDone;
      utter.onerror = onDone;
    }
    window.speechSynthesis.speak(utter);
  }

  function formatDate(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function renderResult(resultEl, data) {
    resultEl.hidden = false;

    if (data.status === "not_found" || data.status === "error") {
      resultEl.innerHTML = `<p class="voice-recall-empty">${escapeHtml(data.spokenSummary)}</p>`;
      return;
    }

    if (data.status === "ambiguous") {
      const rows = data.matches
        .map((m) => {
          const dobPart = m.dob ? `, born ${escapeHtml(String(new Date(m.dob).getFullYear()))}` : "";
          return `<li>${escapeHtml(m.fullName)}${dobPart} <span class="voice-recall-uhid">${escapeHtml(m.uhid)}</span></li>`;
        })
        .join("");
      resultEl.innerHTML = `
        <p class="voice-recall-ambiguous-note">${escapeHtml(data.spokenSummary)}</p>
        <ul class="voice-recall-match-list">${rows}</ul>
        <p class="voice-recall-hint">${t("voice_recall.disambiguate_hint", "Multiple matches — voice confirmation isn't built yet, so pick the right patient from the queue or search manually.")}</p>
      `;
      return;
    }

    // status === "resolved"
    const p = data.patient;
    const allergyHtml = p.allergies
      ? `<div class="voice-recall-alert voice-recall-allergy">⚠ ${escapeHtml(p.allergies)}</div>`
      : `<div class="voice-recall-note">${t("voice_recall.no_allergies", "No known allergies on file.")}</div>`;

    const criticalHtml = data.criticalLabs.length
      ? `<div class="voice-recall-alert voice-recall-critical">🔺 ${data.criticalLabs
          .map((l) => escapeHtml(`${l.test_name || "Lab result"}${l.critical_value_note ? " — " + l.critical_value_note : ""}`))
          .join("; ")}</div>`
      : "";

    const medsHtml = data.medications.length
      ? `<ul class="voice-recall-list">${data.medications
          .map((m) => `<li>${escapeHtml(m.medicine_name)}${m.dosage ? ` — ${escapeHtml(m.dosage)}` : ""}</li>`)
          .join("")}</ul>`
      : `<p class="voice-recall-note">${t("voice_recall.no_medications", "No medications on record in the last 90 days.")}</p>`;

    const visitsHtml = data.recentVisits.length
      ? `<ul class="voice-recall-list">${data.recentVisits
          .map((v) => `<li>${escapeHtml(formatDate(v.created_at))} — ${escapeHtml(v.diagnosis || v.symptoms || "Consultation")}</li>`)
          .join("")}</ul>`
      : `<p class="voice-recall-note">${t("voice_recall.no_visits", "No prior visits on record.")}</p>`;

    resultEl.innerHTML = `
      <div class="voice-recall-patient-header">
        <strong>${escapeHtml(p.full_name)}</strong>
        <span class="voice-recall-uhid">${escapeHtml(p.uhid)}</span>
        <span class="voice-recall-source">${escapeHtml(data.matchSource === "todays_queue" ? t("voice_recall.matched_today", "Matched from today's queue") : t("voice_recall.matched_search", "Matched from patient search"))}</span>
      </div>
      ${allergyHtml}
      ${criticalHtml}
      <h4>${t("voice_recall.medications", "Current Medications")}</h4>
      ${medsHtml}
      <h4>${t("voice_recall.recent_visits", "Recent Visits")}</h4>
      ${visitsHtml}
    `;
  }

  /**
   * Wires a press-and-hold mic button + result panel already present in the
   * page's HTML. `panelEl` must contain a `.voice-recall-btn` and a
   * `.voice-recall-status`; `resultEl` is where the briefing renders.
   */
  function mount(panelEl, resultEl, { onError } = {}) {
    const button = panelEl.querySelector(".voice-recall-btn");
    const status = panelEl.querySelector(".voice-recall-status");
    button.innerHTML = MIC_ICON;

    let recorder = null;
    let chunks = [];
    let stream = null;
    let pressActive = false;

    let usedExplicitDevice = false;

    function releaseMic() {
      if (stream) {
        stream.getTracks().forEach((tr) => tr.stop());
        stream = null;
      }
    }

    async function startRecording() {
      // A previous turn's mic (kept open through its spoken reply — see
      // stopAndSend()/submit() below) may still be live if the doctor
      // presses again quickly; release it before grabbing a new one.
      releaseMic();
      if (window.speechSynthesis) window.speechSynthesis.cancel();

      const deviceId = await resolvePreferredInputDeviceId();
      usedExplicitDevice = !!deviceId;
      const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (!deviceId) throw err;
        // Saved/preferred earbud is no longer available (unplugged, out of
        // range) — fall back to whatever the OS considers default.
        usedExplicitDevice = false;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      if (!usedExplicitDevice) rememberEarbudIfFound();

      chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.start();
      button.classList.add("voice-mic-recording");
      status.textContent = t("voice_recall.listening", "Listening… release to send");
    }

    function stopAndSend() {
      if (!recorder || recorder.state === "inactive") return;
      // Deliberately NOT releasing the mic here. A Bluetooth earbud only
      // stays in its bidirectional hands-free profile while something holds
      // its mic stream open; releasing it the instant recording stops (the
      // old behavior) let the OS drop the earbud back to output-only or
      // revert the default output to the laptop speaker before the spoken
      // reply played moments later. The stream is stopped in submit(),
      // once speak() reports the reply has finished.
      recorder.onstop = () => {
        submit(new Blob(chunks, { type: "audio/webm" }));
      };
      recorder.stop();
      button.classList.remove("voice-mic-recording");
    }

    async function submit(blob) {
      status.textContent = t("voice_recall.looking_up", "Looking up patient…");
      button.disabled = true;
      try {
        const body = new FormData();
        body.append("language", "en");
        body.append("audio", blob, "recall-query.webm");
        const res = await fetch("/api/voice/query", { method: "POST", credentials: "same-origin", body });
        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.message || t("voice_recall.lookup_failed", "Lookup failed."));
        }
        status.textContent = "";
        renderResult(resultEl, data);
        speak(data.spokenSummary || "", releaseMic);
      } catch (err) {
        status.textContent = "";
        const message = err.message || t("voice_recall.lookup_failed", "Lookup failed.");
        if (onError) onError(message);
        speak(t("voice_recall.error_spoken", "Sorry, something went wrong with the lookup."), releaseMic);
      } finally {
        button.disabled = false;
      }
    }

    // Press-and-hold across mouse + touch. Deliberately NOT bound to the
    // button's own "mouseleave" — a real bug caught in testing: the
    // button's :active press styling (see admin.css) shrinks it slightly,
    // which can move its edge out from under a cursor that never actually
    // moved, firing a spurious mouseleave within a couple of animation
    // frames (~60ms) and cutting every recording short before any speech
    // was captured, no matter how long the button was actually held.
    // window's "mouseup" alone is the reliable release signal here — it
    // fires wherever the mouse currently is, on the button or not, so
    // dragging off the button mid-press still works correctly without that
    // extra listener.
    const start = (e) => {
      e.preventDefault();
      if (pressActive || button.disabled) return;
      pressActive = true;
      startRecording().catch((err) => {
        pressActive = false;
        status.textContent = "";
        if (onError) onError(err.message || t("voice_recall.mic_denied", "Microphone access denied."));
      });
    };
    const stop = () => {
      if (!pressActive) return;
      pressActive = false;
      stopAndSend();
    };

    button.addEventListener("mousedown", start);
    button.addEventListener("touchstart", start, { passive: false });
    window.addEventListener("mouseup", stop);
    button.addEventListener("touchend", stop);
    button.addEventListener("touchcancel", stop);
  }

  window.MedisysVoiceRecall = { mount };
})();
