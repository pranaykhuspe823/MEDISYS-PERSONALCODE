const TEMPLATES = {
  "CBC": "COMPLETE BLOOD COUNT\nParameter            Result      Unit        Reference range\nHaemoglobin          -           g/dL        13.0–17.0\nTotal WBC count      -           /cumm       4000–11000\nPlatelet count       -           /cumm       150000–410000\nRBC count            -           mill/cumm   4.5–5.5\nHematocrit (PCV)     -           %           40–50\n\nIMPRESSION:\n",
  "LFT": "LIVER FUNCTION TEST\nParameter            Result      Unit        Reference range\nTotal Bilirubin      -           mg/dL       0.3–1.2\nSGOT (AST)           -           U/L         5–40\nSGPT (ALT)           -           U/L         5–41\nAlkaline Phosphatase -           U/L         44–147\nTotal Protein        -           g/dL        6.4–8.3\n\nIMPRESSION:\n",
  "KFT": "KIDNEY FUNCTION TEST\nParameter            Result      Unit        Reference range\nBlood Urea           -           mg/dL       15–40\nSerum Creatinine     -           mg/dL       0.6–1.3\nUric Acid            -           mg/dL       3.5–7.2\nSodium               -           mmol/L      135–145\nPotassium            -           mmol/L      3.5–5.1\n\nIMPRESSION:\n",
  "Lipid Profile": "LIPID PROFILE\nParameter            Result      Unit        Reference range\nTotal Cholesterol    -           mg/dL       <200\nTriglycerides        -           mg/dL       <150\nHDL Cholesterol      -           mg/dL       >40\nLDL Cholesterol      -           mg/dL       <100\n\nIMPRESSION:\n",
  "Urine R/M": "URINE ROUTINE & MICROSCOPY\nColour               -\nAppearance           -\npH                   -\nProtein              -\nGlucose              -\nPus cells /hpf       -\nRBC /hpf             -\n\nIMPRESSION:\n",
  "Other": "RESULT\nParameter            Result      Unit        Reference range\n-                    -           -           -\n\nIMPRESSION:\n",
};

const PRIORITY_LABEL = { routine: "Routine", urgent: "Urgent", stat: "STAT" };
const STATUS_LABEL = { pending: "Collected", in_progress: "Processing", reported: "Result entry", verified: "Verified" };

let currentUser = null;
let hospitalName = "";
let staffOptions = [];
let studies = [];
let filters = { scope: "all", specimen: "all", status: "all", q: "", sort: "time" };
let selectedId = null;
let panelState = {}; // per-sample transient viewer state: { activeImage, brightness, contrast }

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

function initials(name) {
  return (
    (name || "")
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

function computeAge(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000)));
}

function imageUrl(orderId, imgId) {
  return `/api/lab-orders/${orderId}/images/${imgId}`;
}

function getPanelState(id) {
  if (!panelState[id]) panelState[id] = { activeImage: 0, brightness: 100, contrast: 100 };
  return panelState[id];
}

function imgFilter(ps) {
  return `brightness(${(ps.brightness / 100).toFixed(2)}) contrast(${(ps.contrast / 100).toFixed(2)})`;
}

async function guardSession() {
  const res = await fetch("/api/session", { credentials: "same-origin" });
  const data = await res.json();
  // hospital_admin gets read/oversight access too, mirroring the backend
  // routes (GET /api/lab-orders etc. already allow hospital_admin) — staff-
  // only mutation endpoints still enforce pathology_staff server-side, so an
  // admin viewing this page can't silently act as the technician.
  if (!data.user || (data.user.role !== "pathology_staff" && data.user.role !== "hospital_admin")) {
    window.location.href = "../index";
    return null;
  }
  currentUser = data.user;
  return data.user;
}

function wireLogout() {
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "../index";
  });
}

