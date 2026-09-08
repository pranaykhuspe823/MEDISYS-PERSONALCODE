const TEMPLATES = {
  "CT": "TECHNIQUE: Plain CT, axial sections.\n\nFINDINGS:\nLung parenchyma: \nMediastinum: \nPleura: \nBones: \n\nIMPRESSION:\n",
  "MRI": "TECHNIQUE: MRI, T1/T2/FLAIR sequences.\n\nFINDINGS:\nParenchyma: \nVentricular system: \nExtra-axial spaces: \n\nIMPRESSION:\n",
  "X-Ray": "TECHNIQUE: Plain radiograph, single view.\n\nFINDINGS:\nLung fields: \nCardiac silhouette: \nBony thorax: \n\nIMPRESSION:\n",
  "USG": "TECHNIQUE: Real-time grey-scale ultrasound.\n\nFINDINGS:\nOrgan echotexture: \nNo free fluid.\n\nIMPRESSION:\n",
  "Other": "TECHNIQUE: \n\nFINDINGS:\n\n\nIMPRESSION:\n",
};

const MODALITIES = ["CT", "MRI", "X-Ray", "USG", "Other"];
const PRIORITY_LABEL = { routine: "Routine", urgent: "Urgent", stat: "STAT" };
const STATUS_LABEL = { pending: "Pending", in_progress: "In progress", reported: "Reported", verified: "Verified" };

let currentUser = null;
let hospitalName = "";
let staffOptions = [];
let studies = [];
let filters = { scope: "all", modality: "all", status: "all", q: "", sort: "time" };
let selectedId = null;
let panelState = {}; // per-study transient viewer state: { activeImage, brightness, contrast }

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

