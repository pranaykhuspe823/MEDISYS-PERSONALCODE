(function () {
  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
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

  let sessionUser = null;
  let currentBatch = null; // { batchId, targetEntity, fields, knownFields }
  let currentAutoBatch = null; // { batchId, totalRows, roleColumn, roleBreakdown, buckets: [...] }

  // Folder-upload queue — files waiting to be analyzed after the current one
  // finishes. Each file still goes through the full review step (mapping
  // table, or the auto-detect bucket review) before it commits; the queue
  // only automates "pick the next file," not "skip reviewing it." See
  // advanceFolderQueue(), called from both commit-success paths below.
  let folderQueue = [];
  let folderQueueTotal = 0;
  let folderQueueDone = 0;

  // Every entity an auto-detected row can be sorted into — used to label the
  // Import History table and to populate the "Import these as" picker for a
  // row the classifier wasn't confident about. Mirrors server/roles.js.
  const ENTITY_OPTIONS = [
    { value: "patients", label: "Patient records" },
    { value: "doctor", label: "Doctor" },
    { value: "nurse", label: "Nurse" },
    { value: "pharmacist", label: "Pharmacist" },
    { value: "pathology_staff", label: "Pathologist / Lab Staff" },
    { value: "receptionist", label: "OPD / Receptionist" },
    { value: "billing_staff", label: "Billing Staff" },
    { value: "blood_bank_staff", label: "Blood Bank Staff" },
    // Everything below is only ever assigned via the entity picker at upload
    // time or manual reclassification — the mixed-dataset ("auto") role
    // classifier never sorts a row into one of these on its own, since none
    // of them are people. Kept here purely for readable labels in Import
    // History and the "Import these as" picker instead of falling back to
    // the raw entity key (see entityLabelFor below).
    { value: "departments", label: "Departments" },
    { value: "wards", label: "Wards" },
    { value: "beds", label: "Beds" },
    { value: "test_catalog", label: "Test Catalog" },
    { value: "billing_tariff", label: "Billing Tariff" },
    { value: "doctor_schedules", label: "Doctor Schedules" },
    { value: "pharmacy_stock", label: "Pharmacy Stock" },
    { value: "blood_donors", label: "Blood Donors" },
    { value: "opd_visits", label: "OPD Visits" },
    { value: "consultations", label: "Consultations" },
    { value: "ipd_admissions", label: "IPD Admissions" },
    { value: "ipd_notes", label: "IPD Notes" },
    { value: "doctor_orders", label: "Doctor Orders" },
    { value: "medication_administration", label: "Medication Administration" },
    { value: "lab_orders", label: "Lab Orders" },
    { value: "lab_order_images", label: "Lab Order Images" },
    { value: "vitals", label: "Vitals" },
    { value: "pharmacy_orders", label: "Prescriptions / Pharmacy Orders" },
    { value: "blood_inventory_units", label: "Blood Inventory Units" },
    { value: "blood_patient_donations", label: "Blood Patient Donations" },
    { value: "blood_requests", label: "Blood Requests" },
    { value: "bills", label: "Bills" },
    { value: "bill_items", label: "Bill Items" },
    { value: "bill_payments", label: "Bill Payments" },
    { value: "patient_charges", label: "Patient Charges" },
    { value: "blood_billing", label: "Blood Billing" },
  ];

  function entityLabelFor(entity) {
    if (entity === "auto") return t("data_import.entity_auto_short", "Mixed dataset");
    if (entity === "multi") return t("data_import.entity_multi_short", "Multi-table dataset");
    if (entity === "unclassified") return t("data_import.unclassified_title", "Unclassified");
    const found = ENTITY_OPTIONS.find((e) => e.value === entity);
    return found ? found.label : entity;
  }

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "hospital_admin") {
      window.location.href = "../index.html";
      return null;
    }
    sessionUser = data.user;
    document.getElementById("portalUser").textContent = data.user.fullName || data.user.userId;
    return data.user;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index.html";
    });
  }

  // ---------- Step 1: upload ----------

  // Shared by the manual "Analyze File" button and the folder-queue
  // auto-advance — one file in, same upload+analyze call, same result
  // handling either way, so a queued file behaves identically to one chosen
  // by hand.
  async function analyzeFile(file, { entity, sourceName }) {
    const errorEl = document.getElementById("uploadError");
    errorEl.textContent = "";

    const formData = new FormData();
    formData.append("file", file);
    formData.append("entity", entity);
    if (sourceName) formData.append("sourceName", sourceName);

    const btn = document.getElementById("uploadBtn");
    const progressWrap = document.getElementById("analyzeProgress");
    btn.disabled = true;
    progressWrap.hidden = false;
    try {
      const res = await fetch("/api/import/upload", { method: "POST", credentials: "same-origin", body: formData });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t("data_import.upload_failed", "Could not analyze this file.");
        // A file that fails to even analyze (e.g. unreadable/empty) shouldn't
        // stall the rest of a folder queue — skip it and move on.
        advanceFolderQueue();
        return;
      }
      if (data.targetEntity === "auto" || data.targetEntity === "multi") {
        renderAutoSummary(data);
      } else {
        currentBatch = data;
        renderMappingTable(data);
      }
    } catch (err) {
      errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      advanceFolderQueue();
    } finally {
      btn.disabled = false;
      progressWrap.hidden = true;
    }
  }

  function wireUpload() {
    document.getElementById("uploadBtn").addEventListener("click", () => {
      const fileInput = document.getElementById("importFileInput");
      const file = fileInput.files[0];
      if (!file) {
        document.getElementById("uploadError").textContent = t("data_import.choose_file_first", "Choose a file first.");
        return;
      }
      const entity = document.getElementById("importEntitySelect").value;
      const sourceName = document.getElementById("importSourceName").value.trim();
      analyzeFile(file, { entity, sourceName });
    });
  }

  // ---------- Folder upload: queue every CSV/XLSX found, one file at a time ----------

  const IMPORTABLE_EXTENSIONS = [".csv", ".xlsx", ".xls"];

  function updateFolderQueueStatus(text) {
    const el = document.getElementById("folderQueueStatus");
    if (el) el.textContent = text;
  }

  function wireFolderUpload() {
    document.getElementById("importFolderInput").addEventListener("change", (e) => {
      const allFiles = Array.from(e.target.files || []);
      const importable = allFiles.filter((f) => IMPORTABLE_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)));
      if (importable.length === 0) {
        updateFolderQueueStatus(
          allFiles.length > 0
            ? t("data_import.folder_no_importable", "That folder has {count} file(s), but none are .csv/.xlsx/.xls.", { count: allFiles.length })
            : t("data_import.folder_empty", "That folder appears to be empty.")
        );
        return;
      }

      folderQueue = importable.slice(1);
      folderQueueTotal = importable.length;
      folderQueueDone = 0;

      const entity = document.getElementById("importEntitySelect").value;
      updateFolderQueueStatus(
        t("data_import.folder_queue_starting", 'Found {count} file(s) — starting with "{name}" (1 of {total}).', {
          count: importable.length,
          name: importable[0].name,
          total: importable.length,
        })
      );
      // Each file gets ITS OWN source name (its filename), not the shared
      // "Source name" field above — different files in a folder are likely
      // different systems/structures, and reusing one source name across
      // them risks the exact mapping-collision bug fixed elsewhere in this
      // tool (a header that means one thing in file A getting silently
      // reused as "already mapped" for an unrelated column in file B).
      analyzeFile(importable[0], { entity, sourceName: importable[0].name });
    });
  }

  // Called after a batch finishes committing (both the single-entity and
  // auto-detect success paths) — if there's more in the folder queue, starts
  // the next file the same way the first one started; otherwise leaves the
  // page in its normal single-upload state.
  function advanceFolderQueue() {
    if (folderQueueTotal === 0) return; // no queue active — a plain single-file upload, nothing to do
    folderQueueDone++;
    if (folderQueue.length === 0) {
      if (folderQueueTotal > 0) {
        updateFolderQueueStatus(
          t("data_import.folder_queue_complete", "Folder import complete — processed {done} of {total} file(s).", {
            done: folderQueueDone,
            total: folderQueueTotal,
          })
        );
      }
      folderQueueTotal = 0;
      folderQueueDone = 0;
      document.getElementById("importFolderInput").value = "";
      return;
    }
    const next = folderQueue.shift();
    const entity = document.getElementById("importEntitySelect").value;
    updateFolderQueueStatus(
      t("data_import.folder_queue_progress", 'Importing "{name}" ({current} of {total})…', {
        name: next.name,
        current: folderQueueDone + 1,
        total: folderQueueTotal,
      })
    );
    analyzeFile(next, { entity, sourceName: next.name });
  }

  // ---------- Step 2: mapping review ----------

  const MATCH_BADGE = {
    matched: { cls: "completed", label: () => t("data_import.match_matched", "Matched") },
    saved: { cls: "completed", label: () => t("data_import.match_matched", "Matched") },
    suggested: { cls: "in-consultation", label: () => t("data_import.match_suggested", "Suggested") },
    unmatched: { cls: "waiting", label: () => t("data_import.match_new_field", "New field") },
  };

  function fieldSelectOptions(knownFields, selectedField, selectedIsCustom, selectedIsIgnored) {
    let html = `<option value="__custom__" ${selectedIsCustom ? "selected" : ""}>${escapeHtml(t("data_import.new_custom_field", "＋ New custom field (this hospital only)"))}</option>`;
    knownFields.forEach((f) => {
      html += `<option value="${escapeHtml(f.key)}" ${selectedField === f.key ? "selected" : ""}>${escapeHtml(f.label)}${f.required ? " *" : ""}</option>`;
    });
    html += `<option value="__ignore__" ${selectedIsIgnored ? "selected" : ""}>${escapeHtml(t("data_import.ignore_field", "Ignore — discard this column"))}</option>`;
    return html;
  }

  function renderMappingTable(batch) {
    document.getElementById("uploadSection").hidden = true;
    const section = document.getElementById("mappingSection");
    section.hidden = false;

    document.getElementById("mappingSummaryHint").textContent = t(
      "data_import.mapping_summary",
      "{count} rows found, {fieldCount} columns detected. Review the matches below, then confirm.",
      { count: batch.totalRows, fieldCount: batch.fields.length }
    );

    // Auto-detect ("Auto-detect" mode picked, but the file's own header set
    // confidently matched exactly ONE known table — see detectSingleEntityByFit
    // in server/importRoutes.js) skipped the mixed-dataset sorter entirely and
    // picked this batch's target entity on its own. Says WHY, and how to
    // undo it: Cancel below returns to the upload step with the entity
    // dropdown still available to pick the right one by hand.
    const autoBannerEl = document.getElementById("autoDetectBanner");
    if (batch.autoDetected) {
      autoBannerEl.textContent =
        (batch.autoDetectReason || t("data_import.auto_entity_detected_fallback", "Detected automatically.")) +
        " " +
        t("data_import.auto_entity_wrong_hint", 'Not right? Click Cancel below, then pick the correct type from "What are you importing?" and re-upload.');
      autoBannerEl.hidden = false;
    } else {
      autoBannerEl.hidden = true;
      autoBannerEl.textContent = "";
    }

    const warningEl = document.getElementById("singleRowEntityWarning");
    if (batch.singleRowEntityWarning) {
      warningEl.textContent = t(
        "data_import.single_row_entity_warning",
        "Your hospital only has ONE facility record — it isn't a list. This file has {count} rows, so importing it will overwrite that same record {count} times over, one after another, and only the LAST row will be kept; the other {countMinusOne} will be lost. If this file is really a list of many people or records, choose \"Patient records\" instead and re-upload.",
        { count: batch.totalRows, countMinusOne: batch.totalRows - 1 }
      );
      warningEl.hidden = false;
    } else {
      warningEl.hidden = true;
      warningEl.textContent = "";
    }

    const body = document.getElementById("mappingTableBody");
    body.innerHTML = batch.fields.map((f, i) => mapsToRowHtml(f, batch.knownFields, `data-row="${i}"`)).join("");
    wireMapsToOverrideButtons(body);

    // A fresh upload always starts in Manual Mapping — Auto Mapping is a
    // deliberate choice made per review, not a remembered preference.
    document.getElementById("mappingModeManual").checked = true;
    applyMappingMode("manual", body, document.getElementById("mappingModeHint"));
  }

  // Shared by the single-entity mapping table and every auto/multi-entity
  // bucket's own mapping table (renderBucketMappingRows) — one row's worth
  // of "File column | Sample value | Match | Maps to".
  //
  // A "New field" (Match = nothing matched at all) already has the only
  // safe, correct answer pre-selected: "＋ New custom field". There's no
  // judgment call to make for it — unlike a "Matched"/"Suggested" column,
  // which genuinely benefits from a second look — so its dropdown starts
  // locked (disabled) regardless of the Manual/Auto Mapping toggle, making
  // "you don't need to map this by hand" literal instead of just
  // technically true. "Change" un-locks that ONE row for the rare case an
  // admin wants to ignore it instead, or believes it actually belongs to a
  // known field the system missed.
  function mapsToRowHtml(f, knownFields, selectAttrs) {
    const badge = MATCH_BADGE[f.matchType] || MATCH_BADGE.unmatched;
    const isCustom = f.targetType === "extra_field";
    const isIgnored = f.targetType === "ignored";
    const isUnmatched = f.matchType === "unmatched";
    const sample = (f.sampleValues || []).filter((v) => v !== null && v !== undefined && String(v).trim() !== "")[0];
    return `<tr>
      <td><strong>${escapeHtml(f.sourceHeader)}</strong></td>
      <td class="mono-cell" style="color:var(--ink-mute, #8891a0);">${escapeHtml(sample ?? "—")}</td>
      <td><span class="queue-status ${badge.cls}">${escapeHtml(badge.label())}</span></td>
      <td>
        <select ${selectAttrs} data-source-field="${escapeHtml(f.sourceHeader)}" ${isUnmatched ? 'disabled data-unmatched="true"' : ""}>
          ${fieldSelectOptions(knownFields, isCustom || isIgnored ? null : f.targetField, isCustom, isIgnored)}
        </select>
        ${isUnmatched ? `<button type="button" class="maps-to-change-btn" style="margin-left:6px;background:none;border:none;color:var(--teal-dark);text-decoration:underline;cursor:pointer;font-size:12px;padding:0;">${escapeHtml(t("data_import.maps_to_change_link", "Change"))}</button>` : ""}
      </td>
    </tr>`;
  }

  function wireMapsToOverrideButtons(container) {
    container.querySelectorAll(".maps-to-change-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const select = btn.previousElementSibling;
        delete select.dataset.unmatched;
        select.disabled = false;
        select.focus();
        btn.remove();
      });
    });
  }

  // "Manual Mapping" leaves every "Maps to" dropdown editable, exactly as
  // before. "Auto Mapping" locks them at whatever the system already
  // determined was the best match for each column (the dropdowns are
  // pre-selected to that match regardless of mode — this only decides
  // whether the admin can override it before importing).
  function applyMappingMode(mode, tbody, hintEl) {
    const isAuto = mode === "auto";
    tbody.querySelectorAll("select").forEach((select) => {
      // A "New field" dropdown (see mapsToRowHtml) stays locked in BOTH
      // modes — there's no judgment call to review for it, unlike a
      // "Matched"/"Suggested" column. Only the explicit "Change" link next
      // to it (wireMapsToOverrideButtons) unlocks that one row, by clearing
      // this same marker — after that it behaves like any normal field.
      if (select.dataset.unmatched === "true") return;
      select.disabled = isAuto;
    });
    if (hintEl) {
      hintEl.textContent = isAuto
        ? t("data_import.auto_mapping_hint", "The system will use its best match for every column automatically — nothing to review.")
        : t("data_import.manual_mapping_hint", "Review and adjust each column's match before importing.");
    }
  }

  function wireMappingModeToggle() {
    const body = document.getElementById("mappingTableBody");
    const hint = document.getElementById("mappingModeHint");
    document.querySelectorAll('input[name="mappingMode"]').forEach((radio) => {
      radio.addEventListener("change", () => applyMappingMode(radio.value, body, hint));
    });
  }

  function wireMappingActions() {
    document.getElementById("cancelMappingBtn").addEventListener("click", () => {
      currentBatch = null;
      document.getElementById("mappingSection").hidden = true;
      document.getElementById("uploadSection").hidden = false;
      document.getElementById("importFileInput").value = "";
      // Cancelling a queued file skips it and moves on to the next one in
      // the folder, rather than leaving the rest of the queue stuck waiting
      // forever on a file nobody's going to confirm.
      advanceFolderQueue();
    });

    document.getElementById("confirmMappingBtn").addEventListener("click", async () => {
      if (!currentBatch) return;
      const errorEl = document.getElementById("mappingError");
      errorEl.textContent = "";

      if (currentBatch.singleRowEntityWarning) {
        const proceed = confirm(
          t(
            "data_import.confirm_single_row_entity",
            "This will overwrite your hospital's one facility record {count} times and keep only the last row. Are you sure this file isn't meant to be a list of many patients/records?",
            { count: currentBatch.totalRows }
          )
        );
        if (!proceed) return;
      }

      const mappings = [...document.querySelectorAll("#mappingTableBody select")].map((select) => {
        const sourceField = select.dataset.sourceField;
        const value = select.value;
        if (value === "__custom__") return { sourceField, targetType: "extra_field", targetField: null };
        if (value === "__ignore__") return { sourceField, targetType: "ignored", targetField: null };
        return { sourceField, targetType: "column", targetField: value };
      });

      const btn = document.getElementById("confirmMappingBtn");
      btn.disabled = true;
      try {
        const mapRes = await fetch(`/api/import/${currentBatch.batchId}/mapping`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ mappings }),
        });
        const mapData = await mapRes.json();
        if (!mapData.success) {
          errorEl.textContent = mapData.message || t("data_import.mapping_save_failed", "Could not save the mapping.");
          return;
        }

        const commitRes = await fetch(`/api/import/${currentBatch.batchId}/commit`, { method: "POST", credentials: "same-origin" });
        const commitData = await commitRes.json();
        if (!commitData.success) {
          errorEl.textContent = commitData.message || t("data_import.commit_failed", "Import failed.");
          return;
        }

        const newFieldsNote = commitData.customFieldsCreated.length
          ? " " + t("data_import.new_custom_fields_note", "{count} new custom field(s) registered: {fields}.", {
              count: commitData.customFieldsCreated.length,
              fields: commitData.customFieldsCreated.map((f) => f.fieldKey).join(", "),
            })
          : "";
        const redirectedNote = commitData.fieldsAutoRedirected && commitData.fieldsAutoRedirected.length
          ? " " + t("data_import.fields_redirected_note", "{count} column(s) didn't fit the field they were mapped to and were saved as custom fields instead: {fields}.", {
              count: commitData.fieldsAutoRedirected.length,
              fields: commitData.fieldsAutoRedirected.map((f) => `"${f.fieldKey}" → ${f.targetLabel}`).join(", "),
            })
          : "";
        const errorReasonsNote = commitData.failedRows && commitData.sampleErrors && commitData.sampleErrors.length
          ? " " + t("data_import.sample_errors_note", "Reason(s): {reasons}", { reasons: commitData.sampleErrors.join(" | ") })
          : "";
        const uhidNote = commitData.uhidCollisionsResolved
          ? " " + t("data_import.uhid_collisions_note", "{count} row(s) had a UHID/patient ID that was already in use — a new one was generated automatically and the file's original value was kept as a custom field.", { count: commitData.uhidCollisionsResolved })
          : "";
        const doctorLinkNote = commitData.doctorLinksCreated
          ? " " + t("data_import.doctor_links_created_note", "{count} patient(s) linked to their doctor.", { count: commitData.doctorLinksCreated })
          : "";
        const doctorUnresolvedNote = commitData.doctorLinksUnresolved
          ? " " + t("data_import.doctor_links_unresolved_note", "{count} patient(s) had a doctor name that didn't match any of your doctors — kept as a custom field instead of linking to the wrong one.", { count: commitData.doctorLinksUnresolved })
          : "";
        document.getElementById("commitConfirmation").textContent =
          t("data_import.commit_success", "Imported {committed} row(s).", { committed: commitData.committedRows }) +
          (commitData.failedRows ? " " + t("data_import.commit_failures", "{failed} row(s) failed and were skipped.", { failed: commitData.failedRows }) : "") +
          redirectedNote + uhidNote + doctorLinkNote + doctorUnresolvedNote + errorReasonsNote + newFieldsNote;
        if (window.showToast) showToast(t("data_import.import_complete_toast", "Import complete."), "success");

        currentBatch = null;
        setTimeout(() => {
          document.getElementById("mappingSection").hidden = true;
          document.getElementById("uploadSection").hidden = false;
          document.getElementById("importFileInput").value = "";
          document.getElementById("commitConfirmation").textContent = "";
          advanceFolderQueue();
        }, 4000);

        loadBatches();
        loadCustomFields();
        loadPatients();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- Auto-detect (mixed dataset): sort, review, import each bucket ----------

  function bucketMappingBodyId(entity) {
    return `bucket-mapping-${entity}`;
  }

  function renderBucketMappingRows(bucket) {
    return bucket.fields.map((f) => mapsToRowHtml(f, bucket.knownFields, "")).join("");
  }

  function renderAutoBuckets() {
    const container = document.getElementById("autoBucketsContainer");
    container.innerHTML = currentAutoBatch.buckets
      .map((bucket, idx) => {
        if (bucket.needsReclassification) {
          const valuesSeenNote = bucket.detectionLabels && bucket.detectionLabels.length
            ? " " + t("data_import.unclassified_values_seen", "Values seen: {values}", { values: bucket.detectionLabels.join(", ") })
            : "";
          return `<div class="bucket-panel" data-bucket-index="${idx}">
            <div class="bucket-panel-header">
              <span class="bucket-panel-title">${escapeHtml(t("data_import.unclassified_title", "Unclassified"))}</span>
              <span class="bucket-panel-count">${bucket.rowCount} ${escapeHtml(t("data_import.rows_label", "rows"))}</span>
            </div>
            <p class="wizard-hint">${escapeHtml(t("data_import.unclassified_hint", "Couldn't confidently tell what these rows are."))}${escapeHtml(valuesSeenNote)}</p>
            <div class="wizard-grid">
              <div>
                <label>${escapeHtml(t("data_import.assign_as", "Import these as"))}</label>
                <select class="unclassified-entity-select">
                  <option value="">${escapeHtml(t("data_import.choose_one", "Choose one…"))}</option>
                  ${ENTITY_OPTIONS.map((e) => `<option value="${e.value}">${escapeHtml(e.label)}</option>`).join("")}
                </select>
              </div>
            </div>
            <div class="wizard-nav">
              <button type="button" class="wizard-back-btn skip-unclassified-btn">${escapeHtml(t("data_import.skip_rows", "Skip these rows"))}</button>
              <button type="button" class="login-btn wizard-next-btn assign-unclassified-btn">${escapeHtml(t("data_import.assign_btn", "Assign"))}</button>
            </div>
          </div>`;
        }

        const isReady = bucket.status === "ready";
        return `<div class="bucket-panel" data-bucket-index="${idx}">
          <div class="bucket-panel-header">
            <span class="bucket-panel-title">${escapeHtml(bucket.entityLabel)}</span>
            <span class="bucket-panel-count">${bucket.rowCount} ${escapeHtml(t("data_import.rows_label", "rows"))} · <span class="queue-status bucket-status-pill ${isReady ? "completed" : "in-consultation"}">${escapeHtml(isReady ? t("data_import.match_matched", "Matched") : t("data_import.needs_review", "Needs review"))}</span></span>
          </div>
          ${bucket.fitWarning ? `<p class="wizard-hint" style="color:var(--warn-ink, #b45309);">${escapeHtml(bucket.fitWarning)}</p>` : ""}
          <div class="mapping-mode-toggle" role="radiogroup" aria-label="Mapping mode">
            <input type="radio" name="mappingMode_${idx}" id="mappingModeManual_${idx}" value="manual" checked />
            <label for="mappingModeManual_${idx}">${escapeHtml(t("data_import.manual_mapping", "Manual Mapping"))}</label>
            <input type="radio" name="mappingMode_${idx}" id="mappingModeAuto_${idx}" value="auto" />
            <label for="mappingModeAuto_${idx}">${escapeHtml(t("data_import.auto_mapping", "Auto Mapping"))}</label>
          </div>
          <span class="mapping-mode-hint" id="mappingModeHint_${idx}">${escapeHtml(t("data_import.manual_mapping_hint", "Review and adjust each column's match before importing."))}</span>
          <div class="portal-table-wrap" style="overflow-x:auto;">
            <table class="portal-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t("data_import.col_file_header", "File column"))}</th>
                  <th>${escapeHtml(t("data_import.col_sample", "Sample value"))}</th>
                  <th>${escapeHtml(t("data_import.col_match", "Match"))}</th>
                  <th>${escapeHtml(t("data_import.col_maps_to", "Maps to"))}</th>
                </tr>
              </thead>
              <tbody id="${bucketMappingBodyId(bucket.entity)}">${renderBucketMappingRows(bucket)}</tbody>
            </table>
          </div>
        </div>`;
      })
      .join("");

    wireMapsToOverrideButtons(container);

    container.querySelectorAll(".assign-unclassified-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = btn.closest(".bucket-panel");
        const idx = Number(panel.dataset.bucketIndex);
        const select = panel.querySelector(".unclassified-entity-select");
        if (!select.value) {
          // Used to just silently do nothing here — indistinguishable from a
          // broken button if the admin clicked Assign before picking
          // something from the dropdown (an easy thing to do, since it's
          // right above and defaults to "Choose one…"). Now it says why.
          document.getElementById("autoError").textContent = t(
            "data_import.choose_unclassified_type_first",
            'Pick a record type from "Import these as" above before clicking Assign.'
          );
          select.focus();
          return;
        }
        document.getElementById("autoError").textContent = "";
        reclassifyBucket(idx, select.value, false);
      });
    });
    container.querySelectorAll(".skip-unclassified-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const panel = btn.closest(".bucket-panel");
        const idx = Number(panel.dataset.bucketIndex);
        if (!confirm(t("data_import.confirm_skip_unclassified", "Skip these rows? They will not be imported anywhere."))) return;
        reclassifyBucket(idx, null, true);
      });
    });

    container.querySelectorAll('.bucket-panel input[type="radio"][name^="mappingMode_"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        const panel = radio.closest(".bucket-panel");
        const idx = Number(panel.dataset.bucketIndex);
        // Already imported — its mapping is locked in regardless of what the
        // toggle says now, so don't let switching it back to Manual re-enable
        // dropdowns for a bucket there's nothing left to change.
        if (currentAutoBatch?.buckets[idx]?.committed) return;
        const tbody = panel.querySelector("tbody[id^='bucket-mapping-']");
        if (!tbody) return;
        const hint = panel.querySelector(".mapping-mode-hint");
        applyMappingMode(radio.value, tbody, hint);
      });
    });
  }

  async function reclassifyBucket(idx, targetEntity, skip) {
    const errorEl = document.getElementById("autoError");
    errorEl.textContent = "";
    try {
      const res = await fetch(`/api/import/${currentAutoBatch.batchId}/reclassify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(skip ? { skip: true } : { targetEntity }),
      });
      const data = await res.json();
      if (!data.success) {
        errorEl.textContent = data.message || t("data_import.reclassify_failed", "Could not update these rows.");
        return;
      }

      currentAutoBatch.buckets.splice(idx, 1);
      if (!skip) {
        const existing = currentAutoBatch.buckets.find((b) => b.entity === data.entity);
        if (existing) {
          existing.rowCount += data.rowCount;
          existing.sampleRows = (existing.sampleRows || []).concat(data.sampleRows || []).slice(0, 5);
          existing.fields = data.fields;
          existing.knownFields = data.knownFields;
          existing.status = data.status;
        } else {
          currentAutoBatch.buckets.push({
            entity: data.entity,
            entityLabel: entityLabelFor(data.entity),
            rowCount: data.rowCount,
            status: data.status,
            fields: data.fields,
            sampleRows: data.sampleRows,
            knownFields: data.knownFields,
          });
        }
      }
      renderAutoBuckets();
    } catch (err) {
      errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
    }
  }

  function renderAutoSummary(data) {
    document.getElementById("uploadSection").hidden = true;
    document.getElementById("autoSection").hidden = false;
    currentAutoBatch = data;

    const parts = Object.entries(data.roleBreakdown)
      .filter(([, count]) => count > 0)
      .map(([entity, count]) => `${count} ${entityLabelFor(entity)}`);
    document.getElementById("autoSummaryText").textContent = t(
      "data_import.auto_summary",
      'Sorted {total} rows using the "{roleColumn}" column: {breakdown}.',
      { total: data.totalRows, roleColumn: data.roleColumn, breakdown: parts.join(", ") }
    );

    // Rows from a table the app already repopulates automatically as a side
    // effect of importing something else (e.g. user_directory, rebuilt by
    // every patient/staff row this same file imports) — recognized, not
    // "unclassified", just nothing left for the admin to decide. Never
    // silently invisible: this note is the "where did those rows go" answer.
    const skippedEl = document.getElementById("autoSkippedNote");
    const skippedEntries = Object.entries(data.autoSkipped || {}).filter(([, count]) => count > 0);
    if (skippedEntries.length > 0) {
      skippedEl.textContent = t(
        "data_import.auto_skipped_note",
        "{count} row(s) skipped automatically ({breakdown}) — this data is already kept up to date automatically whenever the records that reference it are imported, so there's nothing to review for them.",
        {
          count: skippedEntries.reduce((sum, [, c]) => sum + c, 0),
          breakdown: skippedEntries.map(([table, count]) => `${count} ${table}`).join(", "),
        }
      );
      skippedEl.hidden = false;
    } else {
      skippedEl.hidden = true;
      skippedEl.textContent = "";
    }

    document.getElementById("autoImportSummary").textContent = "";
    document.getElementById("autoProgress").hidden = true;
    document.getElementById("autoError").textContent = "";
    renderAutoBuckets();
  }

  function wireAutoActions() {
    document.getElementById("cancelAutoBtn").addEventListener("click", () => {
      currentAutoBatch = null;
      document.getElementById("autoSection").hidden = true;
      document.getElementById("uploadSection").hidden = false;
      document.getElementById("importFileInput").value = "";
      // Same reasoning as the mapping-review Cancel — skip this queued file
      // rather than stall the rest of the folder.
      advanceFolderQueue();
    });

    document.getElementById("confirmAutoBtn").addEventListener("click", async () => {
      if (!currentAutoBatch) return;
      const errorEl = document.getElementById("autoError");
      errorEl.textContent = "";

      if (currentAutoBatch.buckets.some((b) => b.needsReclassification)) {
        errorEl.textContent = t("data_import.resolve_unclassified_first", "Resolve the Unclassified group first — assign it to a record type or skip it.");
        return;
      }
      const realBuckets = currentAutoBatch.buckets;
      if (realBuckets.length === 0) {
        errorEl.textContent = t("data_import.nothing_to_import", "There's nothing to import.");
        return;
      }

      const btn = document.getElementById("confirmAutoBtn");
      btn.disabled = true;
      const progressWrap = document.getElementById("autoProgress");
      const progressFill = document.getElementById("autoProgressFill");
      const progressLabel = document.getElementById("autoProgressLabel");
      progressWrap.hidden = false;
      progressFill.classList.remove("indeterminate", "stopped");
      progressFill.style.width = "0%";

      // A failed bucket must never just look frozen mid-progress: say plainly
      // that it stopped and why, turn the bar red instead of leaving it at
      // whatever % it happened to be at, and jump straight to the panel that
      // needs fixing — it can be far below the sticky action bar in a long,
      // many-bucket import.
      function stopAt(bucketIndex, bucket, message) {
        progressFill.classList.add("stopped");
        progressLabel.textContent = t("data_import.import_stopped", "Stopped — fix the issue below, then click Import All again.");
        errorEl.textContent = `${bucket.entityLabel}: ` + message;
        const panel = document.querySelector(`.bucket-panel[data-bucket-index="${bucketIndex}"]`);
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      try {
        for (let i = 0; i < realBuckets.length; i++) {
          const bucket = realBuckets[i];

          // Retrying after fixing one bucket's mapping (see stopAt above)
          // re-runs this whole loop from the start — a bucket that already
          // committed successfully on the previous attempt must be skipped,
          // not re-submitted (the server would correctly refuse it as
          // already-imported, which would look like a brand new failure).
          if (bucket.committed) {
            progressFill.style.width = `${Math.round(((i + 1) / realBuckets.length) * 100)}%`;
            continue;
          }

          progressLabel.textContent = t(
            "data_import.importing_bucket",
            "Importing {label}… ({current} of {total})",
            { label: bucket.entityLabel, current: i + 1, total: realBuckets.length }
          );

          const mappings = [...document.querySelectorAll(`#${bucketMappingBodyId(bucket.entity)} select`)].map((select) => {
            const sourceField = select.dataset.sourceField;
            const value = select.value;
            if (value === "__custom__") return { sourceField, targetType: "extra_field", targetField: null };
            if (value === "__ignore__") return { sourceField, targetType: "ignored", targetField: null };
            return { sourceField, targetType: "column", targetField: value };
          });

          const mapRes = await fetch(`/api/import/${currentAutoBatch.batchId}/mapping`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ targetEntity: bucket.entity, mappings }),
          });
          const mapData = await mapRes.json();
          if (!mapData.success) {
            stopAt(i, bucket, mapData.message || t("data_import.mapping_save_failed", "Could not save the mapping."));
            return;
          }

          const commitRes = await fetch(`/api/import/${currentAutoBatch.batchId}/commit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ targetEntity: bucket.entity }),
          });
          const commitData = await commitRes.json();
          if (!commitData.success) {
            stopAt(i, bucket, commitData.message || t("data_import.commit_failed", "Import failed."));
            return;
          }
          // Stored on the bucket itself, not a running total — a retry after
          // fixing another bucket re-enters this loop from the start, and
          // the final summary below must count every bucket's own result
          // (from whichever attempt actually committed it), not just the
          // ones this particular call touched.
          bucket.committed = true;
          bucket.committedRows = commitData.committedRows;
          bucket.failedRows = commitData.failedRows;
          bucket.customFieldsCreated = commitData.customFieldsCreated || [];
          bucket.fieldsAutoRedirected = commitData.fieldsAutoRedirected || [];
          bucket.sampleErrors = commitData.sampleErrors || [];
          bucket.uhidCollisionsResolved = commitData.uhidCollisionsResolved || 0;
          bucket.doctorLinksCreated = commitData.doctorLinksCreated || 0;
          bucket.doctorLinksUnresolved = commitData.doctorLinksUnresolved || 0;

          const donePanel = document.querySelector(`.bucket-panel[data-bucket-index="${i}"]`);
          if (donePanel) {
            const pill = donePanel.querySelector(".bucket-status-pill");
            if (pill) {
              pill.textContent = t("data_import.imported_label", "Imported");
              pill.classList.remove("in-consultation");
              pill.classList.add("completed");
            }
            donePanel.querySelectorAll("select").forEach((s) => (s.disabled = true));
          }

          progressFill.style.width = `${Math.round(((i + 1) / realBuckets.length) * 100)}%`;
        }

        progressLabel.textContent = t("data_import.import_all_done", "Done.");

        // Every bucket is committed now (this call finished the loop without
        // stopping) — aggregate from every bucket's own stored result, not
        // just whichever ones this specific call happened to process.
        let totalCommitted = 0;
        let totalFailed = 0;
        let totalUhidCollisions = 0;
        let totalDoctorLinksCreated = 0;
        let totalDoctorLinksUnresolved = 0;
        const allCustomFields = [];
        const allRedirected = [];
        const allErrors = [];
        realBuckets.forEach((bucket) => {
          totalCommitted += bucket.committedRows || 0;
          totalFailed += bucket.failedRows || 0;
          totalUhidCollisions += bucket.uhidCollisionsResolved || 0;
          totalDoctorLinksCreated += bucket.doctorLinksCreated || 0;
          totalDoctorLinksUnresolved += bucket.doctorLinksUnresolved || 0;
          allCustomFields.push(...(bucket.customFieldsCreated || []));
          allRedirected.push(...(bucket.fieldsAutoRedirected || []));
          allErrors.push(...(bucket.sampleErrors || []).map((e) => `${bucket.entityLabel}: ${e}`));
        });

        const newFieldsNote = allCustomFields.length
          ? " " + t("data_import.new_custom_fields_note", "{count} new custom field(s) registered: {fields}.", {
              count: allCustomFields.length,
              fields: allCustomFields.map((f) => f.fieldKey).join(", "),
            })
          : "";
        const redirectedNote = allRedirected.length
          ? " " + t("data_import.fields_redirected_note", "{count} column(s) didn't fit the field they were mapped to and were saved as custom fields instead: {fields}.", {
              count: allRedirected.length,
              fields: allRedirected.map((f) => `"${f.fieldKey}" → ${f.targetLabel}`).join(", "),
            })
          : "";
        const uhidNote = totalUhidCollisions
          ? " " + t("data_import.uhid_collisions_note", "{count} row(s) had a UHID/patient ID that was already in use — a new one was generated automatically and the file's original value was kept as a custom field.", { count: totalUhidCollisions })
          : "";
        const doctorLinkNote = totalDoctorLinksCreated
          ? " " + t("data_import.doctor_links_created_note", "{count} patient(s) linked to their doctor.", { count: totalDoctorLinksCreated })
          : "";
        const doctorUnresolvedNote = totalDoctorLinksUnresolved
          ? " " + t("data_import.doctor_links_unresolved_note", "{count} patient(s) had a doctor name that didn't match any of your doctors — kept as a custom field instead of linking to the wrong one.", { count: totalDoctorLinksUnresolved })
          : "";
        const errorNote = allErrors.length
          ? " " + t("data_import.sample_errors_note", "Reason(s): {reasons}", { reasons: allErrors.slice(0, 5).join(" | ") })
          : "";
        document.getElementById("autoImportSummary").textContent =
          t("data_import.commit_success", "Imported {committed} row(s).", { committed: totalCommitted }) +
          (totalFailed ? " " + t("data_import.commit_failures", "{failed} row(s) failed and were skipped.", { failed: totalFailed }) : "") +
          redirectedNote + uhidNote + doctorLinkNote + doctorUnresolvedNote + errorNote + newFieldsNote +
          " " + t("data_import.staff_visible_note", "Any doctors, nurses, or other staff imported are now visible on the Existing Staff page.");

        if (window.showToast) showToast(t("data_import.import_complete_toast", "Import complete."), "success");

        currentAutoBatch = null;
        setTimeout(() => {
          document.getElementById("autoSection").hidden = true;
          document.getElementById("uploadSection").hidden = false;
          document.getElementById("importFileInput").value = "";
          document.getElementById("autoImportSummary").textContent = "";
          document.getElementById("autoProgress").hidden = true;
          advanceFolderQueue();
        }, 7000);

        loadBatches();
        loadCustomFields();
        loadPatients();
      } catch (err) {
        errorEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- Custom fields registry ----------

  let customFieldsCache = { patients: [], hospitals: [] };

  async function loadCustomFields() {
    const entity = document.getElementById("customFieldsEntitySelect").value;
    const res = await fetch(`/api/hospitals/${sessionUser.hospitalId}/custom-fields?entity=${encodeURIComponent(entity)}`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    const body = document.getElementById("customFieldsTableBody");
    const emptyState = document.getElementById("customFieldsEmptyState");
    if (!data.success || data.customFields.length === 0) {
      body.innerHTML = "";
      emptyState.hidden = false;
      customFieldsCache[entity] = [];
      return;
    }
    emptyState.hidden = true;
    customFieldsCache[entity] = data.customFields;
    body.innerHTML = data.customFields
      .map((f) => `<tr><td>${escapeHtml(f.field_label)}</td><td>${escapeHtml(f.field_type)}</td></tr>`)
      .join("");

    if (entity === "patients") renderPatientsTableHead();
  }

  // ---------- Patients (with dynamic custom-field columns) ----------

  function renderPatientsTableHead() {
    const extraCols = customFieldsCache.patients || [];
    const head = document.getElementById("patientsTableHead");
    head.innerHTML = `<tr>
      <th data-i18n="common.patient">Patient</th>
      <th>UHID</th>
      <th data-i18n="common.phone">Phone</th>
      <th>${escapeHtml(t("data_import.col_blood_group", "Blood Group"))}</th>
      ${extraCols.map((f) => `<th>${escapeHtml(f.field_label)}</th>`).join("")}
    </tr>`;
  }

  async function loadPatients() {
    const q = document.getElementById("patientSearchInput").value.trim();
    const res = await fetch(`/api/hospital/patients${q ? "?q=" + encodeURIComponent(q) : ""}`, { credentials: "same-origin" });
    const data = await res.json();
    const body = document.getElementById("patientsTableBody");
    const emptyState = document.getElementById("patientsEmptyState");
    if (!data.success || data.patients.length === 0) {
      body.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    const extraCols = customFieldsCache.patients || [];
    body.innerHTML = data.patients
      .map((p) => {
        const extra = (() => {
          if (!p.extra_fields) return {};
          try {
            return typeof p.extra_fields === "string" ? JSON.parse(p.extra_fields) : p.extra_fields;
          } catch {
            return {};
          }
        })();
        const extraCells = extraCols.map((f) => `<td>${escapeHtml(extra[f.field_key] ?? "—")}</td>`).join("");
        return `<tr>
          <td>${escapeHtml(p.full_name)}</td>
          <td class="mono-cell">${escapeHtml(p.uhid)}</td>
          <td>${escapeHtml(p.phone || "—")}</td>
          <td>${escapeHtml(p.blood_group || "—")}</td>
          ${extraCells}
        </tr>`;
      })
      .join("");
  }

  // ---------- Import history ----------

  const STATUS_LABEL = {
    uploaded: "Uploaded",
    mapping: "Needs mapping",
    ready: "Ready",
    committing: "Importing…",
    committed: "Committed",
    failed: "Failed",
  };

  async function loadBatches() {
    const res = await fetch("/api/import/batches", { credentials: "same-origin" });
    const data = await res.json();
    const body = document.getElementById("batchesTableBody");
    const emptyState = document.getElementById("batchesEmptyState");
    const selectAll = document.getElementById("batchSelectAll");
    if (!data.success || data.batches.length === 0) {
      body.innerHTML = "";
      emptyState.hidden = false;
      if (selectAll) selectAll.checked = false;
      updateBulkDeleteBar();
      return;
    }
    emptyState.hidden = true;
    body.innerHTML = data.batches
      .map((b) => {
        const rowsLabel = b.status === "committed" ? `${b.committed_rows} / ${b.total_rows}` : `${b.total_rows}`;
        const reverted = !!b.reverted_at;
        const statusCls = reverted ? "waiting" : b.status === "committed" ? "completed" : b.status === "failed" ? "waiting" : "in-consultation";
        const statusLabel = reverted ? t("data_import.status_reverted", "Deleted") : STATUS_LABEL[b.status] || b.status;
        // Any status can be deleted now — a batch that never reached
        // "committed" (failed to auto-detect, errored mid-staging, or was
        // just abandoned at the mapping step) has nothing real to undo, so
        // it's always safe to remove; a committed one still goes through the
        // real per-entity undo below, same as before, unless already reverted.
        const canDelete = b.status !== "committed" || !reverted;
        return `<tr>
          <td>${canDelete ? `<input type="checkbox" class="batch-select-checkbox" data-batch-id="${b.id}" data-entity="${escapeHtml(b.target_entity)}" data-status="${escapeHtml(b.status)}" aria-label="${escapeHtml(t("data_import.select_row", "Select this import"))}" />` : ""}</td>
          <td>${escapeHtml(b.original_filename)}</td>
          <td>${escapeHtml(entityLabelFor(b.target_entity))}</td>
          <td><span class="queue-status ${statusCls}">${escapeHtml(statusLabel)}</span></td>
          <td>${escapeHtml(rowsLabel)}</td>
          <td>${escapeHtml(new Date(b.created_at).toLocaleString())}</td>
          <td>${canDelete ? `<button type="button" class="icon-btn-delete" data-batch-id="${b.id}" data-entity="${escapeHtml(b.target_entity)}" data-status="${escapeHtml(b.status)}">${escapeHtml(t("data_import.delete_batch_btn", "Delete"))}</button>` : "—"}</td>
        </tr>`;
      })
      .join("");

    body.querySelectorAll("button[data-batch-id]").forEach((btn) => {
      btn.addEventListener("click", () => deleteBatch(btn.dataset.batchId, btn.dataset.entity, btn.dataset.status));
    });
    body.querySelectorAll(".batch-select-checkbox").forEach((cb) => {
      cb.addEventListener("change", updateBulkDeleteBar);
    });
    if (selectAll) selectAll.checked = false;
    updateBulkDeleteBar();
  }

  function getSelectedBatchCheckboxes() {
    return Array.from(document.querySelectorAll(".batch-select-checkbox:checked"));
  }

  function updateBulkDeleteBar() {
    const bar = document.getElementById("batchBulkBar");
    const btn = document.getElementById("batchBulkDeleteBtn");
    if (!bar || !btn) return;
    const count = getSelectedBatchCheckboxes().length;
    bar.hidden = count === 0;
    btn.textContent = t("data_import.delete_selected_btn", "Delete selected ({count})", { count });
  }

  async function deleteBulkBatches() {
    const checkboxes = getSelectedBatchCheckboxes();
    if (checkboxes.length === 0) return;
    const confirmMsg = t(
      "data_import.confirm_delete_selected_batches",
      "Delete these {count} import(s) from your history? Any that were committed will have every row they created removed, exactly like deleting them one at a time — this can't be undone.",
      { count: checkboxes.length }
    );
    if (!confirm(confirmMsg)) return;

    const btn = document.getElementById("batchBulkDeleteBtn");
    const messageEl = document.getElementById("batchDeleteMessage");
    btn.disabled = true;
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < checkboxes.length; i++) {
      messageEl.textContent = t("data_import.bulk_delete_progress", "Deleting {done} of {total}…", {
        done: i + 1,
        total: checkboxes.length,
      });
      const batchId = checkboxes[i].dataset.batchId;
      try {
        const res = await fetch(`/api/import/${batchId}`, { method: "DELETE", credentials: "same-origin" });
        const data = await res.json();
        if (data.success) successCount++;
        else failCount++;
      } catch {
        failCount++;
      }
    }
    btn.disabled = false;

    messageEl.textContent =
      failCount === 0
        ? t("data_import.bulk_delete_all_success", "{count} import(s) deleted.", { count: successCount })
        : t("data_import.bulk_delete_summary", "{success} of {total} import(s) deleted. {failed} failed.", {
            success: successCount,
            total: checkboxes.length,
            failed: failCount,
          });
    if (window.showToast) {
      showToast(
        failCount === 0
          ? t("data_import.bulk_delete_all_success", "{count} import(s) deleted.", { count: successCount })
          : t("data_import.bulk_delete_summary", "{success} of {total} import(s) deleted. {failed} failed.", {
              success: successCount,
              total: checkboxes.length,
              failed: failCount,
            }),
        failCount === 0 ? "success" : "error"
      );
    }

    loadBatches();
    loadCustomFields();
    loadPatients();
  }

  function wireBatchBulkActions() {
    const selectAll = document.getElementById("batchSelectAll");
    const bulkBtn = document.getElementById("batchBulkDeleteBtn");
    if (selectAll) {
      selectAll.addEventListener("change", () => {
        document.querySelectorAll(".batch-select-checkbox").forEach((cb) => {
          cb.checked = selectAll.checked;
        });
        updateBulkDeleteBar();
      });
    }
    if (bulkBtn) bulkBtn.addEventListener("click", deleteBulkBatches);
  }

  async function deleteBatch(batchId, entity, status) {
    const isDiscard = status !== "committed";
    const confirmMsg = isDiscard
      ? t("data_import.confirm_discard_batch", "Remove this incomplete/failed import from your history? Nothing was ever committed from it, so there's nothing to undo — this just clears the entry.")
      : entity === "hospitals"
      ? t("data_import.confirm_delete_hospital_batch", "Undo this import? Your hospital's facility record will be restored to what it was right before this import ran.")
      : entity === "auto"
      ? t("data_import.confirm_delete_auto_batch", "Delete every record this import created (patients, doctors, nurses, or any other staff)? This can't be undone — you'll need to re-upload the file to get this data back.")
      : entity === "multi"
      ? t("data_import.confirm_delete_multi_batch", "Delete every row this import created, across every table it touched? The upload itself stays in your history and can be re-committed afterward if you fix and re-confirm its mapping.")
      : t("data_import.confirm_delete_patients_batch", "Delete every patient this import created? This can't be undone — you'll need to re-upload the file to get this data back.");
    if (!confirm(confirmMsg)) return;

    const messageEl = document.getElementById("batchDeleteMessage");
    messageEl.textContent = "";
    try {
      const res = await fetch(`/api/import/${batchId}`, { method: "DELETE", credentials: "same-origin" });
      const data = await res.json();
      if (!data.success) {
        messageEl.textContent = data.message || t("data_import.delete_failed", "Could not delete this import.");
        return;
      }
      messageEl.textContent = isDiscard
        ? t("data_import.discard_success", "Removed from your import history.")
        : entity === "hospitals"
        ? t("data_import.delete_success_hospital", "Facility record restored.")
        : entity === "auto"
        ? t("data_import.delete_success_auto", "{count} record(s) deleted ({patients} patient(s), {staff} staff).", {
            count: data.deletedRows,
            patients: data.deletedPatients,
            staff: data.deletedStaff,
          })
        : entity === "multi"
        ? t("data_import.delete_success_multi", "{count} row(s) deleted across every table this import touched. It can be re-committed from the batch history if needed.", { count: data.deletedRows })
        : t("data_import.delete_success_patients", "{count} patient(s) deleted.", { count: data.deletedRows });
      if (window.showToast) showToast(t("data_import.delete_success_toast", "Import deleted."), "success");

      loadBatches();
      loadCustomFields();
      loadPatients();
    } catch (err) {
      messageEl.textContent = t("common.unable_to_reach_server", "Unable to reach the server. Please try again.");
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireUpload();
    wireFolderUpload();
    wireMappingActions();
    wireMappingModeToggle();
    wireAutoActions();
    wireBatchBulkActions();

    document.getElementById("customFieldsEntitySelect").addEventListener("change", loadCustomFields);
    let searchDebounce;
    document.getElementById("patientSearchInput").addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(loadPatients, 250);
    });

    await loadCustomFields();
    loadPatients();
    loadBatches();

    window.addEventListener("i18n:languageChanged", () => {
      loadBatches();
      loadCustomFields();
    });
  });
})();