async function loadProfile() {
  const res = await fetch("/api/me", { credentials: "same-origin" });
  const data = await res.json();
  if (!data.success) return false;
  const { fullName, hospitalName: hName, details } = data.profile;
  if (details && details.designation === "Radiologist") {
    // Radiologists get the imaging-specific queue instead.
    window.location.href = "radiology-queue";
    return false;
  }
  hospitalName = hName;
  document.getElementById("hospitalNameLabel").textContent = hName || "";
  document.getElementById("portalUser").textContent = `${fullName || currentUser.userId} · ${(details && details.designation) || "Pathologist"}`;
  document.getElementById("portalAvatar").textContent = initials(fullName);
  return true;
}

async function loadStaffOptions() {
  const res = await fetch("/api/lab-orders/staff?department=Pathology", { credentials: "same-origin" });
  const data = await res.json();
  staffOptions = data.success ? data.staff : [];
}

async function loadStudies() {
  const res = await fetch("/api/lab-orders?department=Pathology", { credentials: "same-origin" });
  const data = await res.json();
  if (!data.success) {
    studies = [];
    return;
  }
  studies = data.orders.map((o) => ({
    id: o.id,
    name: o.patient_name || o.patient_uhid,
    uhid: o.patient_uhid,
    sid: `PS-${String(o.id).padStart(5, "0")}`,
    age: computeAge(o.dob),
    sex: o.gender || "—",
    specimen: o.sample_type && o.sample_type !== "N/A" ? o.sample_type : "Other",
    panel: o.test_name || "—",
    ref: o.doctor_name || o.doctor_user_id,
    createdAt: o.created_at,
    priority: o.priority || "routine",
    status: o.status,
    assignedUserId: o.assigned_to,
    path: o.assigned_to_name || (o.assigned_to ? o.assigned_to : "Unassigned"),
    report: o.result_notes || "",
    images: (o.images || []).map((img) => ({ id: img.id, fileName: img.fileName })),
    turnaroundHours: o.turnaround_hours,
    verifiedAt: o.verified_at,
    verifiedByName: o.verified_by_name,
  }));
}

async function refresh(keepSelectedId) {
  await loadStudies();
  if (keepSelectedId && studies.some((s) => s.id === keepSelectedId)) {
    selectedId = keepSelectedId;
  } else if (!studies.some((s) => s.id === selectedId)) {
    selectedId = studies.length ? studies[0].id : null;
  }
  renderAll();
}

function specimenTypes() {
  const set = new Set();
  studies.forEach((s) => set.add(s.specimen));
  return [...set].sort();
}

