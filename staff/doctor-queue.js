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

  // Kept in sync by hand with DISEASE_WATCHLIST in server/server.js.
  const DISEASE_WATCHLIST = [
    "Dengue",
    "Malaria",
    "Chikungunya",
    "Typhoid",
    "Cholera",
    "Influenza / Flu",
    "COVID-19",
    "Measles",
    "Diarrheal Disease",
    "Viral Hepatitis / Jaundice",
    "Tuberculosis",
  ];

  const DECISION_KEYS = { prescribe: "doctor_queue.prescription", order_tests: "doctor_queue.tests_ordered", admit: "doctor_queue.admission_requested" };
  const DECISION_LABELS = { prescribe: "Prescription", order_tests: "Tests Ordered", admit: "Admission Requested" };

  function formatDecisionLabel(decision) {
    return String(decision || "")
      .split(",")
      .map((d) => {
        const key = DECISION_KEYS[d.trim()];
        if (key && window.i18n && typeof window.i18n.t === "function") {
          const res = window.i18n.t(key);
          if (res && res !== key) return res;
        }
        return DECISION_LABELS[d.trim()] || d.trim();
      })
      .filter(Boolean)
      .join(" + ") || (window.i18n ? window.i18n.t("doctor_queue.consultation") : "Consultation");
  }

  const STATUS_MAP = {
    waiting: "opd.status_waiting",
    called: "opd.status_called",
    in_consultation: "opd.status_in_consultation",
    "in-consultation": "opd.status_in_consultation",
    completed: "opd.status_completed",
    cancelled: "opd.status_cancelled",
  };

  function getStatusDisplay(s) {
    const key = STATUS_MAP[s] || `opd.status_${s}`;
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key);
      if (res && res !== key) return res;
    }
    const fallbacks = {
      waiting: "Waiting",
      called: "Called",
      in_consultation: "In Consultation",
      "in-consultation": "In Consultation",
      completed: "Completed",
      cancelled: "Cancelled",
    };
    return fallbacks[s] || s;
  }

  let sessionUser = null;
  let activeVisit = null;
  let selectedTests = [];
  let selectedMeds = [];
  let searchDebounce = null;

  // ---------- Telemedicine video call (inline, alongside the consultation form) ----------
  // Jitsi Meet embed via the shared window.MedisysTelemedicine helper
  // (telemedicine-jitsi.js) — same room the patient joins from their
  // appointments page. See that file for the security note on room tokens.
  let activeCallPromise = null; // openTelemedicineCall() is async — resolves to { close }
  let activeCallVisitId = null;

  function startTelemedicineCall(visitId) {
    const pane = document.getElementById("consultVideoPane");
    if (!pane) return;
    pane.hidden = false;
    activeCallVisitId = visitId;
    activeCallPromise = window.MedisysTelemedicine.openTelemedicineCall({
      visitId,
      containerEl: pane,
      displayName: (sessionUser && (sessionUser.fullName || sessionUser.userId)) || "",
    });
  }

  async function stopTelemedicineCall() {
    const pane = document.getElementById("consultVideoPane");
    if (activeCallPromise) {
      const call = await activeCallPromise;
      if (call) call.close();
    }
    activeCallPromise = null;
    activeCallVisitId = null;
    if (pane) {
      pane.hidden = true;
      pane.innerHTML = "";
    }
  }

  window.addEventListener("beforeunload", stopTelemedicineCall);

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "doctor") {
      window.location.href = "../index";
      return null;
    }
    sessionUser = data.user;
    document.getElementById("portalUser").textContent = data.user.fullName || data.user.userId;
    return data.user;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
  }

  async function loadQueue() {
    const res = await fetch(`/api/opd/queue?doctorUserId=${encodeURIComponent(sessionUser.userId)}`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    const tbody = document.getElementById("queueTableBody");
    const emptyState = document.getElementById("queueEmptyState");

    if (!data.success || data.queue.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const callLabel = window.i18n ? window.i18n.t("doctor_queue.call_patient") : "Call";
    const startConsultingLabel = window.i18n ? window.i18n.t("doctor_queue.start_consulting") : "Start Consulting";
    const consultLabel = window.i18n ? window.i18n.t("doctor_queue.consult") : "Consult";
    const walkInLabel = window.i18n ? window.i18n.t("registration.walk_in") : "Walk-in";

    // Three-stage flow, each stage its own visible status on the live queue
    // board (see opd-queue-board.js): waiting -[Call]-> called
    // -[Start Consulting]-> in-consultation. A reload while already
    // in-consultation (e.g. the doctor navigated away mid-consult) just
    // reopens the form — it never re-PATCHes a status that's already set.
    tbody.innerHTML = data.queue
      .map((v) => {
        const isTele = v.source === "telemedicine";
        let actionBtn = "";
        if (v.status === "waiting") {
          actionBtn = `<button type="button" class="wizard-suggest-btn call-btn" data-id="${v.id}">${escapeHtml(callLabel)}</button>`;
        } else if (v.status === "called") {
          actionBtn = `<button type="button" class="wizard-suggest-btn start-consult-btn" data-id="${v.id}" data-uhid="${escapeHtml(v.patient_uhid)}" data-name="${escapeHtml(v.patient_name || v.patient_uhid)}" data-source="${escapeHtml(v.source)}">${escapeHtml(startConsultingLabel)}</button>`;
        } else if (v.status === "in-consultation") {
          const label = isTele ? `📹 ${consultLabel}` : consultLabel;
          actionBtn = `<button type="button" class="wizard-suggest-btn consult-btn" data-id="${v.id}" data-uhid="${escapeHtml(v.patient_uhid)}" data-name="${escapeHtml(v.patient_name || v.patient_uhid)}" data-source="${escapeHtml(v.source)}">${escapeHtml(label)}</button>`;
        }
        return `<tr>
          <td>#${v.token_number}</td>
          <td>${escapeHtml(v.patient_name || v.patient_uhid)}${isTele ? ` <span class="queue-status waiting" style="margin-left:4px;">${escapeHtml(window.i18n ? window.i18n.t("appointments.telemedicine") : "Telemedicine")}</span>` : ""}</td>
          <td>${escapeHtml(v.slot_time || walkInLabel)}</td>
          <td><span class="queue-status ${escapeHtml(v.status)}">${escapeHtml(getStatusDisplay(v.status))}</span></td>
          <td>${actionBtn}</td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".call-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/opd/visits/${btn.dataset.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ status: "called" }),
        });
        loadQueue();
      });
    });

    tbody.querySelectorAll(".start-consult-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/opd/visits/${btn.dataset.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ status: "in-consultation" }),
        });
        openConsultation(btn.dataset.id, btn.dataset.uhid, btn.dataset.name, btn.dataset.source);
        loadQueue();
      });
    });

    tbody.querySelectorAll(".consult-btn").forEach((btn) => {
      btn.addEventListener("click", () => openConsultation(btn.dataset.id, btn.dataset.uhid, btn.dataset.name, btn.dataset.source));
    });
  }

  function renderSelectedTests() {
    const row = document.getElementById("selectedTestChips");
    row.innerHTML = selectedTests
      .map(
        (t) => `<span class="test-chip">${escapeHtml(t.name)}<button type="button" class="test-chip-remove" data-id="${t.id}">&times;</button></span>`
      )
      .join("");
    row.querySelectorAll(".test-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTests = selectedTests.filter((t) => String(t.id) !== btn.dataset.id);
        renderSelectedTests();
      });
    });
  }

  function renderSelectedMeds() {
    const row = document.getElementById("selectedMedChips");
    row.innerHTML = selectedMeds
      .map(
        (m, i) =>
          `<span class="test-chip">${escapeHtml(m.medicineName)} — ${escapeHtml(m.dosage)}, ${escapeHtml(String(m.duration))}d${
            m.foodInstruction ? ", " + escapeHtml(m.foodInstruction) : ""
          }${m.urgency === "urgent" ? " (Urgent)" : ""}<button type="button" class="test-chip-remove" data-idx="${i}">&times;</button></span>`
      )
      .join("");
    row.querySelectorAll(".test-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedMeds.splice(Number(btn.dataset.idx), 1);
        renderSelectedMeds();
      });
    });
  }

  // Each mic button is scoped to one field — dictating into Symptoms only
  // fills Symptoms, dictating into Medicine only fills the medicine row,
  // and so on. The one thing that applies across all of them is the
  // admission flag: if the doctor says "admit" while dictating anything,
  // tick the admission checkbox regardless of which mic picked it up.
  function applyAdmitSuggestion(data) {
    if (data.admitSuggested) document.getElementById("admitCheckbox").checked = true;
  }

  function wireVoiceMics() {
    if (!window.MedisysVoice) return;

    const languageSelect = document.getElementById("voiceLanguage");
    MedisysVoice.renderLanguageOptions(languageSelect);
    const getLanguage = () => languageSelect.value;
    const setStatus = (text) => {
      document.getElementById("voiceStatus").textContent = text;
    };
    const showError = (message) => {
      document.getElementById("consultError").textContent = message;
    };

    // One combined "Symptoms & Notes" field/mic — a doctor dictating what's
    // happening with a patient naturally covers both in one breath, so a
    // separate Notes box + second mic button was just friction. Used to be
    // two fields (symptoms/notes) each with their own mic; consolidated
    // 2026-08-24. The backend still has two columns (symptoms, notes) for
    // older records, so on submit this single field's value is sent as
    // `symptoms` and `notes` is left empty — see the submit payload below.
    MedisysVoice.attachMic(document.getElementById("micSymptoms"), {
      getLanguage,
      onStatus: setStatus,
      onError: showError,
      onResult: (data) => {
        const el = document.getElementById("symptoms");
        const text = data.transcriptEnglish || data.notes || "";
        el.value = el.value.trim() ? `${el.value}\n${text}` : text;
        applyAdmitSuggestion(data);
      },
    });

    MedisysVoice.attachMic(document.getElementById("micMedicine"), {
      getLanguage,
      onStatus: setStatus,
      onError: showError,
      onResult: (data) => {
        const med = (data.medicines || [])[0];
        document.getElementById("medName").value = (med && med.name) || data.transcriptEnglish || data.notes || "";
        if (med && med.dosage) document.getElementById("medDosage").value = med.dosage;
        if (med && med.duration) document.getElementById("medDuration").value = med.duration;
        if (med && med.foodInstruction) document.getElementById("medFoodInstruction").value = med.foodInstruction;
        // If the dictation gave us everything required (name, dosage,
        // duration), add it to the prescription list immediately — same
        // logic the "+ Add" button uses — instead of leaving it sitting in
        // the form waiting for a manual click. If anything's missing (e.g.
        // dosage phrasing the parser didn't recognize), it's left filled-in
        // for the doctor to complete and add themselves.
        if (addCurrentMedicineToList({ silent: true })) {
          setStatus(`Added ${med.name} to the prescription.`);
        } else {
          setStatus("Got the medicine — fill in whatever's missing and click + Add.");
        }
        applyAdmitSuggestion(data);
      },
    });

    MedisysVoice.attachMic(document.getElementById("micTests"), {
      getLanguage,
      onStatus: setStatus,
      onError: showError,
      onResult: async (data) => {
        // A single dictation can name several tests ("CBC, dengue test") —
        // add every one that matches the catalog, not just the first.
        const queries = data.testsSuggested && data.testsSuggested.length ? data.testsSuggested : [data.transcriptEnglish || data.notes || ""];
        const added = [];
        const notFound = [];
        for (const query of queries) {
          if (!query.trim()) continue;
          const matches = (await searchTestCatalog(query)).filter(
            (t) => !selectedTests.some((s) => String(s.id) === String(t.id))
          );
          const match = matches.find((t) => t.name.toLowerCase() === query.toLowerCase()) || matches[0];
          if (match) {
            selectTest(match.id, match.name);
            added.push(match.name);
          } else {
            notFound.push(query);
          }
        }

        if (added.length && !notFound.length) {
          setStatus(`Ticked ${added.join(", ")} from the test catalog.`);
        } else if (added.length && notFound.length) {
          setStatus(`Ticked ${added.join(", ")}. No catalog match for ${notFound.join(", ")} — pick from the results below.`);
          document.getElementById("testSearchInput").value = notFound[0];
          runTestSearch(notFound[0]);
        } else if (notFound.length) {
          // Nothing matched at all — leave the first one in the search box
          // for manual review instead of silently dropping the dictation.
          document.getElementById("testSearchInput").value = notFound[0];
          runTestSearch(notFound[0]);
          setStatus(`No catalog match for "${notFound[0]}" — pick from the results below.`);
        }
        applyAdmitSuggestion(data);
      },
    });
  }

  // Shared by the "+ Add" button and the medicine dictation mic, so a fully
  // specified voice-dictated medicine is added the same way a manually
  // typed one is — no separate code path to drift out of sync.
  function addCurrentMedicineToList({ silent = false } = {}) {
    const errorEl = document.getElementById("consultError");
    if (!silent) errorEl.textContent = "";
    const medicineName = document.getElementById("medName").value.trim();
    const dosage = document.getElementById("medDosage").value;
    const duration = document.getElementById("medDuration").value;
    const foodInstruction = document.getElementById("medFoodInstruction").value;
    const urgency = document.getElementById("medUrgency").value;
    if (!medicineName || !dosage || !duration) {
      if (!silent) {
        errorEl.textContent = window.i18n
          ? window.i18n.t("doctor_queue.fill_medicine_details")
          : "Fill in medicine name, dosage, and duration before adding it.";
      }
      return false;
    }
    selectedMeds.push({ medicineName, dosage, duration, foodInstruction, urgency });
    renderSelectedMeds();
    document.getElementById("medName").value = "";
    document.getElementById("medDosage").value = "";
    document.getElementById("medDuration").value = "";
    document.getElementById("medFoodInstruction").value = "";
    document.getElementById("medUrgency").value = "routine";
    return true;
  }

  function wireAddMedButton() {
    document.getElementById("addMedBtn").addEventListener("click", () => addCurrentMedicineToList());
  }

  // Shared by clicking a search result and by the test-order dictation mic.
  function selectTest(id, name) {
    if (selectedTests.some((t) => String(t.id) === String(id))) return;
    selectedTests.push({ id, name });
    renderSelectedTests();
    document.getElementById("testSearchInput").value = "";
    document.getElementById("testSearchResults").innerHTML = "";
  }

  async function searchTestCatalog(query) {
    if (!query.trim()) return [];
    const res = await fetch(`/api/tests/search?q=${encodeURIComponent(query)}`, { credentials: "same-origin" });
    const data = await res.json();
    return data.success ? data.tests : [];
  }

  async function runTestSearch(query) {
    const resultsEl = document.getElementById("testSearchResults");
    const tests = (await searchTestCatalog(query)).filter(
      (t) => !selectedTests.some((s) => String(s.id) === String(t.id))
    );
    if (!query.trim()) {
      resultsEl.innerHTML = "";
      return;
    }

    resultsEl.innerHTML = tests
      .map(
        (t) => `<div class="test-search-result-item" data-id="${t.id}" data-name="${escapeHtml(t.name)}">
          <span class="test-search-result-name">${escapeHtml(t.name)}</span>
          <span class="test-search-result-meta">${escapeHtml(t.category)} &middot; ₹${t.price}</span>
        </div>`
      )
      .join("");

    resultsEl.querySelectorAll(".test-search-result-item").forEach((item) => {
      item.addEventListener("click", () => selectTest(item.dataset.id, item.dataset.name));
    });
  }

  function wireTestOrderWidget() {
    document.getElementById("testSearchInput").addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      const query = e.target.value;
      searchDebounce = setTimeout(() => runTestSearch(query), 200);
    });
  }

  async function openConsultation(visitId, patientUhid, patientName, source) {
    if (activeCallVisitId && activeCallVisitId !== visitId) stopTelemedicineCall();
    activeVisit = { id: visitId, patientUhid, patientName, source };
    const titlePrefix = window.i18n ? window.i18n.t("doctor_queue.consultation") : "Consultation";
    document.getElementById("consultTitle").textContent = `${titlePrefix} — ${patientName}`;
    document.getElementById("consultSection").hidden = false;
    if (source === "telemedicine") {
      startTelemedicineCall(visitId);
    } else {
      document.getElementById("consultVideoPane").hidden = true;
    }
    document.getElementById("consultConfirmation").textContent = "";
    document.getElementById("consultError").textContent = "";
    document.getElementById("symptoms").value = "";
    document.getElementById("diagnosisSelect").value = "";
    document.getElementById("diagnosisOtherInput").value = "";
    document.getElementById("diagnosisOtherInput").hidden = true;
    document.getElementById("medName").value = "";
    document.getElementById("medDosage").value = "";
    document.getElementById("medDuration").value = "";
    document.getElementById("medFoodInstruction").value = "";
    document.getElementById("medUrgency").value = "routine";
    document.getElementById("testSearchInput").value = "";
    document.getElementById("testSearchResults").innerHTML = "";
    document.getElementById("admitCheckbox").checked = false;
    selectedTests = [];
    selectedMeds = [];
    renderSelectedTests();
    renderSelectedMeds();

    const res = await fetch(`/api/patients/${encodeURIComponent(patientUhid)}/history`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    const feed = document.getElementById("historyFeed");
    if (!data.success) {
      feed.innerHTML = "";
      return;
    }

    const consultationItems = data.history.consultations
      .map(
        (c) => `<div class="chart-feed-item">
          <strong>${escapeHtml(formatDecisionLabel(c.decision))}</strong> — ${escapeHtml(c.symptoms || "—")}
          <div class="chart-feed-meta">Dr. ${escapeHtml(c.doctor_name || "—")} &middot; ${escapeHtml(new Date(c.created_at).toLocaleString())}</div>
        </div>`
      )
      .join("");
    const admissionItems = data.history.admissions
      .map(
        (a) => `<div class="chart-feed-item">
          Admission (${escapeHtml(a.status)})
          <div class="chart-feed-meta">${escapeHtml(new Date(a.created_at).toLocaleString())}</div>
        </div>`
      )
      .join("");
    const labOrderItems = (data.history.labOrders || [])
      .map((o) => {
        const DONE_STATUSES = ["completed", "verified"];
        const isDone = DONE_STATUSES.includes(o.status);
        const statusLabel =
          { pending: "Ordered", in_progress: "In Progress", reported: "Reporting", completed: "Completed", verified: "Completed" }[
            o.status
          ] || o.status;
        const imageLinks = (o.images || [])
          .map(
            (img) =>
              ` &middot; <a href="/api/lab-orders/${o.id}/images/${img.id}" target="_blank" rel="noopener" class="file-view-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>${escapeHtml(img.fileName)}</a>`
          )
          .join("");
        const resultLine = isDone
          ? `<div class="chart-feed-meta">${escapeHtml(o.result_notes || "No notes")}${
              o.result_file_name
                ? ` &middot; <a href="/api/lab-orders/${o.id}/result-file" target="_blank" rel="noopener" class="file-view-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>${escapeHtml(o.result_file_name)}</a>`
                : ""
            }${imageLinks}</div>`
          : "";
        return `<div class="chart-feed-item">
          <strong>${escapeHtml(o.test_name)}</strong> — <span class="queue-status ${isDone ? "completed" : "waiting"}">${escapeHtml(statusLabel)}</span>
          ${resultLine}
          <div class="chart-feed-meta">Ordered ${escapeHtml(new Date(o.created_at).toLocaleString())}</div>
        </div>`;
      })
      .join("");

    const noHistoryMsg = window.i18n ? window.i18n.t("doctor_queue.no_prior_history") : "No prior history.";
    feed.innerHTML =
      labOrderItems + consultationItems + admissionItems || `<p class="wizard-hint">${escapeHtml(noHistoryMsg)}</p>`;
  }

  function buildConsultationPdfHtml() {
    const patientName = (activeVisit && activeVisit.patientName) || "—";
    const patientUhid = (activeVisit && activeVisit.patientUhid) || "—";
    const doctorName = (sessionUser && sessionUser.fullName) || (sessionUser && sessionUser.userId) || "—";
    const symptoms = document.getElementById("symptoms").value.trim() || "—";
    const admit = document.getElementById("admitCheckbox").checked;
    const now = new Date();

    const medRows = selectedMeds.length
      ? selectedMeds
          .map(
            (m) => `<tr>
              <td>${escapeHtml(m.medicineName)}</td>
              <td>${escapeHtml(m.dosage || "—")}</td>
              <td>${escapeHtml(String(m.duration || "—"))} day(s)</td>
              <td>${escapeHtml(m.foodInstruction || "—")}</td>
              <td>${m.urgency === "urgent" ? "Urgent" : "Routine"}</td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="5">No medicines prescribed.</td></tr>`;

    const testRows = selectedTests.length
      ? selectedTests.map((t) => `<li>${escapeHtml(t.name)}</li>`).join("")
      : "<li>No tests ordered.</li>";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Consultation — ${escapeHtml(patientName)}</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #142621; margin: 40px; line-height: 1.5; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #46605a; font-size: 13px; margin-bottom: 24px; }
  .meta span { display: inline-block; margin-right: 18px; }
  h2 { font-size: 15px; border-bottom: 1px solid #d6e0dd; padding-bottom: 4px; margin-top: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eef2f2; }
  th { color: #46605a; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  p.field { white-space: pre-wrap; font-size: 13.5px; margin: 6px 0 0; }
  .admit-flag { font-weight: 600; color: ${admit ? "#0f6e5e" : "#46605a"}; }
  footer { margin-top: 32px; font-size: 11px; color: #7c918c; }
  @media print { body { margin: 20px; } }
</style>
</head>
<body>
  <h1>MEDISYS — Consultation Record</h1>
  <div class="meta">
    <span><strong>Patient:</strong> ${escapeHtml(patientName)} (${escapeHtml(patientUhid)})</span>
    <span><strong>Doctor:</strong> Dr. ${escapeHtml(doctorName)}</span>
    <span><strong>Date:</strong> ${escapeHtml(now.toLocaleString())}</span>
  </div>

  <h2>Symptoms &amp; Notes</h2>
  <p class="field">${escapeHtml(symptoms)}</p>

  <h2>Prescribed Medicines</h2>
  <table>
    <thead><tr><th>Medicine</th><th>Dosage</th><th>Duration</th><th>Instruction</th><th>Priority</th></tr></thead>
    <tbody>${medRows}</tbody>
  </table>

  <h2>Tests / X-Rays Ordered</h2>
  <ul>${testRows}</ul>

  <h2>Admission</h2>
  <p class="admit-flag">${admit ? "🛏️ Admission requested." : "Not required."}</p>

  <footer>Generated from MEDISYS on ${escapeHtml(now.toLocaleString())}. Review all AI-dictated fields for accuracy before treating this as final.</footer>
</body>
</html>`;
  }

  function wirePdfDownload() {
    document.getElementById("downloadConsultPdfBtn").addEventListener("click", () => {
      const errorEl = document.getElementById("consultError");
      if (!activeVisit) {
        errorEl.textContent = t('doctor_queue.open_consult_before_download', 'Open a consultation before downloading its document.');
        return;
      }
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        errorEl.textContent = t('doctor_queue.popup_blocked', "Could not open the print window — check your browser's popup blocker.");
        return;
      }
      printWindow.document.write(buildConsultationPdfHtml());
      printWindow.document.close();
      printWindow.focus();
      // Let the new document finish laying out before the print dialog opens.
      printWindow.onload = () => printWindow.print();
    });
  }

  function wireConsultForm() {
    document.getElementById("completeConsultBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("consultError");
      errorEl.textContent = "";

      if (!activeVisit) return;

      const admit = document.getElementById("admitCheckbox").checked;
      if (selectedMeds.length === 0 && selectedTests.length === 0 && !admit) {
        errorEl.textContent = window.i18n
          ? window.i18n.t("doctor_queue.add_one_action")
          : "Add at least one action: prescribe a medicine, order a test, or admit the patient.";
        return;
      }

      if (document.getElementById("diagnosisSelect").value === "Other" && !document.getElementById("diagnosisOtherInput").value.trim()) {
        errorEl.textContent = window.i18n
          ? window.i18n.t("doctor_queue.diagnosis_other_required")
          : "Type the disease name, or pick a different diagnosis option.";
        return;
      }

      const btn = document.getElementById("completeConsultBtn");
      btn.disabled = true;
      try {
        const res = await fetch(`/api/opd/visits/${activeVisit.id}/consultation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            // The old separate "Notes" field is gone — one dictation/typed
            // field covers both now. `notes` isn't sent at all; the backend
            // already stores null when it's absent (see POST
            // /api/opd/visits/:id/consultation), so nothing downstream that
            // reads consultation.notes on older records breaks.
            symptoms: document.getElementById("symptoms").value.trim(),
            diagnosis: resolveDiagnosisValue(),
            prescriptions: selectedMeds,
            testIds: selectedTests.map((t) => t.id),
            admit,
          }),
        });
        const data = await res.json();

        if (!data.success) {
          errorEl.textContent = data.message || t('doctor_queue.could_not_record_consultation', 'Could not record consultation.');
          return;
        }

        const parts = [];
        if (data.prescriptionCount > 0) parts.push(t('doctor_queue.medicines_sent_pharmacy', '{count} medicine(s) sent to Pharmacy', { count: data.prescriptionCount }));
        if (data.testCount > 0) parts.push(t('doctor_queue.tests_ordered_count', '{count} test(s) ordered', { count: data.testCount }));
        if (data.admissionId && data.admissionAlreadyExisted) {
          parts.push(t('doctor_queue.admission_already_active', 'admission already active (#{id})', { id: data.admissionId }));
        } else if (data.admissionId) {
          parts.push(t('doctor_queue.admission_requested_id', 'admission #{id} requested', { id: data.admissionId }));
        }
        const summary = parts.length ? parts.join(" · ") : t('doctor_queue.consultation_recorded', 'Consultation recorded.');
        document.getElementById("consultConfirmation").textContent = t('doctor_queue.consultation_recorded_summary', 'Consultation recorded — {summary}.', { summary });
        if (window.showToast) showToast(t('doctor_queue.consultation_saved_toast', 'Consultation saved: {summary}.', { summary }), "success");

        if (data.outbreakAlert && window.showToast) {
          showToast(
            t('doctor_queue.outbreak_alert_toast', '⚠ Outbreak alert raised for {diagnosis} ({caseCount} recent cases) — hospital admin notified.', { diagnosis: data.outbreakAlert.diagnosis, caseCount: data.outbreakAlert.caseCount }),
            "error"
          );
        }

        activeVisit = null;
        loadQueue();

        // Hide the form after 2.5 seconds so they can read the confirmation
        setTimeout(() => {
          document.getElementById("consultSection").hidden = true;
          stopTelemedicineCall();
        }, 2500);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function populateDiagnosisSelect() {
    const select = document.getElementById("diagnosisSelect");
    if (!select) return;
    DISEASE_WATCHLIST.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      select.appendChild(opt);
    });
    const otherOpt = document.createElement("option");
    otherOpt.value = "Other";
    otherOpt.textContent = window.i18n ? window.i18n.t("doctor_queue.diagnosis_other") : "Other";
    select.appendChild(otherOpt);

    const otherInput = document.getElementById("diagnosisOtherInput");
    select.addEventListener("change", () => {
      otherInput.hidden = select.value !== "Other";
      if (select.value !== "Other") otherInput.value = "";
    });
  }

  // The value actually sent to the backend: the watchlist selection as-is, or
  // the doctor's typed text when "Other" is picked — this is also what feeds
  // outbreak monitoring, so a handful of doctors independently typing the same
  // (case-insensitive) custom disease name will still trigger an alert exactly
  // like a watchlist disease would. See checkDiseaseOutbreak in server.js.
  function resolveDiagnosisValue() {
    const select = document.getElementById("diagnosisSelect");
    if (select.value === "Other") {
      return document.getElementById("diagnosisOtherInput").value.trim();
    }
    return select.value;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    populateDiagnosisSelect();
    wireConsultForm();
    wireTestOrderWidget();
    wireAddMedButton();
    wireVoiceMics();
    wirePdfDownload();
    loadQueue();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("opd_queue", loadQueue);
    }

    window.addEventListener("i18n:languageChanged", () => {
      loadQueue();
    });
  });
})();