function deriveModality(testName) {
  const n = (testName || "").toLowerCase();
  if (n.includes("ct")) return "CT";
  if (n.includes("mri")) return "MRI";
  if (n.includes("x-ray") || n.includes("xr")) return "X-Ray";
  if (n.includes("ultrasound") || n.includes("usg")) return "USG";
  return "Other";
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

function wlFilter(ps) {
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
  if (!details || details.designation !== "Radiologist") {
    // Not a radiologist — send pathology/lab staff to the plain queue instead.
    window.location.href = "lab-queue";
    return false;
  }
  hospitalName = hName;
  document.getElementById("hospitalNameLabel").textContent = hName || "";
  document.getElementById("portalUser").textContent = `${fullName || currentUser.userId} · Radiologist`;
  document.getElementById("portalAvatar").textContent = initials(fullName);
  return true;
}

async function loadStaffOptions() {
  const res = await fetch("/api/lab-orders/staff?department=Radiology", { credentials: "same-origin" });
  const data = await res.json();
  staffOptions = data.success ? data.staff : [];
}

async function loadStudies() {
  const res = await fetch("/api/lab-orders?department=Radiology", { credentials: "same-origin" });
  const data = await res.json();
  if (!data.success) {
    studies = [];
    return;
  }
  studies = data.orders.map((o) => ({
    id: o.id,
    name: o.patient_name || o.patient_uhid,
    uhid: o.patient_uhid,
    acc: `LO-${String(o.id).padStart(5, "0")}`,
    age: computeAge(o.dob),
    sex: o.gender || "—",
    modality: deriveModality(o.test_name),
    study: o.test_name || "—",
    ref: o.doctor_name || o.doctor_user_id,
    createdAt: o.created_at,
    priority: o.priority || "routine",
    status: o.status,
    assignedUserId: o.assigned_to,
    rad: o.assigned_to_name || (o.assigned_to ? o.assigned_to : "Unassigned"),
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

function filteredStudies() {
  let list = studies.filter((s) => {
    const matchMod = filters.modality === "all" || s.modality === filters.modality;
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
      s.acc.toLowerCase().includes(q);
    return matchMod && matchStat && matchScope && matchQ;
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
    el.innerHTML = `<div class="triage-empty">No studies in the queue yet.</div>`;
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
  const studiesToday = studies.filter((s) => new Date(s.createdAt).toDateString() === todayStr).length;
  const openStudies = studies.filter((s) => s.status !== "verified");
  const slaBreach = openStudies.filter((s) => {
    if (!s.turnaroundHours) return false;
    return (now - new Date(s.createdAt).getTime()) / 3600000 > s.turnaroundHours;
  }).length;
  const statOpen = openStudies.filter((s) => s.priority === "stat").length;
  const verifiedToday = studies.filter((s) => s.verifiedAt && new Date(s.verifiedAt).toDateString() === todayStr);
  let avgTurnaround = "—";
  if (verifiedToday.length) {
    const totalMin = verifiedToday.reduce(
      (sum, s) => sum + (new Date(s.verifiedAt) - new Date(s.createdAt)) / 60000,
      0
    );
    avgTurnaround = Math.round(totalMin / verifiedToday.length) + "m";
  }
  document.getElementById("metricsRow").innerHTML = `
    <div class="metric"><div class="label">Studies today</div><div class="value">${studiesToday}</div><div class="delta">${studies.length} total in queue</div></div>
    <div class="metric"><div class="label">Pending reports</div><div class="value">${openStudies.length}</div><div class="delta ${slaBreach ? "down" : ""}">${slaBreach} breaching SLA</div></div>
    <div class="metric"><div class="label">STAT priority open</div><div class="value">${statOpen}</div><div class="delta ${statOpen ? "down" : ""}">${statOpen ? "Needs immediate attention" : "None open"}</div></div>
    <div class="metric"><div class="label">Avg turnaround, verified today</div><div class="value">${avgTurnaround}</div><div class="delta">${verifiedToday.length} verified today</div></div>
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

  const counts = {};
  MODALITIES.forEach((m) => (counts[m] = 0));
  studies.forEach((s) => {
    counts[s.modality] = (counts[s.modality] || 0) + 1;
  });
  document.getElementById("modalitySideItems").innerHTML =
    `<div class="side-item ${filters.modality === "all" ? "active" : ""}" data-modality="all">All modalities <span class="count">${studies.length}</span></div>` +
    MODALITIES.map(
      (m) =>
        `<div class="side-item ${filters.modality === m ? "active" : ""}" data-modality="${m}">${m} <span class="count">${counts[m]}</span></div>`
    ).join("");

  document.querySelectorAll("[data-scope]").forEach((el) => el.classList.toggle("active", el.dataset.scope === filters.scope));
  document.querySelectorAll("[data-status]").forEach((el) => el.classList.toggle("active", el.dataset.status === filters.status));
}

function renderWorklist() {
  const list = filteredStudies();
  document.getElementById("countLabel").textContent = list.length + " studies";
  const body = document.getElementById("worklistBody");
  if (list.length === 0) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty">No studies match these filters.</div></td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((s) => {
      const priorityLabel = PRIORITY_LABEL[s.priority] || s.priority;
      const statusLabel = STATUS_LABEL[s.status] || s.status;
      return `
    <tr class="${s.id === selectedId ? "selected" : ""}" onclick="selectStudy(${s.id})">
      <td><div class="pname">${escapeHtml(s.name)}</div><div class="puhid">${escapeHtml(s.uhid)}</div></td>
      <td>${escapeHtml(s.study)}</td>
      <td><span class="badge ${priorityLabel}">${priorityLabel}</span></td>
      <td><div class="status-pill"><span class="dot ${s.status}"></span>${statusLabel}</div></td>
      <td style="font-size:12px; color:var(--ink-soft);">${escapeHtml(s.rad)}</td>
    </tr>`;
    })
    .join("");
}

function renderPanel() {
  const s = studies.find((x) => x.id === selectedId);
  const panel = document.getElementById("panel");
  if (!s) {
    panel.innerHTML = `<div class="empty">Select a study to view details.</div>`;
    return;
  }
  const ps = getPanelState(s.id);
  if (ps.activeImage >= s.images.length) ps.activeImage = Math.max(0, s.images.length - 1);

  const radOptions =
    `<option value="" ${!s.assignedUserId ? "selected" : ""}>Unassigned</option>` +
    staffOptions
      .map((r) => `<option value="${r.userId}" ${r.userId === s.assignedUserId ? "selected" : ""}>${escapeHtml(r.fullName)}</option>`)
      .join("");
  const priorityOptions = Object.keys(PRIORITY_LABEL)
    .map((p) => `<option value="${p}" ${p === s.priority ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`)
    .join("");
  const chips = Object.keys(TEMPLATES)
    .map((m) => `<div class="chip" onclick="insertTemplate('${m}')">${m} template</div>`)
    .join("");

  const activeImg = s.images[ps.activeImage];
  const isFinal = s.status === "verified";

  panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-avatar">${initials(s.name)}</div>
      <div>
        <div class="panel-name">${escapeHtml(s.name)}</div>
        <div class="panel-meta">${escapeHtml(s.uhid)} · ${s.age ?? "—"}${s.sex !== "—" ? s.sex[0] : ""} · ${s.acc}</div>
      </div>
    </div>

    <div class="viewer" id="viewerBox" style="${activeImg ? `background-image:url('${imageUrl(s.id, activeImg.id)}'); filter:${wlFilter(ps)};` : ""}">
      ${activeImg ? "" : '<div class="crosshair"></div>'}
      <span class="tag">${s.modality} · Image ${s.images.length ? ps.activeImage + 1 + "/" + s.images.length : "0/0"}</span>
      <span class="tag br">${activeImg ? "Adjustable" : "No image"}</span>
      ${activeImg ? "" : `<div class="center-icon">NO IMAGE UPLOADED<br>${escapeHtml(s.study)}</div>`}
      <input type="file" id="fileInput" accept="image/*" multiple style="display:none" onchange="handleUpload(event, ${s.id})">
      <div class="upload-btn" onclick="document.getElementById('fileInput').click()">+ Upload image</div>
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
    <div class="wl-controls">
      <div class="wl-col"><label>Brightness</label><input type="range" min="40" max="180" value="${ps.brightness}" oninput="updateFilter(${s.id},'brightness',this.value)"></div>
      <div class="wl-col"><label>Contrast</label><input type="range" min="40" max="200" value="${ps.contrast}" oninput="updateFilter(${s.id},'contrast',this.value)"></div>
    </div>

    <div class="info-grid">
      <div class="info-row"><span class="k">Study</span><span class="v">${escapeHtml(s.study)}</span></div>
      <div class="info-row"><span class="k">Referring physician</span><span class="v">${escapeHtml(s.ref)}</span></div>
      <div class="info-row"><span class="k">Received</span><span class="v">${escapeHtml(new Date(s.createdAt).toLocaleString())}</span></div>
    </div>

    <div class="field-label">Priority</div>
    <select class="full" ${isFinal ? "disabled" : ""} onchange="setPriority(${s.id}, this.value)">${priorityOptions}</select>

    <div class="field-label">Assign radiologist</div>
    <select class="full" ${isFinal ? "disabled" : ""} onchange="assignRad(${s.id}, this.value)">${radOptions}</select>

    <div class="field-label">Report — insert template</div>
    <div class="template-chips">${chips}</div>
    <textarea class="full" id="reportArea" ${isFinal ? "readonly" : ""} placeholder="Findings and impression...">${escapeHtml(s.report)}</textarea>

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
    ${s.priority === "stat" && !isFinal ? `<div class="panel-actions"><button class="btn critical" style="flex:1" onclick="logCriticalCallback('${escapeHtml(s.name)}')">Log critical callback</button></div>` : ""}
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

function updateFilter(id, key, val) {
  const ps = getPanelState(id);
  ps[key] = Number(val);
  const box = document.getElementById("viewerBox");
  const s = studies.find((x) => x.id === id);
  if (box && s && s.images.length) box.style.filter = wlFilter(ps);
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

async function assignRad(id, value) {
  const res = await fetch(`/api/lab-orders/${id}/reassign`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value ? { userId: value } : {}),
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.message || t('lab_queue.could_not_reassign_study', 'Could not reassign this study.'));
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
  if (!text.trim() && !confirm(t('lab_queue.confirm_sign_empty_report', 'Sign & verify with an empty report?'))) return;
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
    showToast(t('lab_queue.signed_sent_report_toast', 'Report signed & sent to Dr. {doctor} — visible on their portal now.', { doctor: s ? s.ref : t('lab_queue.ordering_physician', 'the ordering physician') }), "success");
  }
  await refresh(id);
}

function logCriticalCallback(name) {
  // UI acknowledgment only — not persisted to the database.
  alert(t('lab_queue.critical_result_callback', 'Critical result callback logged for {name}. (Not stored — verbally confirm with the referring physician.)', { name }));
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

  doc.setFillColor(15, 110, 86);
  doc.rect(0, 0, pageW, 64, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(hospitalName || "MEDISYS", margin, 34);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text("Department of Radiology", margin, 50);
  y = 92;

  doc.setTextColor(20, 30, 28);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text("Radiology report", margin, y);
  y += 22;

  doc.setDrawColor(220, 228, 225);
  doc.line(margin, y, pageW - margin, y);
  y += 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const rows = [
    ["Patient name", s.name, "UHID", s.uhid],
    ["Age / Sex", `${s.age ?? "—"} / ${s.sex}`, "Accession no.", s.acc],
    ["Study", s.study, "Modality", s.modality],
    ["Referring physician", s.ref, "Received", new Date(s.createdAt).toLocaleString()],
    ["Reporting radiologist", s.rad === "Unassigned" ? "—" : s.rad, "Status", STATUS_LABEL[s.status] || s.status],
  ];
  rows.forEach((r) => {
    doc.setTextColor(139, 154, 150);
    doc.text(r[0], margin, y);
    doc.setTextColor(20, 30, 28);
    doc.text(String(r[1] || "—"), margin + 130, y);
    doc.setTextColor(139, 154, 150);
    doc.text(r[2], margin + 300, y);
    doc.setTextColor(20, 30, 28);
    doc.text(String(r[3] || "—"), margin + 400, y);
    y += 18;
  });

  y += 10;
  doc.setDrawColor(220, 228, 225);
  doc.line(margin, y, pageW - margin, y);
  y += 22;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 30, 28);
  doc.text("Findings & impression", margin, y);
  y += 18;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  const bodyText = s.report && s.report.trim() ? s.report : "[No findings entered yet]";
  const lines = doc.splitTextToSize(bodyText, pageW - margin * 2);
  doc.text(lines, margin, y);
  y += lines.length * 13 + 24;

  if (s.images.length) {
    if (y > 620) {
      doc.addPage();
      y = 60;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20, 30, 28);
    doc.text("Study images", margin, y);
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
      doc.setDrawColor(220, 228, 225);
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
  doc.setDrawColor(220, 228, 225);
  doc.line(margin, y, margin + 180, y);
  doc.setFontSize(9);
  doc.setTextColor(139, 154, 150);
  doc.text(s.rad === "Unassigned" ? "Reporting radiologist" : s.rad, margin, y + 14);
  doc.text("Electronically generated report — Core5 MEDISYS", margin, 810);

  doc.save(`${s.uhid}_${s.study.replace(/\s+/g, "_")}_report.pdf`);
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
  document.getElementById("modalitySideItems").addEventListener("click", (e) => {
    const item = e.target.closest("[data-modality]");
    if (!item) return;
    filters.modality = item.dataset.modality;
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
          if (hadStudiesBefore && s.status === "pending") showToast(t('lab_queue.new_order_toast', 'New order: {test} for {patient}', { test: s.test_name || t('lab_queue.study_fallback', 'study'), patient: s.patient_name || s.patient_uhid }), "success");
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