function filteredStudies() {
  let list = studies.filter((s) => {
    const matchSpec = filters.specimen === "all" || s.specimen === filters.specimen;
    const matchStat = filters.status === "all" || s.status === filters.status;
    const matchScope =
      filters.scope === "all" ||
      (filters.scope === "mine" && s.assignedUserId === currentUser.userId) ||
      (filters.scope === "unclaimed" && s.status === "pending");
    const q = filters.q.toLowerCase();
    const matchQ =
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.uhid.toLowerCase().includes(q) ||
      s.sid.toLowerCase().includes(q);
    return matchSpec && matchStat && matchScope && matchQ;
  });
  if (filters.sort === "priority") {
    const rank = { stat: 0, urgent: 1, routine: 2 };
    list.sort((a, b) => rank[a.priority] - rank[b.priority]);
  } else if (filters.sort === "name") {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return list;
}

function renderTriage() {
  const c = { stat: 0, urgent: 0, routine: 0 };
  studies.forEach((s) => {
    c[s.priority] = (c[s.priority] || 0) + 1;
  });
  const el = document.getElementById("triageStrip");
  if (studies.length === 0) {
    el.innerHTML = `<div class="triage-empty">No samples in the queue yet.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="triage-seg stat" style="flex:${c.stat}"><span class="n">${c.stat}</span> STAT</div>
    <div class="triage-seg urgent" style="flex:${c.urgent}"><span class="n">${c.urgent}</span> Urgent</div>
    <div class="triage-seg routine" style="flex:${c.routine}"><span class="n">${c.routine}</span> Routine</div>
  `;
}

function renderMetrics() {
  const now = Date.now();
  const todayStr = new Date().toDateString();
  const samplesToday = studies.filter((s) => new Date(s.createdAt).toDateString() === todayStr).length;
  const openStudies = studies.filter((s) => s.status !== "verified");
  const slaBreach = openStudies.filter((s) => {
    if (!s.turnaroundHours) return false;
    return (now - new Date(s.createdAt).getTime()) / 3600000 > s.turnaroundHours;
  }).length;
  const statOpen = openStudies.filter((s) => s.priority === "stat").length;
  const verifiedToday = studies.filter((s) => s.verifiedAt && new Date(s.verifiedAt).toDateString() === todayStr);
  let avgTat = "—";
  if (verifiedToday.length) {
    const totalMin = verifiedToday.reduce(
      (sum, s) => sum + (new Date(s.verifiedAt) - new Date(s.createdAt)) / 60000,
      0
    );
    const avgMin = Math.round(totalMin / verifiedToday.length);
    avgTat = avgMin >= 60 ? `${Math.floor(avgMin / 60)}h ${avgMin % 60}m` : `${avgMin}m`;
  }
  document.getElementById("metricsRow").innerHTML = `
    <div class="metric"><div class="label">Samples today</div><div class="value">${samplesToday}</div><div class="delta">${studies.length} total in queue</div></div>
    <div class="metric"><div class="label">Pending results</div><div class="value">${openStudies.length}</div><div class="delta ${slaBreach ? "down" : ""}">${slaBreach} breaching SLA</div></div>
    <div class="metric"><div class="label">STAT priority open</div><div class="value">${statOpen}</div><div class="delta ${statOpen ? "down" : ""}">${statOpen ? "Needs immediate attention" : "None open"}</div></div>
    <div class="metric"><div class="label">Avg TAT, verified today</div><div class="value">${avgTat}</div><div class="delta">${verifiedToday.length} verified today</div></div>
  `;
}

function renderSidebarCounts() {
  document.getElementById("cntAll").textContent = studies.length;
  document.getElementById("cntMine").textContent = studies.filter((s) => s.assignedUserId === currentUser.userId).length;
  document.getElementById("cntUnassigned").textContent = studies.filter((s) => s.status === "pending").length;

  document.getElementById("cntStatusAll").textContent = studies.length;
  document.getElementById("cntPending").textContent = studies.filter((s) => s.status === "pending").length;
  document.getElementById("cntInProgress").textContent = studies.filter((s) => s.status === "in_progress").length;
  document.getElementById("cntReported").textContent = studies.filter((s) => s.status === "reported").length;
  document.getElementById("cntVerified").textContent = studies.filter((s) => s.status === "verified").length;

  const specimens = specimenTypes();
  const counts = {};
  specimens.forEach((sp) => (counts[sp] = 0));
  studies.forEach((s) => {
    counts[s.specimen] = (counts[s.specimen] || 0) + 1;
  });
  document.getElementById("specimenSideItems").innerHTML =
    `<div class="side-item ${filters.specimen === "all" ? "active" : ""}" data-specimen="all">All specimens <span class="count">${studies.length}</span></div>` +
    specimens
      .map(
        (sp) =>
          `<div class="side-item ${filters.specimen === sp ? "active" : ""}" data-specimen="${escapeHtml(sp)}">${escapeHtml(sp)} <span class="count">${counts[sp]}</span></div>`
      )
      .join("");

  document.querySelectorAll("[data-scope]").forEach((el) => el.classList.toggle("active", el.dataset.scope === filters.scope));
  document.querySelectorAll("[data-status]").forEach((el) => el.classList.toggle("active", el.dataset.status === filters.status));
}

function renderWorklist() {
  const list = filteredStudies();
  document.getElementById("countLabel").textContent = list.length + " samples";
  const body = document.getElementById("worklistBody");
  if (list.length === 0) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">No samples match these filters.</div></td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((s) => {
      const priorityLabel = PRIORITY_LABEL[s.priority] || s.priority;
      const statusLabel = STATUS_LABEL[s.status] || s.status;
      return `
    <tr class="${s.id === selectedId ? "selected" : ""}" onclick="selectStudy(${s.id})">
      <td><div class="pname">${escapeHtml(s.name)}</div><div class="puhid">${escapeHtml(s.uhid)}</div></td>
      <td>${escapeHtml(s.panel)}</td>
      <td><span class="badge ${priorityLabel}">${priorityLabel}</span></td>
      <td><div class="status-pill"><span class="dot ${s.status}"></span>${statusLabel}</div></td>
      <td style="font-size:12px; color:var(--ink-soft);">${escapeHtml(s.path)}</td>
    </tr>`;
    })
    .join("");
}

