(function () {
  const GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
  const COMPONENTS = ["Whole Blood", "Packed RBC", "Fresh Frozen Plasma", "Platelets", "Cryoprecipitate"];
  const RATES = { "Whole Blood": 1200, "Packed RBC": 1500, "Fresh Frozen Plasma": 800, Platelets: 2000, Cryoprecipitate: 1000 };

  // Who CAN DONATE red cells / whole blood TO each recipient group.
  const RBC_DONORS_TO = {
    "A+": ["A+", "A-", "O+", "O-"], "A-": ["A-", "O-"],
    "B+": ["B+", "B-", "O+", "O-"], "B-": ["B-", "O-"],
    "AB+": ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"], "AB-": ["A-", "B-", "AB-", "O-"],
    "O+": ["O+", "O-"], "O-": ["O-"],
  };
  // Plasma compatibility is the inverse pattern — AB is the universal plasma donor, O can receive from anyone.
  const PLASMA_DONORS_TO = {
    "A+": ["A+", "AB+", "A-", "AB-"], "A-": ["A-", "AB-"],
    "B+": ["B+", "AB+", "B-", "AB-"], "B-": ["B-", "AB-"],
    "AB+": ["AB+", "AB-"], "AB-": ["AB-"],
    "O+": ["O+", "A+", "B+", "AB+", "O-", "A-", "B-", "AB-"], "O-": ["O-", "A-", "B-", "AB-"],
  };

  const FLAG_LABELS = {
    fever: "Currently has fever / recent infection",
    surgeryRecent: "Surgery or major dental work in the last 6 months",
    tattoo: "Tattoo or piercing in the last 12 months",
    pregnancy: "Currently pregnant or breastfeeding",
    medication: "On blood-thinners or other disqualifying medication",
    chronicIllness: "Diagnosed chronic illness affecting donation",
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function toast(msg, isError) {
    const c = document.getElementById("toastContainer");
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " toast-error" : "");
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast-show"));
    setTimeout(() => { el.classList.remove("toast-show"); setTimeout(() => el.remove(), 300); }, 3200);
    el.addEventListener("click", () => el.remove());
  }

  let sessionUser = null;
  let requests = [];
  let inventoryUnits = [];
  let donors = [];
  let patientDonations = [];
  let billing = [];
  let staffList = [];
  let filters = { scope: "all", group: "all", status: "all", priority: "all", component: "all", q: "", sort: "time" };
  let selectedId = null;
  let foundPatientForRequest = null;
  let foundPatientForDonation = null;

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "blood_bank_staff") {
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

  async function api(url, options) {
    const res = await fetch(url, { credentials: "same-origin", ...options });
    return res.json();
  }

  function unitsFor(group, component) {
    return inventoryUnits.filter((u) => u.blood_group === group && u.component === component).length;
  }

  function staffName(userId) {
    if (!userId) return "Unassigned";
    if (userId === sessionUser.userId) return sessionUser.fullName || userId;
    const s = staffList.find((x) => x.user_id === userId);
    return s ? s.full_name : userId;
  }

  // ---------- Loading ----------
  async function loadAll() {
    const [reqData, invData, donorData, pdData, billData, staffData] = await Promise.all([
      api("/api/bloodbank/requests"),
      api("/api/bloodbank/inventory"),
      api("/api/bloodbank/donors"),
      api("/api/bloodbank/patient-donations"),
      api("/api/bloodbank/billing"),
      api("/api/bloodbank/staff"),
    ]);
    requests = reqData.success ? reqData.requests : [];
    inventoryUnits = invData.success ? invData.units : [];
    donors = donorData.success ? donorData.donors : [];
    patientDonations = pdData.success ? pdData.donations : [];
    billing = billData.success ? billData.billing : [];
    staffList = staffData.success ? staffData.staff : [];
  }

  function renderAll() {
    renderSidebarGroups();
    renderTriage();
    renderMetrics();
    renderWorklist();
    renderPanel();
    renderInventoryTab();
    renderDonorsTab();
    renderPatientDonationTab();
    renderCompatTab();
    renderBillingTab();
    renderReportsTab();
    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
      window.i18n.applyTranslations();
    }
  }

  // ---------- Sidebar ----------
  function renderSidebarGroups() {
    const el = document.getElementById("groupSideItems");
    el.innerHTML = `<div class="side-item ${filters.group === "all" ? "active" : ""}" data-group="all">All groups <span class="count">${requests.length}</span></div>` +
      GROUPS.map((g) => `<div class="side-item ${filters.group === g ? "active" : ""}" data-group="${g}">${g} <span class="count">${requests.filter((r) => r.blood_group === g).length}</span></div>`).join("");
    el.querySelectorAll("[data-group]").forEach((elm) => {
      elm.addEventListener("click", () => {
        filters.group = elm.dataset.group;
        el.querySelectorAll("[data-group]").forEach((x) => x.classList.remove("active"));
        elm.classList.add("active");
        renderWorklist();
      });
    });
  }

  function wireSidebarStatic() {
    document.querySelectorAll("[data-scope]").forEach((elm) => {
      elm.addEventListener("click", () => {
        filters.scope = elm.dataset.scope;
        document.querySelectorAll("[data-scope]").forEach((x) => x.classList.remove("active"));
        elm.classList.add("active");
        renderWorklist();
      });
    });
    document.querySelectorAll("[data-status]").forEach((elm) => {
      elm.addEventListener("click", () => {
        filters.status = elm.dataset.status;
        document.querySelectorAll("[data-status]").forEach((x) => x.classList.remove("active"));
        elm.classList.add("active");
        renderWorklist();
      });
    });
  }

  function normalizePriority(p) {
    if (!p) return "Routine";
    const s = String(p).trim().toLowerCase();
    if (s === "emergency" || s === "stat") return "Emergency";
    if (s === "observation" || s === "urgent") return "Observation";
    return "Routine";
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

  // ---------- Triage & metrics ----------
  function renderTriage() {
    const c = { Emergency: 0, Observation: 0, Routine: 0 };
    requests.forEach((r) => {
      const np = normalizePriority(r.priority);
      c[np] = (c[np] || 0) + 1;
    });
    const total = requests.length || 1;
    const emergencyPct = Math.round((c.Emergency / total) * 100);
    const observationPct = Math.round((c.Observation / total) * 100);
    const routinePct = Math.round((c.Routine / total) * 100);

    const strip = document.getElementById("triageStrip");
    if (!strip) return;

    strip.innerHTML = `
      <div class="triage-container">
        <div class="triage-header">
          <div class="triage-title">
            <span class="live-pulse"></span>
            ${t('blood_bank.triage_overview', 'Triage & Urgency Overview')}
          </div>
          <div style="font-size: 12px; color: var(--ink-mute); font-family: var(--mono);">
            ${requests.length} ${t('blood_bank.total_open_requests', 'Total Open Request(s)')}
          </div>
        </div>

        <div class="triage-grid">
          <div class="triage-card emergency-card" data-priority="Emergency" title="Filter queue by Emergency priority">
            <div class="left-info">
              <div class="badge-icon">🚨</div>
              <div>
                <div class="priority-label">${t('blood_bank.emergency', 'Emergency')}</div>
                <div class="priority-sub">${t('blood_bank.critical_immediate', 'Critical / Immediate')}</div>
              </div>
            </div>
            <div class="priority-count">${c.Emergency}</div>
          </div>

          <div class="triage-card observation-card" data-priority="Observation" title="Filter queue by Observation priority">
            <div class="left-info">
              <div class="badge-icon">👁️</div>
              <div>
                <div class="priority-label">${t('blood_bank.observation', 'Observation')}</div>
                <div class="priority-sub">${t('blood_bank.monitored_high_priority', 'Monitored / High Priority')}</div>
              </div>
            </div>
            <div class="priority-count">${c.Observation}</div>
          </div>

          <div class="triage-card routine-card" data-priority="Routine" title="Filter queue by Routine priority">
            <div class="left-info">
              <div class="badge-icon">📋</div>
              <div>
                <div class="priority-label">${t('blood_bank.routine', 'Routine')}</div>
                <div class="priority-sub">${t('blood_bank.standard_delivery', 'Standard Delivery')}</div>
              </div>
            </div>
            <div class="priority-count">${c.Routine}</div>
          </div>
        </div>

        <div class="triage-track">
          <div class="triage-track-seg emergency" style="width: ${c.Emergency ? (c.Emergency/total)*100 : 0}%;" title="Emergency: ${emergencyPct}%"></div>
          <div class="triage-track-seg observation" style="width: ${c.Observation ? (c.Observation/total)*100 : 0}%;" title="Observation: ${observationPct}%"></div>
          <div class="triage-track-seg routine" style="width: ${c.Routine ? (c.Routine/total)*100 : 0}%;" title="Routine: ${routinePct}%"></div>
        </div>
      </div>`;

    strip.querySelectorAll(".triage-card").forEach((card) => {
      card.addEventListener("click", () => {
        setSortMode("priority");
        renderWorklist();
      });
    });
  }

  function renderMetrics() {
    const totalUnits = inventoryUnits.length;
    const lowGroups = GROUPS.filter((g) => COMPONENTS.some((c) => unitsFor(g, c) <= 1)).length;
    const weekMs = 7 * 86400000;
    const expiringSoon = inventoryUnits.filter((u) => new Date(u.expiry_at) - Date.now() < weekMs && new Date(u.expiry_at) - Date.now() > 0).length;
    const pending = requests.filter((r) => r.status === "requested" || r.status === "crossmatch").length;
    const emergencyOpen = requests.filter((r) => normalizePriority(r.priority) === "Emergency" && r.status !== "issued").length;
    document.getElementById("metricsRow").innerHTML = `
      <div class="metric"><div class="label">${t('blood_bank.units_in_stock', 'Total units in stock')}</div><div class="value">${totalUnits}</div><div class="delta">${t('blood_bank.across_groups', 'Across 8 groups')}</div></div>
      <div class="metric"><div class="label">${t('blood_bank.low_stock_groups', 'Low-stock groups')}</div><div class="value">${lowGroups}</div><div class="delta down">${lowGroups} ${t('blood_bank.groups_low', 'group(s) ≤1 unit in a component')}</div></div>
      <div class="metric"><div class="label">${t('blood_bank.expiring_7_days', 'Expiring within 7 days')}</div><div class="value">${expiringSoon}</div><div class="delta down">${t('blood_bank.prioritise_issue', 'Prioritise for issue')}</div></div>
      <div class="metric"><div class="label">${t('blood_bank.pending_requests', 'Pending requests')}</div><div class="value">${pending}</div><div class="delta ${emergencyOpen ? "down" : ""}">${emergencyOpen} ${t('blood_bank.emergency_open', 'Emergency open')}</div></div>`;
  }

  // ---------- Requests worklist ----------
  function statusMeta(s) {
    const labels = {
      requested: t('blood_bank.requested', 'Requested'),
      crossmatch: t('blood_bank.crossmatch', 'Crossmatch'),
      issued: t('blood_bank.issued', 'Issued'),
      rejected: t('blood_bank.rejected', 'Rejected'),
    };
    return {
      requested: { label: labels.requested, cls: "requested" },
      crossmatch: { label: labels.crossmatch, cls: "crossmatch" },
      issued: { label: labels.issued, cls: "issued" },
      rejected: { label: labels.rejected, cls: "rejected" },
    }[s] || { label: s, cls: s };
  }

  function filteredRequests() {
    let list = requests.filter((r) => {
      const matchGroup = filters.group === "all" || r.blood_group === filters.group;
      const matchStatus = filters.status === "all" || r.status === filters.status;
      const matchScope = filters.scope === "all" ||
        (filters.scope === "mine" && r.assigned_staff_id === sessionUser.userId) ||
        (filters.scope === "unassigned" && !r.assigned_staff_id);
      const matchPriority = filters.priority === "all" || normalizePriority(r.priority) === filters.priority;
      const matchComponent = filters.component === "all" || r.component === filters.component;
      const q = filters.q.toLowerCase();
      const matchQ = !q || r.patient_name.toLowerCase().includes(q) || (r.patient_uhid || "").toLowerCase().includes(q) || r.request_code.toLowerCase().includes(q);
      return matchGroup && matchStatus && matchScope && matchPriority && matchComponent && matchQ;
    });
    if (filters.sort === "priority") {
      const rank = { Emergency: 0, Observation: 1, Routine: 2 };
      list.sort((a, b) => rank[normalizePriority(a.priority)] - rank[normalizePriority(b.priority)]);
    }
    else if (filters.sort === "name") { list.sort((a, b) => a.patient_name.localeCompare(b.patient_name)); }
    else { list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); }
    return list;
  }

  function renderWorklist() {
    const list = filteredRequests();
    
    // Auto-select first request if none selected or current selection is not in list
    if (list.length > 0) {
      if (!selectedId || !list.some((x) => x.id === selectedId)) {
        selectedId = list[0].id;
      }
    } else {
      selectedId = null;
    }

    document.getElementById("countLabel").textContent = list.length + " requests";
    const body = document.getElementById("worklistBody");
    body.innerHTML = list.length ? list.map((r) => {
      const sm = statusMeta(r.status);
      const np = normalizePriority(r.priority);
      const npTranslated = t('blood_bank.' + np.toLowerCase(), np);
      const pDot = "● ";
      return `
      <tr class="${r.id === selectedId ? "selected" : ""}" data-id="${r.id}">
        <td><div class="pname">${escapeHtml(r.patient_name)}</div><div class="puhid">${escapeHtml(r.patient_uhid || "unregistered")} · ${escapeHtml(r.ward_location || "—")}</div></td>
        <td><span class="badge group">${r.blood_group}</span> ${r.units_required}u ${escapeHtml(r.component)}</td>
        <td><span class="badge ${np}">${pDot}${npTranslated}</span></td>
        <td><div class="status-pill"><span class="dot ${sm.cls}"></span>${sm.label}</div></td>
      </tr>`;
    }).join("") : `<tr><td colspan="4"><div class="empty">No requests match these filters.</div></td></tr>`;

    body.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => selectRequest(Number(tr.dataset.id))));

    document.getElementById("cntAll").textContent = requests.length;
    document.getElementById("cntMine").textContent = requests.filter((r) => r.assigned_staff_id === sessionUser.userId).length;
    document.getElementById("cntUnassigned").textContent = requests.filter((r) => !r.assigned_staff_id).length;
    document.getElementById("cntStatusAll").textContent = requests.length;
    document.getElementById("cntRequested").textContent = requests.filter((r) => r.status === "requested").length;
    document.getElementById("cntCrossmatch").textContent = requests.filter((r) => r.status === "crossmatch").length;
    document.getElementById("cntIssued").textContent = requests.filter((r) => r.status === "issued").length;
    document.getElementById("cntRejected").textContent = requests.filter((r) => r.status === "rejected").length;

    renderPanel();
  }

  function renderPanel() {
    const r = requests.find((x) => x.id === selectedId);
    const panel = document.getElementById("panel");
    if (!r) { panel.innerHTML = `<div class="empty">Select a request to view details, or create a new one.</div>`; return; }
    const initials = r.patient_name.split(" ").map((w) => w[0]).join("").slice(0, 2);
    const unassignedLabel = t('blood_bank.unassigned', 'Unassigned');
    const staffOptions = [`<option value="" ${!r.assigned_staff_id ? "selected" : ""}>${unassignedLabel}</option>`]
      .concat(staffList.map((s) => `<option value="${s.user_id}" ${s.user_id === r.assigned_staff_id ? "selected" : ""}>${escapeHtml(s.full_name)}</option>`))
      .join("");
    const available = unitsFor(r.blood_group, r.component);
    const np = normalizePriority(r.priority);
    const npTranslated = t('blood_bank.' + np.toLowerCase(), np);
    const priorityBanner = np === "Emergency"
      ? `<div class="panel-priority-banner emergency">● ${t('blood_bank.emergency_banner', 'EMERGENCY — Priority Transfusion Care')}</div>`
      : np === "Observation"
      ? `<div class="panel-priority-banner observation">● ${t('blood_bank.observation_banner', 'OBSERVATION — Monitored Care Order')}</div>`
      : `<div class="panel-priority-banner routine">● ${t('blood_bank.routine_banner', 'ROUTINE — Standard Order')}</div>`;

    panel.innerHTML = `
      ${priorityBanner}
      <div class="panel-head">
        <div class="panel-avatar">${initials}</div>
        <div><div class="panel-name">${escapeHtml(r.patient_name)}</div><div class="panel-meta">${escapeHtml(r.patient_uhid || "unregistered")} · ${r.age || "—"}${r.sex || ""} · ${r.request_code}</div></div>
      </div>
      <div class="info-grid">
        <div class="info-row"><span class="k">${t('blood_bank.priority_level', 'Priority level')}</span><span class="v"><span class="badge ${np}">${np === "Emergency" ? "🚨 " : np === "Observation" ? "👁️ " : "📋 "}${npTranslated}</span></span></div>
        <div class="info-row"><span class="k">${t('blood_bank.blood_group_component', 'Blood group / component')}</span><span class="v">${r.blood_group} · ${escapeHtml(r.component)}</span></div>
        <div class="info-row"><span class="k">${t('blood_bank.units_required', 'Units required')}</span><span class="v">${r.units_required}</span></div>
        <div class="info-row"><span class="k">${t('blood_bank.available_in_stock', 'Available in stock')}</span><span class="v" style="color:${available >= r.units_required ? "var(--green)" : "var(--red)"}">${available} unit(s)</span></div>
        <div class="info-row"><span class="k">${t('blood_bank.ward_location', 'Ward / location')}</span><span class="v">${escapeHtml(r.ward_location || "—")}</span></div>
        <div class="info-row"><span class="k">${t('blood_bank.requesting_physician', 'Requesting physician')}</span><span class="v">${escapeHtml(r.ref_physician || "—")}</span></div>
        <div class="info-row"><span class="k">${t('blood_bank.requested_at', 'Requested at')}</span><span class="v">${new Date(r.created_at).toLocaleString()}</span></div>
      </div>
      <div class="field-label">${t('blood_bank.assign_staff', 'Assign staff')}</div>
      <select class="full" id="assignSelect">${staffOptions}</select>
      <div class="field-label">${t('blood_bank.crossmatch_checklist', 'Crossmatch checklist')}</div>
      <div class="checklist">
        <label><input type="checkbox" id="cmSample" ${r.crossmatch_sample ? "checked" : ""}> ${t('blood_bank.sample_collected', 'Patient sample collected')}</label>
        <label><input type="checkbox" id="cmAbo" ${r.crossmatch_abo ? "checked" : ""}> ${t('blood_bank.abo_typing_confirmed', 'ABO / Rh typing confirmed')}</label>
        <label><input type="checkbox" id="cmScreen" ${r.crossmatch_screen ? "checked" : ""}> ${t('blood_bank.screen_compatible', 'Antibody screen & crossmatch compatible')}</label>
      </div>
      <div class="field-label">${t('blood_bank.notes', 'Notes')}</div>
      <textarea class="full" id="notesArea" placeholder="Crossmatch remarks, reaction notes, etc.">${escapeHtml(r.notes || "")}</textarea>
      <div class="panel-actions">
        <button class="btn" id="saveNotesBtn">${t('blood_bank.save_notes', 'Save notes')}</button>
        <button class="btn primary" id="issueBtn" ${r.status === "issued" || r.status === "rejected" ? "disabled" : ""}>${t('blood_bank.issue_units', 'Issue unit(s)')}</button>
      </div>
      <div class="panel-actions">
        <button class="btn" id="slipBtn">${t('blood_bank.download_slip', 'Download issue slip (PDF)')}</button>
        <button class="btn critical" id="rejectBtn" ${r.status === "issued" || r.status === "rejected" ? "disabled" : ""}>${t('blood_bank.reject_request', 'Reject request')}</button>
      </div>`;

    document.getElementById("assignSelect").addEventListener("change", (e) => assignStaff(r.id, e.target.value));
    document.getElementById("cmSample").addEventListener("change", (e) => toggleCrossmatch(r.id, "sample", e.target.checked));
    document.getElementById("cmAbo").addEventListener("change", (e) => toggleCrossmatch(r.id, "abo", e.target.checked));
    document.getElementById("cmScreen").addEventListener("change", (e) => toggleCrossmatch(r.id, "screen", e.target.checked));
    document.getElementById("saveNotesBtn").addEventListener("click", () => saveNotes(r.id));
    document.getElementById("issueBtn").addEventListener("click", () => issueUnits(r.id));
    document.getElementById("slipBtn").addEventListener("click", () => downloadSlip(r.id));
    document.getElementById("rejectBtn").addEventListener("click", () => rejectRequest(r.id));
  }

  function selectRequest(id) { selectedId = id; renderWorklist(); renderPanel(); }

  async function assignStaff(id, staffId) {
    const data = await api(`/api/bloodbank/requests/${id}/assign`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staffId: staffId || "Unassigned" }),
    });
    if (!data.success) return toast(data.message || t('blood_bank.could_not_assign', 'Could not assign.'), true);
    await loadAll(); renderAll();
    toast(`Assigned ${staffId ? staffName(staffId) : "Unassigned"}`);
  }

  async function toggleCrossmatch(id, field, val) {
    const data = await api(`/api/bloodbank/requests/${id}/crossmatch`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field, value: val }),
    });
    if (!data.success) return toast(data.message || t('blood_bank.could_not_update', 'Could not update.'), true);
    await loadAll(); renderPanel(); renderWorklist();
  }

  async function saveNotes(id) {
    const notes = document.getElementById("notesArea").value;
    const data = await api(`/api/bloodbank/requests/${id}/notes`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }),
    });
    if (!data.success) return toast(data.message || t('common.could_not_save', 'Could not save.'), true);
    toast("Notes saved");
  }

  async function issueUnits(id) {
    const data = await api(`/api/bloodbank/requests/${id}/issue`, { method: "POST" });
    if (!data.success) return toast(data.message || t('blood_bank.could_not_issue', 'Could not issue.'), true);
    await loadAll(); renderAll();
    toast(`Issued ${data.unitsIssued.length} unit(s) — added to billing`);
  }

  async function rejectRequest(id) {
    const data = await api(`/api/bloodbank/requests/${id}/reject`, { method: "POST" });
    if (!data.success) return toast(data.message || t('blood_bank.could_not_reject', 'Could not reject.'), true);
    await loadAll(); renderAll();
    toast("Request rejected", true);
  }

  function downloadSlip(id) {
    const r = requests.find((x) => x.id === id);
    if (!window.jspdf) return toast("PDF library still loading — try again in a moment.", true);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48; let y = 92;

    doc.setFillColor(142, 31, 58); doc.rect(0, 0, pageW, 64, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text(sessionUser.hospitalName || "MEDISYS Hospital", margin, 34);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.text("Blood Bank · Component Issue Slip", margin, 50);

    doc.setTextColor(36, 20, 24); doc.setFont("helvetica", "bold"); doc.setFontSize(13);
    doc.text("Blood component issue slip", margin, y); y += 22;
    doc.setDrawColor(230, 217, 221); doc.line(margin, y, pageW - margin, y); y += 18;

    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    const rows = [
      ["Patient name", r.patient_name, "UHID", r.patient_uhid || "—"],
      ["Age / Sex", `${r.age || "—"} / ${r.sex || "—"}`, "Request ID", r.request_code],
      ["Blood group", r.blood_group, "Component", r.component],
      ["Units issued", String(r.units_required), "Ward / location", r.ward_location || "—"],
      ["Requesting physician", r.ref_physician || "—", "Issued by", staffName(r.assigned_staff_id)],
    ];
    rows.forEach((row) => {
      doc.setTextColor(150, 130, 138); doc.text(row[0], margin, y);
      doc.setTextColor(36, 20, 24); doc.text(row[1] || "—", margin + 140, y);
      doc.setTextColor(150, 130, 138); doc.text(row[2], margin + 300, y);
      doc.setTextColor(36, 20, 24); doc.text(row[3] || "—", margin + 410, y);
      y += 18;
    });

    y += 10; doc.setDrawColor(230, 217, 221); doc.line(margin, y, pageW - margin, y); y += 22;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(36, 20, 24);
    doc.text("Crossmatch confirmation", margin, y); y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    [["Patient sample collected", r.crossmatch_sample], ["ABO / Rh typing confirmed", r.crossmatch_abo], ["Antibody screen & crossmatch compatible", r.crossmatch_screen]].forEach(([label, val]) => {
      doc.text(`${val ? "[x]" : "[ ]"} ${label}`, margin, y); y += 16;
    });

    y += 8; doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Notes", margin, y); y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    const lines = doc.splitTextToSize(r.notes && r.notes.trim() ? r.notes : "—", pageW - margin * 2);
    doc.text(lines, margin, y); y += lines.length * 12 + 30;

    doc.setDrawColor(230, 217, 221); doc.line(margin, y, margin + 180, y);
    doc.setFontSize(9); doc.setTextColor(150, 130, 138);
    doc.text(staffName(r.assigned_staff_id), margin, y + 14);
    doc.text("Electronically generated slip — Core5 MEDISYS", margin, 810);

    doc.save(`${r.patient_uhid || r.request_code}_${r.request_code}_issue_slip.pdf`);
    toast("Issue slip downloaded");
  }

  // ---------- New request modal ----------
  function wireNewRequestModal() {
    const backdrop = document.getElementById("reqModalBackdrop");
    document.getElementById("newRequestBtn").addEventListener("click", () => {
      foundPatientForRequest = null;
      ["nrName", "nrUhid", "nrAge", "nrWard", "nrRef", "nrSearch"].forEach((id) => (document.getElementById(id).value = ""));
      document.getElementById("nrUnits").value = 1;
      document.getElementById("nrSearchResults").innerHTML = "";
      backdrop.classList.add("open");
    });
    document.getElementById("nrCancel").addEventListener("click", () => backdrop.classList.remove("open"));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.classList.remove("open"); });

    let debounce;
    document.getElementById("nrSearch").addEventListener("input", (e) => {
      clearTimeout(debounce);
      const q = e.target.value.trim();
      const results = document.getElementById("nrSearchResults");
      if (!q) { results.innerHTML = ""; return; }
      debounce = setTimeout(async () => {
        const data = await api(`/api/patients/search?q=${encodeURIComponent(q)}`);
        if (!data.success) return;
        results.innerHTML = data.patients.map((p) => `
          <div class="side-item" data-uhid="${escapeHtml(p.uhid)}" style="background:var(--surface-2); margin-bottom:4px;">
            <span>${escapeHtml(p.full_name)} <span class="puhid">${escapeHtml(p.uhid)}</span></span>
          </div>`).join("") || `<div class="empty" style="padding:10px;">No matching patients.</div>`;
        results.querySelectorAll("[data-uhid]").forEach((el) => {
          el.addEventListener("click", () => {
            const p = data.patients.find((x) => x.uhid === el.dataset.uhid);
            foundPatientForRequest = p;
            document.getElementById("nrName").value = p.full_name;
            document.getElementById("nrUhid").value = p.uhid;
            if (p.dob) document.getElementById("nrAge").value = Math.floor((Date.now() - new Date(p.dob)) / (365.25 * 86400000));
            if (p.gender) document.getElementById("nrSex").value = p.gender.startsWith("F") ? "F" : "M";
            if (p.blood_group) document.getElementById("nrGroup").value = p.blood_group;
            results.innerHTML = "";
            document.getElementById("nrSearch").value = `${p.full_name} (${p.uhid})`;
          });
        });
      }, 300);
    });

    document.getElementById("nrSubmit").addEventListener("click", async () => {
      const payload = {
        patientUhid: document.getElementById("nrUhid").value.trim() || null,
        patientName: document.getElementById("nrName").value.trim(),
        age: Number(document.getElementById("nrAge").value) || null,
        sex: document.getElementById("nrSex").value,
        bloodGroup: document.getElementById("nrGroup").value,
        component: document.getElementById("nrComponent").value,
        unitsRequired: Number(document.getElementById("nrUnits").value) || 1,
        priority: document.getElementById("nrPriority").value,
        wardLocation: document.getElementById("nrWard").value.trim(),
        refPhysician: document.getElementById("nrRef").value.trim(),
      };
      if (!payload.patientName) return toast("Patient name is required.", true);
      const data = await api("/api/bloodbank/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!data.success) return toast(data.message || t('blood_bank.could_not_create_request', 'Could not create request.'), true);
      backdrop.classList.remove("open");
      await loadAll(); renderAll();
      selectRequest(data.id);
      toast(`Request ${data.requestCode} created`);
    });
  }

  // ---------- Inventory tab ----------
  function renderInventoryTab() {
    const grid = document.getElementById("invGrid");
    grid.innerHTML = GROUPS.map((g) => {
      const rows = COMPONENTS.map((c) => {
        const n = unitsFor(g, c);
        const cls = n <= 1 ? "low" : (n <= 4 ? "" : "ok");
        return `<div class="inv-row ${cls}"><span>${c}</span><span class="u">${n}</span></div>`;
      }).join("");
      return `<div class="inv-card"><div class="grp">${g}</div>${rows}</div>`;
    }).join("");

    const weekMs = 7 * 86400000;
    const expiring = inventoryUnits.filter((u) => new Date(u.expiry_at) - Date.now() < weekMs && new Date(u.expiry_at) - Date.now() > 0)
      .sort((a, b) => new Date(a.expiry_at) - new Date(b.expiry_at)).slice(0, 15);
    document.getElementById("expiryBody").innerHTML = expiring.length ? expiring.map((u) => `
      <tr><td>${escapeHtml(u.unit_code)}</td><td><span class="badge group">${u.blood_group}</span></td><td>${escapeHtml(u.component)}</td>
      <td>${new Date(u.collected_at).toLocaleDateString()}</td><td><span class="expiry-warn">${new Date(u.expiry_at).toLocaleDateString()}</span></td></tr>`
    ).join("") : `<tr><td colspan="5"><div class="empty">Nothing expiring in the next 7 days.</div></td></tr>`;
  }

  function wireRecordDonationModal() {
    const backdrop = document.getElementById("donModalBackdrop");
    document.getElementById("recordDonationBtn").addEventListener("click", () => {
      const sel = document.getElementById("donDonor");
      sel.innerHTML = donors.length
        ? donors.map((d) => `<option value="${d.id}">${escapeHtml(d.full_name)} (${d.blood_group})</option>`).join("")
        : `<option value="">No donors registered yet — add one first</option>`;
      backdrop.classList.add("open");
    });
    document.getElementById("donCancel").addEventListener("click", () => backdrop.classList.remove("open"));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.classList.remove("open"); });
    document.getElementById("donSubmit").addEventListener("click", async () => {
      const donorId = document.getElementById("donDonor").value;
      if (!donorId) return toast("Select a donor first.", true);
      const data = await api("/api/bloodbank/donations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ donorId: Number(donorId), component: document.getElementById("donComponent").value, units: Number(document.getElementById("donUnits").value) || 1 }),
      });
      if (!data.success) return toast(data.message || t('blood_bank.could_not_record_donation', 'Could not record donation.'), true);
      backdrop.classList.remove("open");
      await loadAll(); renderAll();
      toast(`${data.unitsAdded} unit(s) added to stock`);
    });
  }

  // ---------- Donor register tab ----------
  function renderDonorsTab() {
    document.getElementById("donorBody").innerHTML = donors.length ? donors.map((d) => `
      <tr><td class="pname">${escapeHtml(d.full_name)}</td><td><span class="badge group">${d.blood_group}</span></td>
      <td>${escapeHtml(d.phone || "—")}</td><td>${d.last_donation_date ? new Date(d.last_donation_date).toLocaleDateString() : "Never"}</td>
      <td>${d.total_donations}</td></tr>`
    ).join("") : `<tr><td colspan="5"><div class="empty">No donors registered yet.</div></td></tr>`;
  }

  function wireAddDonor() {
    document.getElementById("addDonorBtn").addEventListener("click", async () => {
      const name = document.getElementById("dName").value.trim();
      if (!name) return toast("Donor name is required.", true);
      const data = await api("/api/bloodbank/donors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, bloodGroup: document.getElementById("dGroup").value, phone: document.getElementById("dPhone").value.trim(), lastDonationDate: document.getElementById("dDate").value || null }),
      });
      if (!data.success) return toast(data.message || t('blood_bank.could_not_add_donor', 'Could not add donor.'), true);
      ["dName", "dPhone", "dDate"].forEach((id) => (document.getElementById(id).value = ""));
      await loadAll(); renderAll();
      toast(`${name} added to donor register`);
    });
  }

  // ---------- Patient blood donation tab ----------
  function renderPatientDonationTab() {
    document.getElementById("patientDonationBody").innerHTML = patientDonations.length ? patientDonations.slice(0, 10).map((d) => `
      <tr><td class="pname">${escapeHtml(d.donor_name)}</td><td><span class="badge group">${d.blood_group}</span></td>
      <td>${escapeHtml(d.component)}</td><td>${new Date(d.created_at).toLocaleDateString()}</td></tr>`
    ).join("") : `<tr><td colspan="4"><div class="empty">No patient donations recorded yet.</div></td></tr>`;
  }

  function wirePatientDonation() {
    let debounce;
    document.getElementById("pdSearch").addEventListener("input", (e) => {
      clearTimeout(debounce);
      const q = e.target.value.trim();
      const results = document.getElementById("pdSearchResults");
      if (!q) { results.innerHTML = ""; return; }
      debounce = setTimeout(async () => {
        const data = await api(`/api/patients/search?q=${encodeURIComponent(q)}`);
        if (!data.success) return;
        results.innerHTML = data.patients.map((p) => `
          <div class="side-item" data-uhid="${escapeHtml(p.uhid)}" style="background:var(--surface-2); margin-bottom:4px;">
            <span>${escapeHtml(p.full_name)} <span class="puhid">${escapeHtml(p.uhid)}</span></span>
          </div>`).join("") || `<div class="empty" style="padding:10px;">No matching patients.</div>`;
        results.querySelectorAll("[data-uhid]").forEach((el) => {
          el.addEventListener("click", () => {
            const p = data.patients.find((x) => x.uhid === el.dataset.uhid);
            foundPatientForDonation = p;
            results.innerHTML = "";
            document.getElementById("pdSearch").value = `${p.full_name} (${p.uhid})`;
            if (p.blood_group) document.getElementById("pdGroup").value = p.blood_group;
            document.getElementById("pdPatientCard").innerHTML = `
              <div class="info-row"><span class="k">Patient</span><span class="v">${escapeHtml(p.full_name)}</span></div>
              <div class="info-row"><span class="k">UHID</span><span class="v">${escapeHtml(p.uhid)}</span></div>
              <div class="info-row"><span class="k">Known blood group</span><span class="v">${p.blood_group || "Not on file — confirm below"}</span></div>`;
          });
        });
      }, 300);
    });

    function collectScreening() {
      return {
        patientUhid: foundPatientForDonation ? foundPatientForDonation.uhid : null,
        weight: document.getElementById("pdWeight").value,
        hb: document.getElementById("pdHb").value,
        systolic: document.getElementById("pdSystolic").value,
        diastolic: document.getElementById("pdDiastolic").value,
        pulse: document.getElementById("pdPulse").value,
        temperature: document.getElementById("pdTemp").value,
        flags: {
          fever: document.getElementById("pdFlagFever").checked,
          surgeryRecent: document.getElementById("pdFlagSurgery").checked,
          tattoo: document.getElementById("pdFlagTattoo").checked,
          pregnancy: document.getElementById("pdFlagPregnancy").checked,
          medication: document.getElementById("pdFlagMedication").checked,
          chronicIllness: document.getElementById("pdFlagChronic").checked,
        },
      };
    }

    document.getElementById("pdCheckBtn").addEventListener("click", async () => {
      if (!foundPatientForDonation) return toast("Search for and select a patient first.", true);
      const data = await api("/api/bloodbank/patient-donations/check-eligibility", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(collectScreening()),
      });
      const el = document.getElementById("pdEligibilityResult");
      if (!data.success) { el.className = "empty"; el.textContent = data.message || t('blood_bank.could_not_check_eligibility', 'Could not check eligibility.'); return; }
      if (data.eligible) {
        el.className = ""; el.innerHTML = `<div class="eligible">&#10003; Eligible to donate</div><p style="font-size:12.5px; color:var(--ink-soft); margin-top:8px;">All screening values are within the safe donation range.</p>`;
      } else {
        el.className = ""; el.innerHTML = `<div class="not-eligible">&#10007; Not eligible to donate</div><ul style="font-size:12.5px; color:var(--ink-soft); margin-top:8px; padding-left:18px;">${data.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`;
      }
    });

    document.getElementById("pdSubmitBtn").addEventListener("click", async () => {
      if (!foundPatientForDonation) return toast("Search for and select a patient first.", true);
      if (!document.getElementById("pdConsent").checked) return toast("Patient consent is required before recording a donation.", true);
      const screening = collectScreening();
      const data = await api("/api/bloodbank/patient-donations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...screening,
          donorName: foundPatientForDonation.full_name,
          bloodGroup: document.getElementById("pdGroup").value,
          component: document.getElementById("pdComponent").value,
          units: document.getElementById("pdUnits").value,
          consent: true,
        }),
      });
      if (!data.success) {
        const el = document.getElementById("pdEligibilityResult");
        el.className = ""; el.innerHTML = `<div class="not-eligible">&#10007; ${escapeHtml(data.message || t('blood_bank.could_not_record_donation', 'Could not record donation.'))}</div>` +
          (data.reasons ? `<ul style="font-size:12.5px; color:var(--ink-soft); margin-top:8px; padding-left:18px;">${data.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : "");
        return toast(data.message || t('blood_bank.could_not_record_donation', 'Could not record donation.'), true);
      }
      await loadAll(); renderAll();
      toast(`Donation recorded — ${data.unitsAdded} unit(s) added to stock`);
    });
  }

  // ---------- Compatibility checker ----------
  function renderCompatTab() {
    function compute() {
      const group = document.getElementById("compatGroup").value;
      const component = document.getElementById("compatComponent").value;
      const matrix = component === "Fresh Frozen Plasma" ? PLASMA_DONORS_TO : RBC_DONORS_TO;
      const donorGroups = matrix[group] || [];
      const available = donorGroups.map((g) => ({ g, n: unitsFor(g, component) })).filter((x) => x.n > 0);
      document.getElementById("compatResult").innerHTML = `
        <div class="field-label" style="margin-top:0;">Can safely donate ${escapeHtml(component)} to a ${group} recipient</div>
        <div class="compat-list">${donorGroups.map((g) => `<span class="compat-chip">${g}</span>`).join("")}</div>
        <div class="field-label">Currently in stock for this recipient</div>
        ${available.length ? available.map((x) => `<div class="inv-row"><span>${x.g}</span><span class="u" style="color:var(--green);">${x.n} unit(s)</span></div>`).join("") : `<div class="empty" style="padding:14px 0;">No compatible units in stock right now.</div>`}`;
    }
    document.getElementById("compatGroup").onchange = compute;
    document.getElementById("compatComponent").onchange = compute;
    compute();
  }

  // ---------- Billing tab ----------
  function renderBillingTab() {
    const totalBilled = billing.reduce((s, b) => s + parseFloat(b.amount), 0);
    const pending = billing.filter((b) => b.status !== "paid");
    document.getElementById("billingSummary").textContent = `${billing.length} bill(s) · ₹${totalBilled.toFixed(2)} total · ${pending.length} pending`;
    document.getElementById("billingBody").innerHTML = billing.length ? billing.map((b) => {
      const isPaid = b.status === "paid";
      return `<tr>
        <td class="pname">${escapeHtml(b.patient_name)}</td>
        <td>${escapeHtml(b.component)}</td>
        <td>${b.units}</td>
        <td>₹${parseFloat(b.amount).toFixed(2)}</td>
        <td><span class="badge ${isPaid ? "paid" : "pending"}">${isPaid ? "Paid" : "Pending"}</span></td>
        <td>${isPaid ? "" : `
          <button class="btn primary pay-btn" data-id="${b.id}" style="flex:none; padding:6px 14px;">Mark Paid (Cash)</button>
          <button class="btn pay-online-btn" data-id="${b.id}" data-patient="${escapeHtml(b.patient_name)}" data-component="${escapeHtml(b.component)}" style="flex:none; padding:6px 14px; margin-left:6px;">Pay via Razorpay</button>
        `}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="6"><div class="empty">No billing entries yet.</div></td></tr>`;

    document.querySelectorAll(".pay-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const data = await api(`/api/bloodbank/billing/${btn.dataset.id}/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentType: "Cash" }) });
        if (!data.success) return toast(data.message || t('blood_bank.could_not_mark_paid', 'Could not mark as paid.'), true);
        await loadAll(); renderAll();
        toast("Marked as Paid");
      });
    });

    document.querySelectorAll(".pay-online-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await window.MedisysPayments.payViaRazorpay({
            createOrderUrl: `/api/bloodbank/billing/${btn.dataset.id}/create-order`,
            verifyUrl: `/api/bloodbank/billing/${btn.dataset.id}/verify-payment`,
            name: "MEDISYS Blood Bank",
            description: `${btn.dataset.component} for ${btn.dataset.patient}`,
          });
          await loadAll(); renderAll();
          toast(t('blood_bank.payment_collected', 'Payment collected — marked as Paid.'));
        } catch (err) {
          if (!err.dismissed) toast(err.message, true);
        }
      });
    });
  }

  // ---------- Reports tab ----------
  function barRows(counts, max) {
    return Object.entries(counts).map(([label, val]) => `
      <div class="bar-row"><span class="lbl">${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${max ? (val / max) * 100 : 0}%"></div></div><span class="val">${val}</span></div>`
    ).join("");
  }

  function renderReportsTab() {
    const issuedByGroup = {};
    GROUPS.forEach((g) => (issuedByGroup[g] = 0));
    requests.filter((r) => r.status === "issued").forEach((r) => { issuedByGroup[r.blood_group] += r.units_required; });
    document.getElementById("reportIssuedByGroup").innerHTML = barRows(issuedByGroup, Math.max(1, ...Object.values(issuedByGroup)));

    const stockByGroup = {};
    GROUPS.forEach((g) => (stockByGroup[g] = unitsFor(g, "Whole Blood") + unitsFor(g, "Packed RBC") + unitsFor(g, "Fresh Frozen Plasma") + unitsFor(g, "Platelets") + unitsFor(g, "Cryoprecipitate")));
    document.getElementById("reportStockByGroup").innerHTML = barRows(stockByGroup, Math.max(1, ...Object.values(stockByGroup)));

    const rawByStatus = { requested: 0, crossmatch: 0, issued: 0, rejected: 0 };
    requests.forEach((r) => { rawByStatus[r.status] = (rawByStatus[r.status] || 0) + 1; });
    const byStatus = {
      [t("blood_bank.requested", "Requested")]: rawByStatus.requested,
      [t("blood_bank.crossmatch", "Crossmatch")]: rawByStatus.crossmatch,
      [t("blood_bank.issued", "Issued")]: rawByStatus.issued,
      [t("blood_bank.rejected", "Rejected")]: rawByStatus.rejected
    };
    document.getElementById("reportByStatus").innerHTML = barRows(byStatus, Math.max(1, ...Object.values(byStatus)));

    const totalBilled = billing.reduce((s, b) => s + parseFloat(b.amount), 0);
    const collected = billing.filter((b) => b.status === "paid").reduce((s, b) => s + parseFloat(b.amount), 0);
    document.getElementById("reportSummary").innerHTML = `
      <div class="info-row"><span class="k">${t("blood_bank.report_total_requests", "Total requests")}</span><span class="v">${requests.length}</span></div>
      <div class="info-row"><span class="k">${t("blood_bank.report_total_units_stock", "Total units in stock")}</span><span class="v">${inventoryUnits.length}</span></div>
      <div class="info-row"><span class="k">${t("blood_bank.report_registered_donors", "Registered donors")}</span><span class="v">${donors.length}</span></div>
      <div class="info-row"><span class="k">${t("blood_bank.report_patient_donations_rec", "Patient donations recorded")}</span><span class="v">${patientDonations.length}</span></div>
      <div class="info-row"><span class="k">${t("blood_bank.report_total_billed", "Total billed")}</span><span class="v">₹${totalBilled.toFixed(2)}</span></div>
      <div class="info-row"><span class="k">${t("blood_bank.report_collected", "Collected")}</span><span class="v">₹${collected.toFixed(2)}</span></div>`;
  }

  // ---------- Tabs & search wiring ----------
  function wireTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".tabpage").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
      });
    });
  }

  function updateActiveFilterBadge() {
    let count = 0;
    if (filters.priority !== "all") count++;
    if (filters.group !== "all") count++;
    if (filters.component !== "all") count++;
    if (filters.status !== "all") count++;
    if (filters.scope !== "all") count++;
    if (filters.q) count++;

    const badge = document.getElementById("activeFilterBadge");
    if (badge) {
      if (count > 0) {
        badge.style.display = "inline-block";
        badge.textContent = count;
      } else {
        badge.style.display = "none";
      }
    }

    // Sync popover priority chips
    document.querySelectorAll("[data-filter-priority]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.filterPriority === filters.priority);
    });
    // Sync quick filter bar chips
    document.querySelectorAll("[data-chip-priority]").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.chipPriority === filters.priority);
    });
    // Sync selects
    const grpSel = document.getElementById("popoverGroupSelect");
    if (grpSel) grpSel.value = filters.group;
    const compSel = document.getElementById("popoverComponentSelect");
    if (compSel) compSel.value = filters.component;
  }

  function setSortMode(sortVal) {
    filters.sort = sortVal;
    const sortSelect = document.getElementById("sortSelect");
    if (sortSelect) sortSelect.value = sortVal;
    
    const keyMap = {
      time: 'blood_bank.sort_time',
      priority: 'blood_bank.sort_priority',
      name: 'blood_bank.sort_name'
    };
    const labels = {
      time: t('blood_bank.sort_time', 'Sort: Request Time'),
      priority: t('blood_bank.sort_priority', 'Sort: Priority'),
      name: t('blood_bank.sort_name', 'Sort: Patient Name')
    };
    const lbl = document.getElementById("sortLabelText");
    if (lbl) {
      lbl.setAttribute("data-i18n", keyMap[sortVal] || "blood_bank.sort_by");
      lbl.textContent = labels[sortVal] || t('blood_bank.sort_by', 'Sort');
    }

    document.querySelectorAll("#sortMenuPopover .sort-option").forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.sort === sortVal);
    });
  }

  function setPriorityFilter(priorityVal) {
    filters.priority = priorityVal;
    updateActiveFilterBadge();
    renderWorklist();
  }

  function resetAllFilters() {
    filters = { scope: "all", group: "all", status: "all", priority: "all", component: "all", q: "", sort: "time" };
    const search = document.getElementById("search");
    if (search) search.value = "";
    setSortMode("time");
    updateActiveFilterBadge();
    renderWorklist();
  }

  function wireRequestsToolbar() {
    const search = document.getElementById("search");
    if (search) {
      search.addEventListener("input", (e) => {
        filters.q = e.target.value.trim();
        updateActiveFilterBadge();
        renderWorklist();
      });
    }

    const container = document.getElementById("sortDropdownContainer");
    const trigger = document.getElementById("sortTriggerBtn");
    if (trigger && container) {
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        container.classList.toggle("open");
      });

      // Sort options
      document.querySelectorAll("#sortMenuPopover .sort-option").forEach((opt) => {
        opt.addEventListener("click", (e) => {
          e.stopPropagation();
          setSortMode(opt.dataset.sort);
          renderWorklist();
        });
      });

      // Priority filter chips inside popover
      document.querySelectorAll("[data-filter-priority]").forEach((chip) => {
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          setPriorityFilter(chip.dataset.filterPriority);
        });
      });

      // Blood group select inside popover
      const grpSel = document.getElementById("popoverGroupSelect");
      if (grpSel) {
        grpSel.addEventListener("change", (e) => {
          filters.group = e.target.value;
          updateActiveFilterBadge();
          renderWorklist();
        });
      }

      // Component select inside popover
      const compSel = document.getElementById("popoverComponentSelect");
      if (compSel) {
        compSel.addEventListener("change", (e) => {
          filters.component = e.target.value;
          updateActiveFilterBadge();
          renderWorklist();
        });
      }

      // Reset button
      const resetBtn = document.getElementById("resetFiltersBtn");
      if (resetBtn) {
        resetBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          resetAllFilters();
        });
      }

      // Close on outside click
      document.addEventListener("click", (e) => {
        if (!container.contains(e.target)) {
          container.classList.remove("open");
        }
      });
    }

    // Quick filter bar chips
    document.querySelectorAll("[data-chip-priority]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setPriorityFilter(btn.dataset.chipPriority);
      });
    });

    const sortSelect = document.getElementById("sortSelect");
    if (sortSelect) {
      sortSelect.addEventListener("change", (e) => { setSortMode(e.target.value); renderWorklist(); });
    }
  }

  async function init() {
    const user = await guardSession();
    if (!user) return;
    wireLogout();

    await loadAll();

    const root = document.getElementById("appRoot");
    const tpl = document.getElementById("appTemplate");
    root.replaceWith(tpl.content.cloneNode(true));

    if (window.i18n && typeof window.i18n.applyTranslations === 'function') {
      window.i18n.applyTranslations();
    }

    wireSidebarStatic();
    wireTabs();
    wireRequestsToolbar();
    wireNewRequestModal();
    wireRecordDonationModal();
    wireAddDonor();
    wirePatientDonation();

    renderAll();

    const knownRequestIds = new Set(requests.map((r) => r.id));

    async function refreshAndRerender() {
      const hadRequestsBefore = knownRequestIds.size > 0;
      await loadAll();
      requests.forEach((r) => {
        if (!knownRequestIds.has(r.id)) {
          knownRequestIds.add(r.id);
          if (hadRequestsBefore) showToast(t('blood_bank.new_request_toast', 'New blood request: {code} ({group} {component})', { code: r.request_code || "#" + r.id, group: r.blood_group, component: r.component }), "success");
        }
      });
      renderAll();
    }

    // Live push does the real-time work now; this is just a safety-net in case
    // a socket ever silently drops.
    setInterval(refreshAndRerender, 60000);

    if (window.MEDISYS_RT) {
      ["bloodbank_requests", "bloodbank_inventory", "bloodbank_donors", "bloodbank_billing"].forEach((resource) =>
        MEDISYS_RT.on(resource, refreshAndRerender)
      );
    }

    window.addEventListener("i18n:languageChanged", () => {
      renderAll();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
