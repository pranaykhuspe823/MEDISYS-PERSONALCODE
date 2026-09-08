(function () {
  let hospitalName = "";
  let patientName = "";
  let patientUhid = "";
  let latestData = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function formatMoney(n) {
    return "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
  }

  async function loadProfile() {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    hospitalName = data.profile.hospitalName || "MEDISYS";
    patientName = data.profile.fullName || patientUhid;
  }

  // ---------- PDF generation ----------

  function pdfLetterhead(doc, title) {
    const pageW = doc.internal.pageSize.getWidth();
    doc.setFillColor(15, 110, 86);
    doc.rect(0, 0, pageW, 64, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text(hospitalName, 48, 34);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text(title, 48, 50);
    doc.setTextColor(20, 30, 28);
    return 92;
  }

  function pdfPatientRow(doc, y, margin, extraPairs) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const rows = [["Patient", patientName, "UHID", patientUhid]].concat(extraPairs || []);
    rows.forEach((r) => {
      doc.setTextColor(139, 154, 150);
      doc.text(r[0], margin, y);
      doc.setTextColor(20, 30, 28);
      doc.text(String(r[1] || "—"), margin + 100, y);
      if (r[2]) {
        doc.setTextColor(139, 154, 150);
        doc.text(r[2], margin + 300, y);
        doc.setTextColor(20, 30, 28);
        doc.text(String(r[3] || "—"), margin + 380, y);
      }
      y += 18;
    });
    return y;
  }

  function pdfItemsTable(doc, y, margin, pageW, columns, rows) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(20, 30, 28);
    let x = margin;
    columns.forEach((c) => {
      doc.text(c.label, x, y);
      x += c.width;
    });
    y += 6;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    rows.forEach((row) => {
      x = margin;
      columns.forEach((c) => {
        doc.text(String(row[c.key] ?? "—"), x, y);
        x += c.width;
      });
      y += 16;
    });
    return y;
  }

  function pdfFooter(doc) {
    doc.setFontSize(8.5);
    doc.setTextColor(139, 154, 150);
    doc.text("Electronically generated — Core5 MEDISYS Patient Portal", 48, 810);
  }

  function downloadBillPdf(bill) {
    if (!window.jspdf) {
      alert(t('lab_queue.pdf_loading', 'PDF library still loading — try again in a moment.'));
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = pdfLetterhead(doc, "Hospital Bill");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Bill ${bill.bill_no}`, margin, y);
    y += 22;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    y = pdfPatientRow(doc, y, margin, [
      ["Department", bill.department, "Bill date", new Date(bill.bill_date).toLocaleDateString()],
      ["Status", bill.status, "Balance", formatMoney(bill.balance_amount)],
    ]);
    y += 14;

    if (bill.items && bill.items.length) {
      y = pdfItemsTable(
        doc,
        y,
        margin,
        pageW,
        [
          { key: "description", label: "Item", width: 260 },
          { key: "qty", label: "Qty", width: 60 },
          { key: "rate", label: "Rate", width: 90 },
          { key: "amount", label: "Amount", width: 90 },
        ],
        bill.items.map((it) => ({
          description: it.description,
          qty: it.qty,
          rate: formatMoney(it.rate),
          amount: formatMoney(it.amount),
        }))
      );
      y += 10;
    }

    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 20;
    doc.setFont("helvetica", "bold");
    [
      ["Subtotal", bill.subtotal],
      ["Discount", bill.discount_amount],
      ["Tax", bill.tax_amount],
      ["Total", bill.total_amount],
      ["Paid", bill.paid_amount],
      ["Balance", bill.balance_amount],
    ].forEach(([label, amount]) => {
      doc.setTextColor(139, 154, 150);
      doc.text(label, margin, y);
      doc.setTextColor(20, 30, 28);
      doc.text(formatMoney(amount), margin + 100, y);
      y += 16;
    });

    pdfFooter(doc);
    doc.save(`${bill.bill_no.replace(/[\\/]/g, "-")}.pdf`);
  }

  function downloadPharmacyInvoicePdf(inv) {
    if (!window.jspdf) {
      alert(t('lab_queue.pdf_loading', 'PDF library still loading — try again in a moment.'));
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = pdfLetterhead(doc, "Pharmacy Invoice");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Invoice ${inv.invoice_number}`, margin, y);
    y += 22;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    y = pdfPatientRow(doc, y, margin, [
      ["Date", new Date(inv.created_at).toLocaleString(), "Status", inv.payment_status],
    ]);
    y += 14;

    if (inv.medicines && inv.medicines.length) {
      y = pdfItemsTable(
        doc,
        y,
        margin,
        pageW,
        [
          { key: "medicineName", label: "Medicine", width: 170 },
          { key: "dosage", label: "Dosage", width: 150 },
          { key: "duration", label: "Duration", width: 80 },
          { key: "foodInstruction", label: "Food", width: 100 },
        ],
        inv.medicines
      );
      y += 10;
      doc.setDrawColor(220, 228, 225);
      doc.line(margin, y, pageW - margin, y);
      y += 20;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(139, 154, 150);
    doc.text("Total", margin, y);
    doc.setTextColor(20, 30, 28);
    doc.text(formatMoney(inv.total_amount), margin + 100, y);

    pdfFooter(doc);
    doc.save(`${inv.invoice_number}.pdf`);
  }

  function downloadOutstandingStatement(charges, total) {
    if (!window.jspdf) {
      alert(t('lab_queue.pdf_loading', 'PDF library still loading — try again in a moment.'));
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48;
    let y = pdfLetterhead(doc, "Outstanding Charges Statement");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Statement of Dues", margin, y);
    y += 22;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 18;

    y = pdfPatientRow(doc, y, margin, [["As of", new Date().toLocaleDateString()]]);
    y += 14;

    y = pdfItemsTable(
      doc,
      y,
      margin,
      pageW,
      [
        { key: "description", label: "Description", width: 220 },
        { key: "department", label: "Department", width: 120 },
        { key: "amount", label: "Amount", width: 100 },
        { key: "date", label: "Charged", width: 100 },
      ],
      charges.map((c) => ({
        description: c.description,
        department: c.department,
        amount: formatMoney(c.rate),
        date: new Date(c.created_at).toLocaleDateString(),
      }))
    );
    y += 10;
    doc.setDrawColor(220, 228, 225);
    doc.line(margin, y, pageW - margin, y);
    y += 20;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(139, 154, 150);
    doc.text("Total Due", margin, y);
    doc.setTextColor(20, 30, 28);
    doc.text(formatMoney(total), margin + 100, y);

    pdfFooter(doc);
    doc.save(`Outstanding_Statement_${patientUhid}.pdf`);
  }

  // ---------- Rendering ----------

  async function loadBills() {
    const res = await fetch("/api/patients/me/bills", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;
    latestData = data;

    const outstandingBody = document.getElementById("outstandingTableBody");
    const outstandingEmpty = document.getElementById("outstandingEmptyState");
    const downloadStatementBtn = document.getElementById("downloadStatementBtn");
    document.getElementById("outstandingTotal").textContent =
      data.outstandingCharges.length ? formatMoney(data.outstandingTotal) + " " + t("bills.due", "due") : "";
    if (data.outstandingCharges.length === 0) {
      outstandingBody.innerHTML = "";
      outstandingEmpty.hidden = false;
      downloadStatementBtn.hidden = true;
    } else {
      outstandingEmpty.hidden = true;
      downloadStatementBtn.hidden = false;
      outstandingBody.innerHTML = data.outstandingCharges
        .map(
          (c) => `<tr>
            <td>${escapeHtml(c.description)}</td>
            <td>${escapeHtml(c.department)}</td>
            <td>${formatMoney(c.rate)}</td>
            <td>${escapeHtml(new Date(c.created_at).toLocaleDateString())}</td>
          </tr>`
        )
        .join("");
    }
    downloadStatementBtn.onclick = () => downloadOutstandingStatement(data.outstandingCharges, data.outstandingTotal);

    const billsBody = document.getElementById("billsTableBody");
    const billsEmpty = document.getElementById("billsEmptyState");
    if (data.bills.length === 0) {
      billsBody.innerHTML = "";
      billsEmpty.hidden = false;
    } else {
      billsEmpty.hidden = true;
      billsBody.innerHTML = data.bills
        .map((b) => {
          const isPaid = b.status === "Paid";
          const statusText = isPaid ? t("billing.status_paid", "Paid") : t("billing.status_pending", b.status || "Pending");
          return `<tr>
            <td>${escapeHtml(b.bill_no)}</td>
            <td>${escapeHtml(new Date(b.bill_date).toLocaleDateString())}</td>
            <td>${escapeHtml(b.department)}</td>
            <td>${formatMoney(b.total_amount)}</td>
            <td>${formatMoney(b.paid_amount)}</td>
            <td>${formatMoney(b.balance_amount)}</td>
            <td><span class="queue-status ${isPaid ? "completed" : "waiting"}">${escapeHtml(statusText)}</span></td>
            <td><button type="button" class="wizard-suggest-btn download-bill-btn" data-id="${b.id}">${t("bills.download", "Download")}</button></td>
          </tr>`;
        })
        .join("");
      billsBody.querySelectorAll(".download-bill-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const bill = data.bills.find((b) => String(b.id) === btn.dataset.id);
          if (bill) downloadBillPdf(bill);
        });
      });
    }

    const pharmBody = document.getElementById("pharmacyInvoicesTableBody");
    const pharmEmpty = document.getElementById("pharmacyInvoicesEmptyState");
    if (data.pharmacyInvoices.length === 0) {
      pharmBody.innerHTML = "";
      pharmEmpty.hidden = false;
    } else {
      pharmEmpty.hidden = true;
      pharmBody.innerHTML = data.pharmacyInvoices
        .map((i) => {
          const isPaid = i.payment_status === "Paid";
          const statusText = isPaid ? t("billing.status_paid", "Paid") : t("billing.status_pending", i.payment_status || "Pending");
          return `<tr>
            <td>${escapeHtml(i.invoice_number)}</td>
            <td>${escapeHtml(i.item_count)}</td>
            <td>${formatMoney(i.total_amount)}</td>
            <td><span class="queue-status ${isPaid ? "completed" : "waiting"}">${escapeHtml(statusText)}</span></td>
            <td>${escapeHtml(new Date(i.created_at).toLocaleDateString())}</td>
            <td><button type="button" class="wizard-suggest-btn download-invoice-btn" data-id="${i.id}">${t("bills.download", "Download")}</button></td>
          </tr>`;
        })
        .join("");
      pharmBody.querySelectorAll(".download-invoice-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const inv = data.pharmacyInvoices.find((i) => String(i.id) === btn.dataset.id);
          if (inv) downloadPharmacyInvoicePdf(inv);
        });
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    await loadProfile();
    loadBills();
    if (window.MEDISYS_RT) {
      ["billing_bills", "billing_payments", "billing_patients", "pharmacy_invoices"].forEach((resource) =>
        MEDISYS_RT.on(resource, loadBills)
      );
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadBills();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