function renderPanel() {
  const s = studies.find((x) => x.id === selectedId);
  const panel = document.getElementById("panel");
  if (!s) {
    panel.innerHTML = `<div class="empty">Select a sample to view details.</div>`;
    return;
  }
  const ps = getPanelState(s.id);
  if (ps.activeImage >= s.images.length) ps.activeImage = Math.max(0, s.images.length - 1);

  const pathOptions =
    `<option value="" ${!s.assignedUserId ? "selected" : ""}>Unassigned</option>` +
    staffOptions
      .map((r) => `<option value="${r.userId}" ${r.userId === s.assignedUserId ? "selected" : ""}>${escapeHtml(r.fullName)}</option>`)
      .join("");
  const priorityOptions = Object.keys(PRIORITY_LABEL)
    .map((p) => `<option value="${p}" ${p === s.priority ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`)
    .join("");
  const chips = Object.keys(TEMPLATES)
    .map((m) => `<div class="chip" onclick="insertTemplate('${m}')">${m}</div>`)
    .join("");

  const activeImg = s.images[ps.activeImage];
  const isFinal = s.status === "verified";

  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-avatar">${initials(s.name)}</div>
      <div>
        <div class="panel-name">${escapeHtml(s.name)}</div>
        <div class="panel-meta">${escapeHtml(s.uhid)} · ${s.age ?? "—"}${s.sex !== "—" ? s.sex[0] : ""} · ${s.sid}</div>
      </div>
    </div>

    <div class="viewer" id="viewerBox" style="${activeImg ? `background-image:url('${imageUrl(s.id, activeImg.id)}'); filter:${imgFilter(ps)};` : ""}">
      ${activeImg ? "" : '<div class="crosshair"></div>'}
      <span class="tag">${escapeHtml(s.specimen)} · Image ${s.images.length ? ps.activeImage + 1 + "/" + s.images.length : "0/0"}</span>
      <span class="tag br">${activeImg ? "Adjustable" : "No image"}</span>
      ${activeImg ? "" : `<div class="center-icon">NO SPECIMEN IMAGE<br>${escapeHtml(s.panel)}</div>`}
      <input type="file" id="fileInput" accept="image/*" multiple style="display:none" onchange="handleUpload(event, ${s.id})">
      <div class="upload-btn" onclick="document.getElementById('fileInput').click()">+ Upload specimen / slide image</div>
    </div>
    ${
      s.images.length
        ? `<div class="thumb-strip">${s.images
            .map(
              (img, i) =>
                `<div class="thumb ${i === ps.activeImage ? "active" : ""}" style="background-image:url('${imageUrl(s.id, img.id)}')" onclick="setActiveImage(${s.id},${i})"></div>`
            )
            .join("")}</div>`
        : ""
    }
    <div class="zoom-controls">
      <div class="zc-col"><label>Brightness</label><input type="range" min="40" max="180" value="${ps.brightness}" oninput="updateImg(${s.id},'brightness',this.value)"></div>
      <div class="zc-col"><label>Contrast</label><input type="range" min="40" max="200" value="${ps.contrast}" oninput="updateImg(${s.id},'contrast',this.value)"></div>
    </div>

    <div class="info-grid">
      <div class="info-row"><span class="k">Test panel</span><span class="v">${escapeHtml(s.panel)}</span></div>
      <div class="info-row"><span class="k">Specimen type</span><span class="v">${escapeHtml(s.specimen)}</span></div>
      <div class="info-row"><span class="k">Referring physician</span><span class="v">${escapeHtml(s.ref)}</span></div>
      <div class="info-row"><span class="k">Collected</span><span class="v">${escapeHtml(new Date(s.createdAt).toLocaleString())}</span></div>
    </div>

    <div class="field-label">Priority</div>
    <select class="full" ${isFinal ? "disabled" : ""} onchange="setPriority(${s.id}, this.value)">${priorityOptions}</select>

    <div class="field-label">Assign pathologist</div>
    <select class="full" ${isFinal ? "disabled" : ""} onchange="assignPath(${s.id}, this.value)">${pathOptions}</select>

    <div class="field-label">Result — insert panel template</div>
    <div class="template-chips">${chips}</div>
    <textarea class="full" id="reportArea" ${isFinal ? "readonly" : ""} placeholder="Enter results, values and impression...">${escapeHtml(s.report)}</textarea>

    ${
      isFinal
        ? `<div class="verified-note">Signed &amp; verified by ${escapeHtml(s.verifiedByName || "—")} on ${s.verifiedAt ? escapeHtml(new Date(s.verifiedAt).toLocaleString()) : "—"}.</div>`
        : `<div class="panel-actions">
            <button class="btn" onclick="saveDraft(${s.id})">Save draft</button>
            <button class="btn primary" onclick="signVerify(${s.id})">Sign &amp; verify</button>
          </div>`
    }
    <div class="panel-actions">
      <button class="btn" onclick="downloadReport(${s.id})">Download report (PDF)</button>
    </div>
    ${s.priority === "stat" && !isFinal ? `<div class="panel-actions"><button class="btn critical" style="flex:1" onclick="logCriticalCallback('${escapeHtml(s.name)}')">Log critical value callback</button></div>` : ""}
  `;
}

function renderAll() {
  renderTriage();
  renderMetrics();
  renderSidebarCounts();
  renderWorklist();
  renderPanel();
}

function selectStudy(id) {
  selectedId = id;
  renderWorklist();
  renderPanel();
}

function updateImg(id, key, val) {
  const ps = getPanelState(id);
  ps[key] = Number(val);
  const box = document.getElementById("viewerBox");
  const s = studies.find((x) => x.id === id);
  if (box && s && s.images.length) box.style.filter = imgFilter(ps);
}

function setActiveImage(id, idx) {
  getPanelState(id).activeImage = idx;
  renderPanel();
}

async function handleUpload(evt, id) {
  const files = Array.from(evt.target.files || []);
  if (!files.length) return;
  const formData = new FormData();
  files.forEach((f) => formData.append("images", f));
  const res = await fetch(`/api/lab-orders/${id}/images`, {
    method: "POST",
    credentials: "same-origin",
    body: formData,
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.message || t('lab_queue.could_not_upload_images', 'Could not upload images.'));
    return;
  }
  await refresh(id);
  const s = studies.find((x) => x.id === id);
  if (s) {
    getPanelState(id).activeImage = s.images.length - 1;
    renderPanel();
  }
}

async function assignPath(id, value) {
  const res = await fetch(`/api/lab-orders/${id}/reassign`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value ? { userId: value } : {}),
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.message || t('lab_queue.could_not_reassign_sample', 'Could not reassign this sample.'));
    return;
  }
  await refresh(id);
}

async function setPriority(id, value) {
  const res = await fetch(`/api/lab-orders/${id}/priority`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority: value }),
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.message || t('lab_queue.could_not_update_priority', 'Could not update priority.'));
    return;
  }
  await refresh(id);
}

function insertTemplate(mod) {
  const area = document.getElementById("reportArea");
  if (!area || area.readOnly) return;
  area.value = TEMPLATES[mod];
}

async function saveDraft(id) {
  const text = document.getElementById("reportArea").value;
  const res = await fetch(`/api/lab-orders/${id}/draft`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultNotes: text }),
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.message || t('lab_queue.could_not_save_draft', 'Could not save draft.'));
    return;
  }
  await refresh(id);
}

async function signVerify(id) {
  const text = document.getElementById("reportArea").value;
  if (!text.trim() && !confirm(t('lab_queue.confirm_sign_empty_result', 'Sign & verify with an empty result?'))) return;
  const s = studies.find((x) => x.id === id);
  const res = await fetch(`/api/lab-orders/${id}/verify`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resultNotes: text }),
  });
  const data = await res.json();
  if (!data.success) {
    if (window.showToast) showToast(data.message || t('lab_queue.could_not_sign_verify', 'Could not sign & verify.'), "error");
    else alert(data.message || t('lab_queue.could_not_sign_verify', 'Could not sign & verify.'));
    return;
  }
  if (window.showToast) {
    showToast(t('lab_queue.signed_sent_result_toast', 'Result signed & sent to Dr. {doctor} — visible on their portal now.', { doctor: s ? s.ref : t('lab_queue.ordering_physician', 'the ordering physician') }), "success");
  }
  await refresh(id);
}

function logCriticalCallback(name) {
  // UI acknowledgment only — not persisted to the database.
  alert(t('lab_queue.critical_value_callback', 'Critical value callback logged for {name}. (Not stored — verbally confirm with the referring physician.)', { name }));
}

async function imageUrlToDataUrl(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downloadReport(id) {
  const s = studies.find((x) => x.id === id);
  if (!s) return;
  const area = document.getElementById("reportArea");
  if (area && !area.readOnly) s.report = area.value;
  if (!window.jspdf) {
    alert(t('lab_queue.pdf_loading', 'PDF library still loading — try again in a moment.'));
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 48;
  let y = 56;

  doc.setFillColor(91, 63, 166);
  doc.rect(0, 0, pageW, 64, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(hospitalName || "MEDISYS", margin, 34);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Department of Pathology & Laboratory Medicine", margin, 50);
  y = 92;

  doc.setTextColor(27, 36, 48);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Laboratory report", margin, y);
  y += 22;

  doc.setDrawColor(220, 226, 233);
  doc.line(margin, y, pageW - margin, y);
  y += 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const rows = [
    ["Patient name", s.name, "UHID", s.uhid],
    ["Age / Sex", `${s.age ?? "—"} / ${s.sex}`, "Sample ID", s.sid],
    ["Test panel", s.panel, "Specimen", s.specimen],
    ["Referring physician", s.ref, "Collected", new Date(s.createdAt).toLocaleString()],
    ["Reporting pathologist", s.path === "Unassigned" ? "—" : s.path, "Status", STATUS_LABEL[s.status] || s.status],
  ];
  rows.forEach((r) => {
    doc.setTextColor(141, 150, 163);
    doc.text(r[0], margin, y);
    doc.setTextColor(27, 36, 48);
    doc.text(String(r[1] || "—"), margin + 130, y);
    doc.setTextColor(141, 150, 163);
    doc.text(r[2], margin + 300, y);
    doc.setTextColor(27, 36, 48);
    doc.text(String(r[3] || "—"), margin + 400, y);
    y += 18;
  });

  y += 10;
  doc.setDrawColor(220, 226, 233);
  doc.line(margin, y, pageW - margin, y);
  y += 22;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(27, 36, 48);
  doc.text("Results & impression", margin, y);
  y += 18;

  doc.setFont("courier", "normal");
  doc.setFontSize(9.5);
  const bodyText = s.report && s.report.trim() ? s.report : "[No results entered yet]";
  const lines = doc.splitTextToSize(bodyText, pageW - margin * 2);
  doc.text(lines, margin, y);
  y += lines.length * 12 + 24;

  if (s.images.length) {
    if (y > 620) {
      doc.addPage();
      y = 60;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(27, 36, 48);
    doc.text("Specimen / slide images", margin, y);
    y += 14;

    const dataUrls = await Promise.all(s.images.map((img) => imageUrlToDataUrl(imageUrl(s.id, img.id)).catch(() => null)));

    const imgW = 230,
      imgH = 170,
      gap = 16;
    let x = margin;
    dataUrls.forEach((dataUrl, i) => {
      if (!dataUrl) return;
      if (y + imgH > 780) {
        doc.addPage();
        y = 60;
        x = margin;
      }
      const fmt = dataUrl.substring(5, dataUrl.indexOf(";")).includes("png") ? "PNG" : "JPEG";
      try {
        doc.addImage(dataUrl, fmt, x, y, imgW, imgH);
      } catch (e) {
        /* skip images jsPDF can't decode */
      }
      doc.setDrawColor(220, 226, 233);
      doc.rect(x, y, imgW, imgH);
      if (i % 2 === 0) {
        x = margin + imgW + gap;
      } else {
        x = margin;
        y += imgH + gap;
      }
    });
    if (s.images.length % 2 !== 0) y += imgH + gap;
  }
  y += 20;

  if (y > 720) {
    doc.addPage();
    y = 60;
  }
  doc.setDrawColor(220, 226, 233);
  doc.line(margin, y, margin + 180, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(141, 150, 163);
  doc.text(s.path === "Unassigned" ? "Reporting pathologist" : s.path, margin, y + 14);
  doc.text("Electronically generated report — Core5 MEDISYS", margin, 810);

  doc.save(`${s.uhid}_${s.panel.replace(/\s+/g, "_")}_lab_report.pdf`);
}

function wireStaticFilters() {
  document.querySelectorAll("[data-scope]").forEach((el) => {
    el.addEventListener("click", () => {
      filters.scope = el.dataset.scope;
      renderSidebarCounts();
      renderWorklist();
    });
  });
  document.querySelectorAll("[data-status]").forEach((el) => {
    el.addEventListener("click", () => {
      filters.status = el.dataset.status;
      renderSidebarCounts();
      renderWorklist();
    });
  });
  document.getElementById("specimenSideItems").addEventListener("click", (e) => {
    const item = e.target.closest("[data-specimen]");
    if (!item) return;
    filters.specimen = item.dataset.specimen;
    renderSidebarCounts();
    renderWorklist();
  });
  document.getElementById("search").addEventListener("input", (e) => {
    filters.q = e.target.value;
    renderWorklist();
  });
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    filters.sort = e.target.value;
    renderWorklist();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const user = await guardSession();
  if (!user) return;
  wireLogout();
  const ok = await loadProfile();
  if (!ok) return;
  await Promise.all([loadStaffOptions(), loadStudies()]);
  wireStaticFilters();
  if (studies.length) selectedId = studies[0].id;
  renderAll();

  if (window.MEDISYS_RT) {
    const knownStudyIds = new Set(studies.map((s) => s.id));
    MEDISYS_RT.on("lab_orders", async () => {
      const hadStudiesBefore = knownStudyIds.size > 0;
      await loadStudies();
      studies.forEach((s) => {
        if (!knownStudyIds.has(s.id)) {
          knownStudyIds.add(s.id);
          if (hadStudiesBefore && s.status === "pending") showToast(t('lab_queue.new_order_toast', 'New order: {test} for {patient}', { test: s.test_name || t('lab_queue.test_fallback', 'test'), patient: s.patient_name || s.patient_uhid }), "success");
        }
      });
      renderAll();
    });
  }

  window.addEventListener("i18n:languageChanged", () => {
    renderAll();
    if (window.i18n) window.i18n.applyTranslations();
  });
});
