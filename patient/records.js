(function () {
  // Was missing entirely — t(...) is called below (in both PDF download
  // functions) but this file never defined it, unlike every other page.
  // Only bites when window.jspdf isn't loaded yet (a real but narrow
  // ReferenceError), found while adding the prescription-PDF feature.
  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === "function") {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }

  const DECISION_LABELS = { prescribe: "Prescription", order_tests: "Tests Ordered", admit: "Admission Requested" };
  function formatDecisionLabel(decision) {
    return (
      String(decision || "")
        .split(",")
        .map((d) => DECISION_LABELS[d.trim()] || d.trim())
        .filter(Boolean)
        .join(" + ") || "Consultation"
    );
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

  let hospitalName = "";
  let patientName = "";
  let patientUhid = "";
  let latestRecords = null;

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

  async function downloadLabReportPdf(order) {
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
    doc.text(`Department of ${order.category || order.department || "Diagnostics"}`, margin, 50);
    y = 92;

    doc.setTextColor(20, 30, 28);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Diagnostic report", margin, y);
    y += 22;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const rows = [
      ["Patient", patientName, "UHID", patientUhid],
      ["Test", order.test_name, "Category", order.category || order.department || "—"],
      ["Referring physician", order.doctor_name || "—", "Ordered", new Date(order.created_at).toLocaleString()],
      ["Reported by", order.verified_by_name || "—", "Verified", order.verified_at ? new Date(order.verified_at).toLocaleString() : "—"],
    ];
    rows.forEach((r) => {
      doc.setTextColor(139, 154, 150);
      doc.text(r[0], margin, y);
      doc.setTextColor(20, 30, 28);
      doc.text(String(r[1] || "—"), margin + 130, y);
      doc.setTextColor(139, 154, 150);
      doc.text(r[2], margin + 300, y);
      doc.setTextColor(20, 30, 28);
      doc.text(String(r[3] || "—"), margin + 380, y);
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
    const bodyText = order.result_notes && order.result_notes.trim() ? order.result_notes : "[No notes on file]";
    const lines = doc.splitTextToSize(bodyText, pageW - margin * 2);
    doc.text(lines, margin, y);
    y += lines.length * 13 + 24;

    if (order.images && order.images.length) {
      if (y > 620) {
        doc.addPage();
        y = 60;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text("Images", margin, y);
      y += 14;

      const dataUrls = await Promise.all(
        order.images.map((img) => imageUrlToDataUrl(`/api/lab-orders/${order.id}/images/${img.id}`).catch(() => null))
      );
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
        if (i % 2 === 0) x = margin + imgW + gap;
        else {
          x = margin;
          y += imgH + gap;
        }
      });
    }

    doc.setFontSize(8.5);
    doc.setTextColor(139, 154, 150);
    doc.text("Electronically generated — Core5 MEDISYS Patient Portal", margin, 810);
    doc.save(`${patientUhid}_${order.test_name.replace(/\s+/g, "_")}.pdf`);
  }

  // One PDF per visit/consultation, listing every medicine prescribed at
  // that visit — built from the saved database record (not live form
  // state, unlike the doctor's own "Download Consultation PDF"), so it's
  // exactly what actually got prescribed, even months later.
  async function downloadPrescriptionPdf(consultation) {
    if (!window.jspdf) {
      alert(t("lab_queue.pdf_loading", "PDF library still loading — try again in a moment."));
      return;
    }
    const res = await fetch("/api/patients/me/prescriptions", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    const meds = data.prescriptions.filter((p) => String(p.opd_visit_id) === String(consultation.opd_visit_id));
    if (meds.length === 0) {
      alert(t("prescriptions.none_for_visit", "No medicines on file for this visit."));
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
    doc.text("Prescription", margin, 50);
    y = 92;

    doc.setTextColor(20, 30, 28);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Prescription", margin, y);
    y += 22;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const rows = [
      ["Patient", patientName, "UHID", patientUhid],
      ["Doctor", `Dr. ${consultation.doctor_name || meds[0].doctor_name || "—"}`, "Date", new Date(consultation.created_at).toLocaleString()],
    ];
    if (consultation.diagnosis) rows.push(["Diagnosis", consultation.diagnosis, "", ""]);
    rows.forEach((r) => {
      doc.setTextColor(139, 154, 150);
      doc.text(r[0], margin, y);
      doc.setTextColor(20, 30, 28);
      doc.text(String(r[1] || "—"), margin + 130, y);
      if (r[2]) {
        doc.setTextColor(139, 154, 150);
        doc.text(r[2], margin + 300, y);
        doc.setTextColor(20, 30, 28);
        doc.text(String(r[3] || "—"), margin + 380, y);
      }
      y += 18;
    });

    y += 10;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 22;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20, 30, 28);
    doc.text("Medicines", margin, y);
    y += 6;

    const colX = { name: margin, dosage: margin + 190, duration: margin + 330, food: margin + 400 };
    y += 16;
    doc.setFontSize(9);
    doc.setTextColor(139, 154, 150);
    doc.text("MEDICINE", colX.name, y);
    doc.text("DOSAGE", colX.dosage, y);
    doc.text("DURATION", colX.duration, y);
    doc.text("INSTRUCTION", colX.food, y);
    y += 8;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 16;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    meds.forEach((m) => {
      if (y > 780) {
        doc.addPage();
        y = 60;
      }
      doc.setTextColor(20, 30, 28);
      const nameLines = doc.splitTextToSize(m.medicine_name, 180);
      doc.text(nameLines, colX.name, y);
      doc.text(m.dosage || "—", colX.dosage, y);
      doc.text(`${m.duration || "—"} day(s)`, colX.duration, y);
      doc.text(m.food_instruction || "—", colX.food, y);
      y += Math.max(nameLines.length, 1) * 13 + 8;
    });

    doc.setFontSize(8.5);
    doc.setTextColor(139, 154, 150);
    doc.text("Electronically generated — Core5 MEDISYS Patient Portal", margin, 810);
    doc.save(`${patientUhid}_Prescription_${new Date(consultation.created_at).toISOString().slice(0, 10)}.pdf`);
  }

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "patient") {
      window.location.href = "../index";
      return null;
    }
    patientUhid = data.user.userId;
    document.getElementById("portalUser").textContent = data.user.userId;
    return data.user;
  }

  async function loadProfile() {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    hospitalName = data.profile.hospitalName || "MEDISYS";
    patientName = data.profile.fullName || patientUhid;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
  }

  async function loadRecords() {
    const res = await fetch("/api/patients/me/records", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    const r = data.records;
    latestRecords = r;

    document.getElementById("consultationsFeed").innerHTML =
      r.consultations
        .map((c) => {
          const hasPrescription = String(c.decision || "").split(",").some((d) => d.trim() === "prescribe");
          return `<div class="chart-feed-item">
            <strong>${escapeHtml(formatDecisionLabel(c.decision))}</strong> — ${escapeHtml(c.diagnosis || c.symptoms || "—")}
            ${c.notes ? `<div>${escapeHtml(c.notes)}</div>` : ""}
            <div class="chart-feed-meta">
              Dr. ${escapeHtml(c.doctor_name || "—")} &middot; ${escapeHtml(new Date(c.created_at).toLocaleString())}
              ${hasPrescription ? ` &middot; <button type="button" class="wizard-suggest-btn download-prescription-btn" data-visit-id="${escapeHtml(c.opd_visit_id)}" style="padding: 2px 10px; font-size: 11px;">Download Prescription</button>` : ""}
            </div>
          </div>`;
        })
        .join("") || `<p class="wizard-hint">No consultations recorded yet.</p>`;

    document.querySelectorAll(".download-prescription-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const consultation = latestRecords.consultations.find((c) => String(c.opd_visit_id) === btn.dataset.visitId);
        if (consultation) downloadPrescriptionPdf(consultation);
      });
    });

    document.getElementById("labFeed").innerHTML =
      r.labOrders
        .map((o) => {
          const DONE_STATUSES = ["completed", "verified"];
          const isDone = DONE_STATUSES.includes(o.status);
          const statusLabel =
            { pending: "Ordered", in_progress: "In Progress", reported: "Reporting", completed: "Ready", verified: "Ready" }[
              o.status
            ] || o.status;
          const statusClass = isDone ? "completed" : o.status === "in_progress" || o.status === "reported" ? "in-consultation" : "waiting";
          const fileLink = o.result_file_name
            ? `<a href="/api/lab-orders/${o.id}/result-file" target="_blank" rel="noopener" class="file-view-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                ${escapeHtml(o.result_file_name)}
              </a>`
            : "";
          const imageLinks = (o.images || [])
            .map(
              (img) =>
                `<a href="/api/lab-orders/${o.id}/images/${img.id}" target="_blank" rel="noopener" class="file-view-link">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                  ${escapeHtml(img.fileName)}
                </a>`
            )
            .join(" ");
          return `<div class="chart-feed-item">
            <strong>${escapeHtml(o.test_name)}</strong> (${escapeHtml(o.category || o.department || "")}) —
            <span class="queue-status ${statusClass}">${escapeHtml(statusLabel)}</span>
            ${isDone ? `<div>${escapeHtml(o.result_notes || "No notes")}${fileLink ? " &middot; " + fileLink : ""}${imageLinks ? " &middot; " + imageLinks : ""}</div>` : ""}
            <div class="chart-feed-meta">
              Ordered ${escapeHtml(new Date(o.created_at).toLocaleString())}
              ${isDone ? ` &middot; <button type="button" class="wizard-suggest-btn download-lab-btn" data-id="${o.id}" style="padding: 2px 10px; font-size: 11px;">Download Report</button>` : ""}
            </div>
          </div>`;
        })
        .join("") || `<p class="wizard-hint">No lab or radiology orders yet.</p>`;

    document.querySelectorAll(".download-lab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const order = latestRecords.labOrders.find((o) => String(o.id) === btn.dataset.id);
        if (order) downloadLabReportPdf(order);
      });
    });

    document.getElementById("vitalsFeed").innerHTML =
      r.vitals
        .map(
          (v) => `<div class="chart-feed-item">
            BP ${escapeHtml(v.bp || "—")} &middot; Temp ${escapeHtml(v.temperature || "—")} &middot; Weight ${escapeHtml(v.weight || "—")} &middot; SpO2 ${escapeHtml(v.spo2 || "—")}
            <div class="chart-feed-meta">${escapeHtml(new Date(v.recorded_at).toLocaleString())}</div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">No vitals recorded yet.</p>`;

    document.getElementById("admissionsFeed").innerHTML =
      r.admissions
        .map(
          (a) => `<div class="chart-feed-item">
            Admission (${escapeHtml(a.status)}) — ${escapeHtml(a.ward_name || "—")} ${a.bed_number ? "Bed " + escapeHtml(a.bed_number) : ""}
            <div class="chart-feed-meta">
              Dr. ${escapeHtml(a.doctor_name || "—")} &middot; Requested ${escapeHtml(new Date(a.created_at).toLocaleString())}
              ${a.discharged_at ? " &middot; Discharged " + escapeHtml(new Date(a.discharged_at).toLocaleString()) : ""}
            </div>
          </div>`
        )
        .join("") || `<p class="wizard-hint">No admissions on file.</p>`;
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    await loadProfile();
    if (window.MEDISYS_RT) {
      ["consultations", "lab_orders", "vitals", "ipd_admissions"].forEach((resource) => MEDISYS_RT.on(resource, loadRecords));
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadRecords();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
