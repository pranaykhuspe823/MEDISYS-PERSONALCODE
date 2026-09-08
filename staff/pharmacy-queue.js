(function () {
  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === 'function') {
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

  function showToast(message, type = 'success') {
    const container = document.getElementById("toastContainer");
    if (!container) {
      alert(message);
      return;
    }

    const toast = document.createElement("div");
    toast.className = `toast-item toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"></path></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    }

    const textSpan = document.createElement("div");
    textSpan.className = "toast-msg-text";
    textSpan.textContent = message;

    toast.innerHTML = `<div class="toast-icon-wrap">${iconSvg}</div>`;
    toast.appendChild(textSpan);

    const closeBtn = document.createElement("button");
    closeBtn.className = "toast-close-btn";
    closeBtn.innerHTML = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"></path></svg>`;
    closeBtn.onclick = () => {
      toast.classList.add("toast-hiding");
      setTimeout(() => toast.remove(), 250);
    };
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("toast-hiding");
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  let sessionUser = null;
  let allOrders = [];
  let currentTab = "pending";
  let searchQuery = "";

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user) {
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

  async function loadPharmacyOrders() {
    try {
      const res = await fetch("/api/pharmacy-orders", { credentials: "same-origin" });
      const data = await res.json();
      
      if (data.success && data.orders) {
        allOrders = data.orders;
        renderTable();
      }
    } catch (err) {
      console.error("Error loading pharmacy orders:", err);
    }
  }

  function renderTable() {
    const grid = document.getElementById("pharmacyGrid");
    const emptyState = document.getElementById("pharmacyEmptyState");

    // 1. Filter by Tab. Orders default to 'pending_pharmacy' until dispensed — matches
    // the status the server actually writes (see schema.js / POST /api/pharmacy-orders).
    let filtered = allOrders.filter(o =>
      currentTab === "pending" ? o.status === "pending_pharmacy" : o.status === "dispensed"
    );

    // 2. Filter by Search Query
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(o =>
        (o.patient_uhid && o.patient_uhid.toLowerCase().includes(q)) ||
        (o.patient_name && o.patient_name.toLowerCase().includes(q)) ||
        (o.medicine_name && o.medicine_name.toLowerCase().includes(q))
      );
    }

    if (filtered.length === 0) {
      grid.innerHTML = "";
      emptyState.querySelector('p').textContent = currentTab === "pending"
        ? "No pending prescriptions right now."
        : "No dispensed history found.";
      emptyState.hidden = false;
      return;
    }

    emptyState.hidden = true;

    // 3. Group every order onto one card per patient, so a doctor's full prescription
    // for that visit reads as a single list instead of one card per medicine.
    const groups = [];
    const groupIndexByKey = new Map();
    filtered.forEach((order) => {
      const key = `${order.patient_uhid}::${order.opd_visit_id || ""}::${order.ipd_admission_id || ""}`;
      if (!groupIndexByKey.has(key)) {
        groupIndexByKey.set(key, groups.length);
        groups.push({
          patient_uhid: order.patient_uhid,
          patient_name: order.patient_name,
          patient_dob: order.patient_dob,
          patient_gender: order.patient_gender,
          doctor_user_id: order.doctor_user_id,
          ipd_admission_id: order.ipd_admission_id,
          latest_created_at: order.created_at,
          orders: [],
        });
      }
      const group = groups[groupIndexByKey.get(key)];
      group.orders.push(order);
      if (new Date(order.created_at) > new Date(group.latest_created_at)) {
        group.latest_created_at = order.created_at;
      }
    });

    grid.innerHTML = groups.map((group) => {
      const isIPD = !!group.ipd_admission_id;
      const typePill = isIPD ? `<span class="pill ipd">IPD</span>` : `<span class="pill opd">OPD</span>`;

      let ageStr = '';
      if (group.patient_dob) {
        const age = Math.floor((new Date() - new Date(group.patient_dob)) / 31557600000);
        const g = group.patient_gender ? group.patient_gender.charAt(0).toUpperCase() : '';
        ageStr = `${age}${g} &bull; `;
      }

      const hasUrgent = group.orders.some((o) => o.urgency === 'urgent');
      const urgencyPill = hasUrgent ? `<span class="pill urgent">Urgent</span>` : `<span class="pill routine">Routine</span>`;
      const medCountPill = `<span class="pill" style="background:#e0e7ff;color:#3730a3;">${group.orders.length} medicine${group.orders.length > 1 ? 's' : ''}</span>`;

      const timeStr = group.latest_created_at
        ? new Date(group.latest_created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';

      const medRows = group.orders
        .map((order) => {
          const isDispensed = order.status === 'dispensed';
          const actionHtml = isDispensed
            ? `<span class="status-dispensed">Dispensed</span>`
            : `<button class="btn-dispense dispense-btn" data-id="${order.id}">Dispense</button>`;

          return `
            <div class="med-row">
              <div>
                <div class="med-item">${escapeHtml(order.medicine_name)}${order.urgency === 'urgent' ? ' <span class="pill urgent">Urgent</span>' : ''}</div>
                <div class="med-dose">Dose: ${escapeHtml(order.dosage)} &nbsp;|&nbsp; For: ${escapeHtml(order.duration)}${order.food_instruction ? ` &nbsp;|&nbsp; ${escapeHtml(order.food_instruction)}` : ''}</div>
              </div>
              <div>${actionHtml}</div>
            </div>`;
        })
        .join("");

      return `
        <div class="prescription-card">
          <div class="card-header">
            <div>
              <div class="patient-name">${escapeHtml(group.patient_name || 'Unknown Patient')}</div>
              <div class="patient-meta">${ageStr}${escapeHtml(group.patient_uhid)} &bull; Dr. ${escapeHtml(group.doctor_user_id)}</div>
            </div>
            <div>
              ${urgencyPill}
              ${typePill}
              ${medCountPill}
            </div>
          </div>

          <div class="med-list">
            ${medRows}
          </div>

          <div class="card-footer">
            <div class="time-stamp">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path></svg>
              ${escapeHtml(timeStr)}
            </div>
          </div>
        </div>
      `;
    }).join("");

    document.querySelectorAll('.dispense-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = e.target.getAttribute('data-id');
        await dispenseMedicine(id);
      });
    });
  }

  async function dispenseMedicine(orderId) {
    if (!confirm(t('pharmacy_toast.confirm_dispense', 'Are you sure you want to mark this medicine as dispensed?'))) return;

    // Grabbed before the dispense call so we still have it even after
    // loadPharmacyOrders() below refreshes/reorders allOrders.
    const order = allOrders.find(o => String(o.id) === String(orderId));

    try {
      const res = await fetch(`/api/pharmacy-orders/${orderId}/dispense`, {
        method: "POST",
        credentials: "same-origin"
      });
      const data = await res.json();
      if(data.success) {
        showToast(t('pharmacy_toast.dispensed', 'Medicine marked as dispensed & stock updated!'), "success");
        loadPharmacyOrders();
        if (order) checkLowStockAfterDispense(order.medicine_name);
      } else {
        showToast(t('pharmacy_toast.failed_dispense_prefix', 'Failed to dispense: ') + data.message, "error");
      }
    } catch (err) {
      console.error("Error dispensing medicine:", err);
      showToast(t('pharmacy_toast.error_connecting', 'Error connecting to server.'), "error");
    }
  }

  // Requirement 6: a toast right when a dispense pushes a medicine below its
  // reorder threshold, instead of the pharmacist only finding out later from
  // the Low Stock tab. Delegates the badge/list refresh to loadLowStock() so
  // this stays consistent with the actionable (isLow && !hasPendingOrder) +
  // acknowledged-state logic used everywhere else, instead of duplicating it.
  async function checkLowStockAfterDispense(medicineName) {
    await loadLowStock();
    const entry = findLowStockEntry(medicineName);
    if (entry && entry.isLow && !entry.hasPendingOrder) {
      showToast(t('pharmacy_toast.low_stock_alert', 'Low stock alert: {medicineName} — {currentStock} left (threshold {threshold}).', { medicineName: entry.medicineName, currentStock: entry.currentStock, threshold: entry.threshold }), "error");
    }
  }

  let allStock = [];
  let stockSearchQuery = '';
  let allLowStock = []; // per-medicine aggregate, from /api/pharmacy-stock/low-stock

  function findLowStockEntry(medicineName) {
    const key = (medicineName || '').trim().toLowerCase();
    return allLowStock.find(m => m.medicineName.trim().toLowerCase() === key) || null;
  }

  async function loadPharmacyStock() {
    try {
      const res = await fetch("/api/pharmacy-stock", { credentials: "same-origin" });
      const data = await res.json();
      if(data.success) {
        allStock = data.stock;
        renderStock();
      }
    } catch (err) {
      console.error(err);
    }
  }

  // The bell badge is "unseen alert count", not "current low-stock count" —
  // clicking the bell (or the Low Stock tab itself) marks everything
  // currently actionable as seen, dropping the badge to 0, same as a
  // notification inbox. A medicine only counts as unseen again once it's
  // been restocked above threshold and then dips low a *second* time — see
  // the re-arm logic in loadLowStock() below. Scoped per hospital in
  // localStorage so switching hospitals on the same browser doesn't leak
  // acknowledgement state across tenants.
  function ackStorageKey() {
    const hid = sessionUser && sessionUser.hospitalId ? sessionUser.hospitalId : "unknown";
    return `medisys:lowstock:acknowledged:${hid}`;
  }
  function getAcknowledgedSet() {
    try {
      const raw = localStorage.getItem(ackStorageKey());
      return new Set(raw ? JSON.parse(raw) : []);
    } catch {
      return new Set();
    }
  }
  function saveAcknowledgedSet(set) {
    try {
      localStorage.setItem(ackStorageKey(), JSON.stringify(Array.from(set)));
    } catch {
      // localStorage unavailable (private browsing, quota, etc.) — the bell
      // just won't remember "seen" state across reloads; not worth surfacing.
    }
  }

  // Per-medicine aggregate low-stock check (sum across non-expired batches vs.
  // reorder threshold) — separate from the per-batch min_stock_level check
  // renderStock() already did. Drives the nav bell badge, the Low Stock tab,
  // and the extra flag on Medicine Stock rows.
  async function loadLowStock() {
    try {
      const res = await fetch("/api/pharmacy-stock/low-stock", { credentials: "same-origin" });
      const data = await res.json();
      if (data.success) {
        allLowStock = data.medicines || [];
        const actionable = actionableLowStock();

        // Re-arm: forget "seen" for anything that's no longer actionable
        // (restocked, or now covered by a PO) so it alerts fresh next time
        // it genuinely goes low again, instead of staying silently muted.
        const acked = getAcknowledgedSet();
        const stillRelevant = new Set(actionable.map(m => m.medicineName.trim().toLowerCase()));
        let ackChanged = false;
        for (const name of Array.from(acked)) {
          if (!stillRelevant.has(name)) {
            acked.delete(name);
            ackChanged = true;
          }
        }
        if (ackChanged) saveAcknowledgedSet(acked);

        const unseenCount = actionable.filter(m => !acked.has(m.medicineName.trim().toLowerCase())).length;
        const bellBadge = document.getElementById("lowStockBellBadge");
        if (bellBadge) {
          bellBadge.textContent = unseenCount;
          bellBadge.hidden = unseenCount === 0;
        }
        const tabBadge = document.getElementById("lowStockTabCount");
        if (tabBadge) tabBadge.textContent = actionable.length;
        renderLowStock();
        // The Medicine Stock tab's per-row flags depend on allLowStock too —
        // re-render it if it's the currently visible section.
        const stockSection = document.getElementById("sectionStock");
        if (stockSection && !stockSection.hidden) renderStock();
      }
    } catch (err) {
      console.error("Error loading low stock alerts:", err);
    }
  }

  // The "actionable" low-stock set — genuinely low AND not already covered
  // by a pending PO. Used consistently for the tab list, the nav badge, and
  // the bell badge, so all three always agree on what still needs attention.
  function actionableLowStock() {
    return allLowStock.filter(m => m.isLow && !m.hasPendingOrder);
  }

  function renderLowStock() {
    const list = document.getElementById("lowStockList");
    const emptyState = document.getElementById("lowStockEmptyState");
    if (!list) return;
    const lowOnes = actionableLowStock();

    if (lowOnes.length === 0) {
      list.innerHTML = "";
      if (emptyState) emptyState.hidden = false;
      return;
    }
    if (emptyState) emptyState.hidden = true;

    list.innerHTML = lowOnes.map(m => `
      <div class="stock-list-item" style="border-left: 3px solid #b91c1c; background: #fef2f2;">
        <div class="stock-info" style="flex: 1;">
          <h4 style="margin-bottom: 4px;">${escapeHtml(m.medicineName)} <span style="font-size: 12px; color: #94a3b8; font-weight: 400;">${escapeHtml(m.category || '')}</span></h4>
          <div style="font-size: 13px; color: #64748b;">
            Threshold: ${m.threshold} ${m.reorderThresholdType === 'percentage' ? `(${m.isCustomThreshold ? m.reorderThreshold : 10}% of last batch)` : '(fixed)'}
            &nbsp;|&nbsp; Last supplier: ${escapeHtml(m.lastSupplier || '—')}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="text-align: right;">
            <div style="font-size: 20px; font-weight: 700; font-family: serif; color: #b91c1c; margin-bottom: 2px;">
              ${m.currentStock} <span style="font-size: 12px; color: #64748b;">left</span>
            </div>
            <span style="font-size: 11px; font-weight: 600; color: #b91c1c;">LOW STOCK</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <button onclick="window.__openThresholdModal('${escapeHtml(m.medicineName)}')" style="padding: 4px 10px; font-size: 12px; border: 1px solid #e2e8f0; background: white; border-radius: 6px; cursor: pointer; color: #334155;">Set Threshold</button>
            <button onclick="window.__reorderMedicine('${escapeHtml(m.medicineName)}', '${escapeHtml(m.lastSupplier || '')}')" style="padding: 4px 10px; font-size: 12px; border: 1px solid #93c5fd; background: #eff6ff; border-radius: 6px; cursor: pointer; color: #1d4ed8; font-weight: 600;">Create PO</button>
          </div>
        </div>
      </div>
    `).join("");
  }

  // --- REORDER: create a PO for one low-stock medicine (reuses the same PO
  // mechanics as the "auto-generate" bulk flow, just scoped to one item) ---
  window.__reorderMedicine = async function(medicineName, supplierName) {
    try {
      const res = await fetch("/api/pharmacy-purchase-orders/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ medicineName, supplierName: supplierName || undefined }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || t('pharmacy_toast.po_created', 'PO created for {medicineName}.', { medicineName }), "success");
        // Don't wait on the realtime round-trip for this — refresh both tabs
        // immediately so the medicine visibly moves from Low Stock to Orders
        // right away. (The realtime "pharmacy_stock"/"pharmacy_purchase_orders"
        // broadcasts still fire too, in case another pharmacist has this page
        // open at the same time.)
        loadLowStock();
        loadPurchaseOrders();
      } else {
        showToast(t('pharmacy_toast.failed_create_po_prefix', 'Failed to create PO: ') + data.message, "error");
      }
    } catch (err) {
      console.error(err);
      showToast(t('pharmacy_toast.error_connecting', 'Error connecting to server.'), "error");
    }
  };

  let allOrders_purchase = []; // purchase orders — separate from allOrders (pharmacy_orders/prescriptions)

  async function loadPurchaseOrders() {
    try {
      const res = await fetch("/api/pharmacy-purchase-orders", { credentials: "same-origin" });
      const data = await res.json();
      if (data.success) {
        allOrders_purchase = data.orders || [];
        renderPurchaseOrders();
      }
    } catch (err) {
      console.error("Error loading purchase orders:", err);
    }
  }

  function renderPurchaseOrders() {
    const list = document.getElementById("ordersList");
    const emptyState = document.getElementById("ordersEmptyState");
    if (!list) return;

    const submittedCount = allOrders_purchase.filter(o => o.status === 'Submitted').length;
    const tabBadge = document.getElementById("ordersTabCount");
    if (tabBadge) tabBadge.textContent = submittedCount;

    if (allOrders_purchase.length === 0) {
      list.innerHTML = "";
      if (emptyState) emptyState.hidden = false;
      return;
    }
    if (emptyState) emptyState.hidden = true;

    const statusColor = (status) => status === 'Submitted' ? '#d97706' : status === 'Received' ? '#047857' : '#94a3b8';

    list.innerHTML = allOrders_purchase.map(po => `
      <div class="stock-list-item">
        <div class="stock-info" style="flex: 1;">
          <h4 style="margin-bottom: 4px;">${escapeHtml(po.po_number)} <span style="font-size: 12px; color: #94a3b8; font-weight: 400;">${escapeHtml(po.supplier_name)}</span></h4>
          <div style="font-size: 13px; color: #64748b;">
            ${escapeHtml(po.items_summary)} &nbsp;|&nbsp; ${po.total_items} item(s) &nbsp;|&nbsp; ${new Date(po.created_at).toLocaleDateString()}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 11px; font-weight: 700; color: ${statusColor(po.status)}; text-transform: uppercase;">${escapeHtml(po.status)}</span>
          ${po.status === 'Submitted' ? `
            <div style="display: flex; flex-direction: column; gap: 6px;">
              <button onclick="window.__setPoStatus(${po.id}, 'Received')" style="padding: 4px 10px; font-size: 12px; border: 1px solid #86efac; background: #f0fdf4; border-radius: 6px; cursor: pointer; color: #047857; font-weight: 600;">Mark Received</button>
              <button onclick="window.__setPoStatus(${po.id}, 'Cancelled')" style="padding: 4px 10px; font-size: 12px; border: 1px solid #fca5a5; background: #fef2f2; border-radius: 6px; cursor: pointer; color: #b91c1c;">Cancel</button>
            </div>` : ''}
        </div>
      </div>
    `).join("");
  }

  window.__setPoStatus = async function (id, status) {
    try {
      const res = await fetch(`/api/pharmacy-purchase-orders/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || t('pharmacy_toast.marked_status', 'Marked {status}.', { status }), "success");
        loadPurchaseOrders();
        loadLowStock(); // Cancelled orders send the medicine back to Low Stock immediately
      } else {
        showToast(t('pharmacy_toast.failed_prefix', 'Failed: ') + data.message, "error");
      }
    } catch (err) {
      console.error(err);
      showToast(t('pharmacy_toast.error_connecting', 'Error connecting to server.'), "error");
    }
  };

  function renderStock() {
    const list = document.getElementById("stockList");
    let filtered = allStock;
    if (stockSearchQuery) {
      const q = stockSearchQuery.toLowerCase();
      filtered = filtered.filter(s => s.medicine_name.toLowerCase().includes(q));
    }

    const trackedCount = allStock.length;
    const lowCount = allStock.filter(s => s.stock_quantity <= s.min_stock_level).length;

    const sixtyDaysFromNow = new Date();
    sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);
    const expiringCount = allStock.filter(s => new Date(s.expiry_date) <= sixtyDaysFromNow).length;

    document.getElementById("statTracked").textContent = trackedCount;
    document.getElementById("statLow").textContent = lowCount;
    document.getElementById("statExpiring").textContent = expiringCount;
    document.getElementById("stockCount").textContent = lowCount > 0 ? lowCount : trackedCount;

    if (filtered.length === 0) {
      list.innerHTML = `<p style="padding:20px; text-align:center; color:#64748b;">No stock items found.</p>`;
      return;
    }

    list.innerHTML = filtered.map(item => {
      let stockColor = '#047857'; // Green
      let statusLabel = 'Healthy';
      if (item.stock_quantity === 0) { stockColor = '#b91c1c'; statusLabel = 'Out of Stock'; }
      else if (item.stock_quantity <= item.min_stock_level) { stockColor = '#d97706'; statusLabel = 'Low Stock'; }

      // Medicine-wide aggregate check (across all this medicine's batches),
      // separate from the single-batch statusLabel above. Suppressed once a
      // PO is already out for this medicine — same "actionable" definition
      // as the Low Stock tab, so the two views never contradict each other.
      const aggEntry = findLowStockEntry(item.medicine_name);
      const aggActionable = aggEntry && aggEntry.isLow && !aggEntry.hasPendingOrder;
      const aggFlag = aggActionable
        ? `<div style="margin-top: 4px; font-size: 11px; font-weight: 700; color: #b91c1c; display: flex; align-items: center; gap: 4px;">
             <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"></path></svg>
             LOW STOCK across all batches (${aggEntry.currentStock}/${aggEntry.threshold})
           </div>`
        : aggEntry && aggEntry.isLow && aggEntry.hasPendingOrder
        ? `<div style="margin-top: 4px; font-size: 11px; font-weight: 700; color: #1d4ed8;">PO already raised — see Orders tab</div>`
        : '';

      return `
      <div class="stock-list-item"${aggActionable ? ' style="border-left: 3px solid #b91c1c;"' : ''}>
        <div class="stock-info" style="flex: 1;">
          <h4 style="margin-bottom: 4px;">${escapeHtml(item.medicine_name)} <span style="font-size: 12px; color: #94a3b8; font-weight: 400;">${escapeHtml(item.category || '')}</span></h4>
          <div style="font-size: 13px; color: #64748b;">
            Batch: ${escapeHtml(item.batch_number)} &nbsp;|&nbsp; Exp: ${item.expiry_date ? item.expiry_date.split('T')[0] : 'N/A'} &nbsp;|&nbsp; Min: ${item.min_stock_level}
          </div>
          ${aggFlag}
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <div style="text-align: right;">
            <div style="font-size: 20px; font-weight: 700; font-family: serif; color: ${stockColor}; margin-bottom: 2px;">
              ${item.stock_quantity} <span style="font-size: 12px; color: #64748b;">left</span>
            </div>
            <span style="font-size: 11px; font-weight: 600; color: ${stockColor};">${statusLabel}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            <button onclick="window.__editStock(${item.id}, '${escapeHtml(item.medicine_name)}', '${escapeHtml(item.category)}', '${escapeHtml(item.batch_number)}', '${item.expiry_date ? item.expiry_date.split('T')[0] : ''}', ${item.stock_quantity}, ${item.min_stock_level}, ${item.unit_price || 0}, '${escapeHtml(item.supplier_name || '')}')" style="padding: 4px 10px; font-size: 12px; border: 1px solid #e2e8f0; background: white; border-radius: 6px; cursor: pointer; color: #334155;">Edit</button>
            <button onclick="window.__openThresholdModal('${escapeHtml(item.medicine_name)}')" style="padding: 4px 10px; font-size: 12px; border: 1px solid #e2e8f0; background: white; border-radius: 6px; cursor: pointer; color: #334155;">Threshold</button>
            <button onclick="window.__deleteStock(${item.id})" style="padding: 4px 10px; font-size: 12px; border: 1px solid #fca5a5; background: #fef2f2; border-radius: 6px; cursor: pointer; color: #b91c1c;">Delete</button>
          </div>
        </div>
      </div>
      `;
    }).join("");
  }

  // --- EDIT STOCK ---
  window.__editStock = function(id, name, category, batch, expiry, qty, minLevel, price, supplier) {
    document.getElementById('stockMedName').value = name;
    document.getElementById('stockCategory').value = category;
    document.getElementById('stockBatch').value = batch;
    document.getElementById('stockExpiry').value = expiry;
    document.getElementById('stockQty').value = qty;
    document.getElementById('stockPrice').value = price || '';
    const supplierInput = document.getElementById('stockSupplier');
    if (supplierInput) supplierInput.value = supplier || '';
    const minInput = document.getElementById('stockMinLevel');
    if (minInput) minInput.value = minLevel;

    // Set editing mode
    const form = document.getElementById('addStockForm');
    form.setAttribute('data-edit-id', id);
    
    const modal = document.getElementById('addStockModal');
    modal.classList.add('show');
  };

  // --- DELETE STOCK ---
  window.__deleteStock = async function(id) {
    if (!confirm(t('pharmacy_toast.confirm_delete_stock', 'Are you sure you want to delete this stock entry?'))) return;
    try {
      const res = await fetch(`/api/pharmacy-stock/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      const data = await res.json();
      if (data.success) {
        loadPharmacyStock();
      } else {
        alert(t('pharmacy_toast.failed_prefix', 'Failed: ') + data.message);
      }
    } catch (err) {
      console.error(err);
      alert(t('pharmacy_toast.server_error_short', 'Server error'));
    }
  };

  function setupStockModal() {
    const modal = document.getElementById("addStockModal");
    
     function openModal() {
      document.getElementById('addStockForm').removeAttribute('data-edit-id');
      document.getElementById('addStockForm').reset();
      modal.classList.add("show");
    }
    function closeModal() { modal.classList.remove("show"); }
    
    document.getElementById("addStockBtn").addEventListener("click", openModal);
    document.getElementById("closeStockModal").addEventListener("click", closeModal);
    
    // Second cancel button inside modal body
    const closeBtn2 = document.getElementById("closeStockModal2");
    if (closeBtn2) closeBtn2.addEventListener("click", closeModal);
    
    // Close on clicking backdrop
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    document.getElementById("addStockForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const editId = form.getAttribute('data-edit-id');
      const minInput = document.getElementById('stockMinLevel');
      
      const payload = {
        medicineName: document.getElementById("stockMedName").value,
        category: document.getElementById("stockCategory").value,
        batchNumber: document.getElementById("stockBatch").value,
        expiryDate: document.getElementById("stockExpiry").value,
        stockQuantity: parseInt(document.getElementById("stockQty").value, 10),
        minStockLevel: minInput ? parseInt(minInput.value, 10) || 10 : 10,
        unitPrice: parseFloat(document.getElementById("stockPrice").value) || null,
        supplierName: document.getElementById("stockSupplier").value.trim() || null
      };

      const url = editId ? `/api/pharmacy-stock/${editId}` : '/api/pharmacy-stock';
      const method = editId ? 'PUT' : 'POST';

      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "same-origin"
        });
        const data = await res.json();
        if (data.success) {
          alert(editId ? t('pharmacy_toast.stock_updated_success', 'Stock updated successfully') : t('pharmacy_toast.stock_added_success', 'Stock added successfully'));
          closeModal();
          form.reset();
          form.removeAttribute('data-edit-id');
          loadPharmacyStock();
        } else {
          alert(t('pharmacy_toast.failed_prefix', 'Failed: ') + data.message);
        }
      } catch (err) {
        console.error(err);
        alert(t('pharmacy_toast.server_error_short', 'Server error'));
      }
    });
    
    document.getElementById("stockSearchInput").addEventListener("input", (e) => {
      stockSearchQuery = e.target.value.trim();
      renderStock();
    });
  }

  // --- REORDER THRESHOLD: per-medicine, edited from Medicine Stock or Low Stock tab ---
  window.__openThresholdModal = function (medicineName) {
    document.getElementById('thresholdMedName').value = medicineName;
    document.getElementById('thresholdMedLabel').textContent = medicineName;

    const existing = findLowStockEntry(medicineName);
    const typeSelect = document.getElementById('thresholdType');
    const valueInput = document.getElementById('thresholdValue');
    if (existing && existing.isCustomThreshold) {
      typeSelect.value = existing.reorderThresholdType;
      valueInput.value = existing.reorderThreshold;
    } else {
      // No custom threshold set yet — leave the value blank (placeholder
      // explains the 10%-of-last-batch default) rather than pre-filling 10,
      // so an empty save keeps it on the auto-computed default.
      typeSelect.value = 'percentage';
      valueInput.value = '';
    }

    document.getElementById('thresholdModal').classList.add('show');
  };

  function setupThresholdModal() {
    const modal = document.getElementById("thresholdModal");
    function closeModal() { modal.classList.remove("show"); }

    document.getElementById("closeThresholdModal").addEventListener("click", closeModal);
    const closeBtn2 = document.getElementById("closeThresholdModal2");
    if (closeBtn2) closeBtn2.addEventListener("click", closeModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });

    document.getElementById("thresholdForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const medicineName = document.getElementById("thresholdMedName").value;
      const reorderThresholdType = document.getElementById("thresholdType").value;
      const reorderThreshold = document.getElementById("thresholdValue").value;

      try {
        const res = await fetch("/api/pharmacy-stock/thresholds", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ medicineName, reorderThreshold, reorderThresholdType }),
        });
        const data = await res.json();
        if (data.success) {
          showToast(t('pharmacy_toast.reorder_threshold_saved', 'Reorder threshold saved for {medicineName}.', { medicineName }), "success");
          closeModal();
          loadLowStock();
        } else {
          showToast(t('pharmacy_toast.failed_prefix', 'Failed: ') + data.message, "error");
        }
      } catch (err) {
        console.error(err);
        showToast(t('pharmacy_toast.error_connecting', 'Error connecting to server.'), "error");
      }
    });
  }

  // --- SUMMARY MANAGEMENT ---
  async function updateSummary() {
    // Ensure we have latest data
    await Promise.all([
      fetch("/api/pharmacy-orders", { credentials: "same-origin" }).then(res => res.json()).then(data => { if(data.success) allOrders = data.orders; }),
      fetch("/api/pharmacy-stock", { credentials: "same-origin" }).then(res => res.json()).then(data => { if(data.success) allStock = data.stock; })
    ]);

    const todayStr = new Date().toISOString().split('T')[0];
    
    // Dispensed today
    const dispensedToday = allOrders.filter(o => o.status === 'dispensed' && o.updated_at && o.updated_at.startsWith(todayStr)).length;
    
    // Waiting
    const waiting = allOrders.filter(o => o.status === 'pending_pharmacy').length;
    
    // Revenue billed (stubbed, assuming 0 for now as billing isn't fully linked to orders in our basic schema yet, or we sum amount)
    // For now we'll sum up some arbitrary logic or 0
    let revenue = 0;
    
    // Low stock items
    const lowStockCount = allStock.filter(s => s.stock_quantity <= s.min_stock_level && s.stock_quantity > 0).length;
    const outOfStockCount = allStock.filter(s => s.stock_quantity === 0).length;
    const totalLow = lowStockCount + outOfStockCount;

    document.getElementById("sumDispensed").textContent = dispensedToday;
    document.getElementById("sumWaiting").textContent = waiting;
    document.getElementById("sumRevenue").textContent = "₹" + revenue;
    document.getElementById("sumLowStock").textContent = totalLow;

    // Most given out
    const medCounts = {};
    allOrders.filter(o => o.status === 'dispensed').forEach(o => {
      medCounts[o.medicine_name] = (medCounts[o.medicine_name] || 0) + 1;
    });
    
    const sortedMeds = Object.entries(medCounts).sort((a,b) => b[1] - a[1]).slice(0, 5);
    const mostGivenList = document.getElementById("sumMostGivenList");
    if (sortedMeds.length === 0) {
      mostGivenList.innerHTML = `<p style="color: #64748b; font-size: 14px;">No medicines dispensed yet.</p>`;
    } else {
      mostGivenList.innerHTML = sortedMeds.map(([name, count]) => `
        <div style="display: flex; justify-content: space-between; padding: 12px 16px; background: #f8fafc; border-radius: 8px; margin-bottom: 8px;">
          <strong style="color: var(--navy-dark);">${escapeHtml(name)}</strong>
          <span style="color: #64748b; font-size: 13px;">${count} given</span>
        </div>
      `).join("");
    }

    // Expired stock
    const now = new Date();
    const expiredStock = allStock.filter(s => new Date(s.expiry_date) < now);
    const expiredList = document.getElementById("sumExpiredList");
    if (expiredStock.length === 0) {
      expiredList.innerHTML = `<p style="color: #64748b; font-size: 14px;">Nothing expired right now.</p>`;
    } else {
      expiredList.innerHTML = expiredStock.map(s => `
        <div style="display: flex; justify-content: space-between; padding: 12px 16px; background: #fef2f2; border-radius: 8px; margin-bottom: 8px; border: 1px solid #fca5a5;">
          <strong style="color: #b91c1c;">${escapeHtml(s.medicine_name)} (Batch: ${escapeHtml(s.batch_number)})</strong>
          <span style="color: #b91c1c; font-size: 13px;">Expired ${s.expiry_date.split('T')[0]}</span>
        </div>
      `).join("");
    }
  }

  async function init() {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadPharmacyOrders();
    
    // Wire Sub Tabs (Pending vs History)
    const tabPending = document.getElementById("tabPending");
    const tabHistory = document.getElementById("tabHistory");
    
    tabPending.addEventListener("click", () => {
      currentTab = "pending";
      tabPending.classList.add("active");
      tabHistory.classList.remove("active");
      renderTable();
    });
    
    tabHistory.addEventListener("click", () => {
      currentTab = "history";
      tabHistory.classList.add("active");
      tabPending.classList.remove("active");
      renderTable();
    });

    document.getElementById("searchInput").addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      renderTable();
    });

    // Wire Main Nav Tabs
    const navPrescriptions = document.getElementById("navPrescriptions");
    const navStock = document.getElementById("navStock");
    const navLowStock = document.getElementById("navLowStock");
    const navOrders = document.getElementById("navOrders");
    const navSummary = document.getElementById("navSummary");
    const navBilling = document.getElementById("navBilling");
    const navPatients = document.getElementById("navPatients");

    const sectionPrescriptions = document.getElementById("sectionPrescriptions");
    const sectionStock = document.getElementById("sectionStock");
    const sectionLowStock = document.getElementById("sectionLowStock");
    const sectionOrders = document.getElementById("sectionOrders");
    const sectionSummary = document.getElementById("sectionSummary");
    const sectionBilling = document.getElementById("sectionBilling");
    const sectionPatients = document.getElementById("sectionPatients");

    function hideAllSections() {
      if (sectionPrescriptions) sectionPrescriptions.hidden = true;
      if (sectionStock) sectionStock.hidden = true;
      if (sectionLowStock) sectionLowStock.hidden = true;
      if (sectionOrders) sectionOrders.hidden = true;
      if (sectionSummary) sectionSummary.hidden = true;
      if (sectionBilling) sectionBilling.hidden = true;
      if (sectionPatients) sectionPatients.hidden = true;
      document.querySelectorAll('.pill-tab').forEach(t => t.classList.remove('active'));
    }

    if (navOrders) {
      navOrders.addEventListener("click", () => {
        hideAllSections();
        navOrders.classList.add("active");
        if (sectionOrders) sectionOrders.hidden = false;
        loadPurchaseOrders();
      });
    }
    // Exposed so the header bell icon (outside the pharmacy-nav pill row) can
    // jump straight to the Low Stock tab from any section. Also acknowledges
    // every currently-actionable alert (bell badge -> 0) since arriving here
    // — via the bell or the pill tab, either way the pharmacist has now seen
    // the list. The tab's own content still shows everything low; only the
    // bell's "unseen count" is affected.
    window.__showLowStockTab = function () {
      hideAllSections();
      if (navLowStock) navLowStock.classList.add("active");
      if (sectionLowStock) sectionLowStock.hidden = false;
      loadLowStock().then(() => {
        const acked = getAcknowledgedSet();
        actionableLowStock().forEach(m => acked.add(m.medicineName.trim().toLowerCase()));
        saveAcknowledgedSet(acked);
        const bellBadge = document.getElementById("lowStockBellBadge");
        if (bellBadge) {
          bellBadge.textContent = "0";
          bellBadge.hidden = true;
        }
      });
    };

    if (navPrescriptions) {
      navPrescriptions.addEventListener("click", () => {
        hideAllSections();
        navPrescriptions.classList.add("active");
        if (sectionPrescriptions) sectionPrescriptions.hidden = false;
      });
    }

    if (navStock) {
      navStock.addEventListener("click", () => {
        hideAllSections();
        navStock.classList.add("active");
        if (sectionStock) sectionStock.hidden = false;
        loadPharmacyStock();
      });
    }

    if (navLowStock) {
      navLowStock.addEventListener("click", () => window.__showLowStockTab());
    }

    const lowStockBellBtn = document.getElementById("lowStockBellBtn");
    if (lowStockBellBtn) {
      lowStockBellBtn.addEventListener("click", () => window.__showLowStockTab());
    }

    if (navSummary) {
      navSummary.addEventListener("click", () => {
        hideAllSections();
        navSummary.classList.add("active");
        if (sectionSummary) sectionSummary.hidden = false;
        updateSummary();
      });
    }

  // --- READY TO BILL: dispensed medicines waiting to be combined into one invoice ---
  async function loadReadyToBill() {
    try {
      const res = await fetch("/api/pharmacy-orders/ready-to-bill", { credentials: "same-origin" });
      const data = await res.json();
      if (data.success) renderReadyToBill(data.orders || []);
    } catch (err) {
      console.error("Error loading ready-to-bill orders:", err);
    }
  }

  function renderReadyToBill(orders) {
    const container = document.getElementById("readyToBillContainer");
    const emptyState = document.getElementById("readyToBillEmptyState");
    if (!container) return;

    if (orders.length === 0) {
      container.innerHTML = "";
      if (emptyState) emptyState.hidden = false;
      return;
    }
    if (emptyState) emptyState.hidden = true;

    // Group purely by patient — one card, and so exactly one Paid button, per patient,
    // no matter how many separate medicines or visits contributed to what they owe.
    const groups = [];
    const groupIndexByKey = new Map();
    orders.forEach((order) => {
      const key = order.patient_uhid;
      if (!groupIndexByKey.has(key)) {
        groupIndexByKey.set(key, groups.length);
        groups.push({
          patient_uhid: order.patient_uhid,
          patient_name: order.patient_name,
          doctor_user_id: order.doctor_user_id,
          orders: [],
        });
      }
      groups[groupIndexByKey.get(key)].orders.push(order);
    });

    container.innerHTML = groups.map((group) => {
      const total = group.orders.reduce((sum, o) => sum + (parseFloat(o.amount) || 15), 0);
      const orderIds = group.orders.map((o) => o.id).join(",");
      const medLines = group.orders.map((o) =>
        `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #f1f5f9; font-size:13.5px;">
           <span style="color:#334155;">${escapeHtml(o.medicine_name)} <span style="color:#94a3b8;">&middot; ${escapeHtml(o.dosage)}</span></span>
           <span style="font-weight:600; color:#0f172a;">₹${(parseFloat(o.amount) || 15).toFixed(2)}</span>
         </div>`
      ).join("");

      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px; background: #f8fafc;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
            <div>
              <div style="font-weight:700; font-size:15px; color:#0f172a;">${escapeHtml(group.patient_name || 'Unknown Patient')}</div>
              <div style="font-size:12.5px; color:#64748b; margin-top:2px;">${escapeHtml(group.patient_uhid)} &bull; Dr. ${escapeHtml(group.doctor_user_id)} &bull; ${group.orders.length} medicine${group.orders.length > 1 ? 's' : ''}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.4px;">Amount due</div>
              <div style="font-size:19px; font-weight:700; font-family:serif; color:var(--navy);">₹${total.toFixed(2)}</div>
            </div>
          </div>
          <div style="margin-bottom:12px;">${medLines}</div>
          <button class="btn-dispense mark-paid-btn" data-order-ids="${orderIds}" style="width:100%;">Mark Paid &amp; Generate Bill</button>
        </div>`;
    }).join("");

    container.querySelectorAll(".mark-paid-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const orderIds = btn.dataset.orderIds.split(",").map(Number);
        await payAndGenerateBill(orderIds, btn);
      });
    });
  }

  // One click: combine everything a patient owes into one invoice, mark it Paid
  // immediately, then hand back the finished bill to print.
  async function payAndGenerateBill(orderIds, triggerBtn) {
    if (triggerBtn) triggerBtn.disabled = true;
    try {
      const genRes = await fetch("/api/pharmacy-invoices/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ orderIds }),
      });
      const genData = await genRes.json();
      if (!genData.success) {
        showToast(genData.message || t('pharmacy_toast.could_not_generate_bill', 'Could not generate bill.'), "error");
        if (triggerBtn) triggerBtn.disabled = false;
        return;
      }

      const payRes = await fetch(`/api/pharmacy-invoices/${genData.invoiceId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ paymentType: "Cash" }),
      });
      const payData = await payRes.json();
      if (!payData.success) {
        showToast(payData.message || t('pharmacy_toast.bill_generated_payment_failed', 'Bill generated but payment could not be recorded.'), "error");
        if (triggerBtn) triggerBtn.disabled = false;
        return;
      }

      showToast(t('pharmacy_toast.paid_bill', 'Paid — bill {invoiceNumber} for ₹{amount}.', { invoiceNumber: genData.invoiceNumber, amount: genData.totalAmount.toFixed(2) }), "success");
      await Promise.all([loadReadyToBill(), loadBillingSection()]);
      window.__printInvoiceSlip(genData.invoiceId);
    } catch (err) {
      console.error("Pay & generate bill error:", err);
      showToast(t('pharmacy_toast.server_error_generating_bill', 'Server error generating bill.'), "error");
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  // --- BILLING & INVOICES ---
  let allInvoices = [];
  let billingSearchQuery = "";
  let billingFilterStatus = "all";

  async function loadBillingSection() {
    try {
      const res = await fetch("/api/pharmacy-invoices", { credentials: "same-origin" });
      const data = await res.json();
      if (data.success) {
        allInvoices = data.invoices || [];

        // Update Stats
        const stats = data.stats || {};
        document.getElementById("billingTotalBilled").textContent = "₹" + (stats.totalBilled || 0).toFixed(2);
        document.getElementById("billingCollected").textContent = "₹" + (stats.collected || 0).toFixed(2);
        document.getElementById("billingPendingCount").textContent = stats.pendingCount || 0;

        applyBillingFilters();
      }
    } catch (err) {
      console.error("Error loading billing section:", err);
    }
  }

  function applyBillingFilters() {
    let filtered = allInvoices;

    // Filter status
    if (billingFilterStatus === 'paid') {
      filtered = filtered.filter(i => i.payment_status === 'Paid');
    } else if (billingFilterStatus === 'pending') {
      filtered = filtered.filter(i => i.payment_status !== 'Paid');
    }

    // Search query
    if (billingSearchQuery) {
      const q = billingSearchQuery.toLowerCase();
      filtered = filtered.filter(i => 
        (i.invoice_number && i.invoice_number.toLowerCase().includes(q)) ||
        (i.patient_name && i.patient_name.toLowerCase().includes(q)) ||
        (i.patient_uhid && i.patient_uhid.toLowerCase().includes(q))
      );
    }

    renderBillingTable(filtered);
  }

  // One card per patient — every invoice they have, paid or pending, rolls up into a
  // single combined bill instead of one row per billing event.
  function renderBillingTable(invoices) {
    const container = document.getElementById("billingCardsContainer");
    const emptyState = document.getElementById("billingEmptyState");

    if (!container || !emptyState) return;

    if (!invoices || invoices.length === 0) {
      container.innerHTML = "";
      emptyState.style.display = "block";
      return;
    }

    emptyState.style.display = "none";

    const groups = [];
    const groupIndexByUhid = new Map();
    invoices.forEach((inv) => {
      const key = inv.patient_uhid;
      if (!groupIndexByUhid.has(key)) {
        groupIndexByUhid.set(key, groups.length);
        groups.push({ patient_uhid: inv.patient_uhid, patient_name: inv.patient_name, invoices: [] });
      }
      groups[groupIndexByUhid.get(key)].invoices.push(inv);
    });

    container.innerHTML = groups.map((group) => {
      const totalAmount = group.invoices.reduce((s, i) => s + (parseFloat(i.total_amount) || 0), 0);
      const totalItems = group.invoices.reduce((s, i) => s + (i.item_count || 0), 0);
      const allPaid = group.invoices.every((i) => i.payment_status === 'Paid');
      const anyPaid = group.invoices.some((i) => i.payment_status === 'Paid');
      const statusLabel = allPaid ? 'Paid' : (anyPaid ? 'Partially Paid' : 'Pending');
      const statusBadge = allPaid
        ? `<span style="background: #ecfdf5; color: #047857; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 12px;">${statusLabel}</span>`
        : `<span style="background: #fef3c7; color: #b45309; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 12px;">${statusLabel}</span>`;

      const methods = [...new Set(group.invoices.filter((i) => i.payment_status === 'Paid').map((i) => i.payment_type || 'Cash'))];
      const methodBadge = methods.length
        ? methods.map((m) => `<span style="background: #f1f5f9; color: #475569; padding: 3px 10px; border-radius: 6px; font-weight: 600; font-size: 12px; border: 1px solid #e2e8f0; margin-right:4px;">${escapeHtml(m)}</span>`).join("")
        : `<span style="color:#94a3b8; font-size:12px;">&mdash;</span>`;

      const invoiceIds = group.invoices.map((i) => i.id).join(",");
      const pendingInvoiceIds = group.invoices.filter((i) => i.payment_status !== 'Paid').map((i) => i.id).join(",");
      const invoiceRefs = group.invoices
        .map((i) => `${escapeHtml(i.invoice_number)}${i.payment_status === 'Paid' ? '' : ' (pending)'}`)
        .join(', ');

      const markPaidBtn = !allPaid
        ? `<button class="mark-remaining-paid-btn" data-pending-ids="${pendingInvoiceIds}" style="padding: 6px 14px; background: #0f766e; color: white; border: none; border-radius: 8px; font-weight: 600; font-size: 12px; cursor: pointer;">Mark Paid</button>`
        : '';

      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 18px; background: white;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap: 16px; flex-wrap: wrap;">
            <div>
              <div style="font-weight:700; font-size:15px; color:#0f172a;">${escapeHtml(group.patient_name)}</div>
              <div style="font-size:12.5px; color:#64748b; margin-top:2px;">${escapeHtml(group.patient_uhid)} &bull; ${totalItems} item(s) across ${group.invoices.length} bill${group.invoices.length > 1 ? 's' : ''}</div>
              <div style="font-size:11px; color:#94a3b8; margin-top:4px;">${invoiceRefs}</div>
            </div>
            <div style="display:flex; align-items:center; gap: 14px; flex-wrap: wrap;">
              <div style="text-align:right;">
                <div style="font-size:19px; font-weight:700; font-family:serif; color:#0f172a;">₹${totalAmount.toFixed(2)}</div>
                <div style="margin-top:4px;">${statusBadge}</div>
              </div>
              <div>${methodBadge}</div>
              <div style="display:flex; gap:6px;">
                ${markPaidBtn}
                <button class="print-combined-btn" data-invoice-ids="${invoiceIds}" style="display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; background: white; border: 1px solid #cbd5e1; color: #334155; border-radius: 8px; font-weight: 500; font-size: 12px; cursor: pointer;">
                  <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print Bill
                </button>
              </div>
            </div>
          </div>
        </div>`;
    }).join("");

    container.querySelectorAll(".print-combined-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const invoiceIds = btn.dataset.invoiceIds.split(",").map(Number);
        window.__printCombinedBill(invoiceIds);
      });
    });

    container.querySelectorAll(".mark-remaining-paid-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pendingIds = btn.dataset.pendingIds.split(",").filter(Boolean).map(Number);
        await markMultiplePaid(pendingIds);
      });
    });
  }

  async function markMultiplePaid(invoiceIds) {
    try {
      await Promise.all(
        invoiceIds.map((id) =>
          fetch(`/api/pharmacy-invoices/${id}/pay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ paymentType: "Cash" }),
          })
        )
      );
      showToast(t('pharmacy_toast.marked_as_paid', 'Marked as Paid.'), "success");
      loadBillingSection();
    } catch (err) {
      console.error("Mark remaining paid error:", err);
      showToast(t('pharmacy_toast.server_error_period', 'Server error.'), "error");
    }
  }

  // Merges every invoice for one patient into a single printed bill.
  window.__printCombinedBill = async function (invoiceIds) {
    try {
      const invoicesForPatient = allInvoices.filter((i) => invoiceIds.includes(i.id));
      if (invoicesForPatient.length === 0) return alert(t('pharmacy_toast.invoice_not_found', 'Invoice not found.'));

      const itemsResults = await Promise.all(
        invoiceIds.map((id) => fetch(`/api/pharmacy-invoices/${id}/items`, { credentials: "same-origin" }).then((r) => r.json()))
      );

      let items = [];
      let doctorName = "N/A";
      itemsResults.forEach((res, idx) => {
        if (res.success && res.items.length > 0) {
          if (doctorName === "N/A") doctorName = res.items[0].doctor_user_id || "N/A";
          items = items.concat(
            res.items.map((it) => ({
              medName: it.medicine_name,
              dosage: it.dosage,
              duration: it.duration,
              amount: parseFloat(it.amount) || 0,
            }))
          );
        } else {
          const inv = invoicesForPatient[idx];
          items.push({
            medName: `Prescription Medicine (${inv.item_count} item)`,
            dosage: "As Prescribed",
            duration: "N/A",
            amount: parseFloat(inv.total_amount) || 0,
          });
        }
      });

      const totalAmount = invoicesForPatient.reduce((s, i) => s + (parseFloat(i.total_amount) || 0), 0);
      const allPaid = invoicesForPatient.every((i) => i.payment_status === 'Paid');
      const first = invoicesForPatient[0];
      const dateStr = first.created_at ? new Date(first.created_at).toLocaleString() : new Date().toLocaleString();

      openPrintWindow({
        title: "PHARMACY INVOICE & RECEIPT",
        slipNo: invoicesForPatient.map((i) => i.invoice_number).join(', '),
        dateStr,
        patientName: first.patient_name,
        uhid: first.patient_uhid,
        doctor: doctorName,
        items,
        amount: `₹${totalAmount.toFixed(2)}`,
        status: allPaid ? "PAID" : "PARTIALLY PAID",
      });
    } catch (err) {
      console.error(err);
      alert(t('pharmacy_toast.print_error', 'Print error.'));
    }
  };

  // --- CSV EXPORT FOR SALES REPORT ---
  function exportBillingCSV() {
    if (allInvoices.length === 0) return showToast(t('pharmacy_toast.no_invoices_export', 'No invoices available to export.'), "info");

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Invoice Number,Patient Name,UHID,Payment Type,Items Count,Total Amount,Status,Date\n";

    allInvoices.forEach(inv => {
      const dateStr = inv.created_at ? new Date(inv.created_at).toLocaleString() : 'N/A';
      const row = [
        `"${inv.invoice_number || ''}"`,
        `"${inv.patient_name || ''}"`,
        `"${inv.patient_uhid || ''}"`,
        `"${inv.payment_type || 'Cash'}"`,
        inv.item_count || 1,
        (parseFloat(inv.total_amount) || 0).toFixed(2),
        `"${inv.payment_status || 'Pending'}"`,
        `"${dateStr}"`
      ].join(",");
      csvContent += row + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const today = new Date().toISOString().split('T')[0];
    link.setAttribute("download", `pharmacy_sales_report_${today}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const btnExportBilling = document.getElementById("btnExportBillingReport");
  if (btnExportBilling) btnExportBilling.addEventListener("click", exportBillingCSV);

  // Billing Search & Filter Event Listeners
  const billingSearchInput = document.getElementById("billingSearchInput");
  if (billingSearchInput) {
    billingSearchInput.addEventListener("input", (e) => {
      billingSearchQuery = e.target.value.trim();
      applyBillingFilters();
    });
  }

  const filterBillAll = document.getElementById("filterBillAll");
  const filterBillPaid = document.getElementById("filterBillPaid");
  const filterBillPending = document.getElementById("filterBillPending");

  if (filterBillAll && filterBillPaid && filterBillPending) {
    filterBillAll.addEventListener("click", () => {
      billingFilterStatus = "all";
      filterBillAll.classList.add("active");
      filterBillPaid.classList.remove("active");
      filterBillPending.classList.remove("active");
      applyBillingFilters();
    });

    filterBillPaid.addEventListener("click", () => {
      billingFilterStatus = "paid";
      filterBillPaid.classList.add("active");
      filterBillAll.classList.remove("active");
      filterBillPending.classList.remove("active");
      applyBillingFilters();
    });

    filterBillPending.addEventListener("click", () => {
      billingFilterStatus = "pending";
      filterBillPending.classList.add("active");
      filterBillAll.classList.remove("active");
      filterBillPaid.classList.remove("active");
      applyBillingFilters();
    });
  }

  window.__markInvoicePaidModal = function(invoiceId) {
    const inv = allInvoices.find(i => String(i.id) === String(invoiceId));
    if (!inv) {
      console.warn("Invoice not found in list for ID:", invoiceId);
      return;
    }

    const modal = document.getElementById("payModal");
    if (!modal) {
      console.warn("payModal element not found");
      return;
    }

    document.getElementById("payInvoiceId").value = invoiceId;
    document.getElementById("payModalInvoiceNum").textContent = `Invoice #${inv.invoice_number}`;
    document.getElementById("payModalAmount").textContent = `₹${(parseFloat(inv.total_amount) || 0).toFixed(2)}`;

    modal.classList.add("show");
    modal.style.display = "flex";
  };

  function setupPayModal() {
    const modal = document.getElementById("payModal");
    const closeBtn = document.getElementById("closePayModal");
    const closeBtn2 = document.getElementById("closePayModal2");
    const payForm = document.getElementById("payForm");

    if (!modal) return;

    function hidePayModal() {
      modal.classList.remove("show");
      modal.style.display = "none";
    }

    if (closeBtn) closeBtn.addEventListener("click", hidePayModal);
    if (closeBtn2) closeBtn2.addEventListener("click", hidePayModal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) hidePayModal();
    });

    // Toggle active state on pay tiles
    const payTiles = modal.querySelectorAll(".pay-tile");
    payTiles.forEach(tile => {
      tile.addEventListener("click", () => {
        payTiles.forEach(t => t.classList.remove("active"));
        tile.classList.add("active");
        const radio = tile.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      });
    });

    if (payForm) {
      payForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const invoiceId = document.getElementById("payInvoiceId").value;
        const selectedRadio = document.querySelector('input[name="payMethod"]:checked');
        const method = selectedRadio ? selectedRadio.value : "Cash";

        hidePayModal();

        // Cash/UPI/Card here just record what the pharmacist collected in
        // person — "Razorpay" is the one method where the app itself takes
        // the payment, so it's the only one that goes through real Checkout
        // + server-side signature verification instead of self-reporting.
        if (method === "Razorpay") {
          const inv = allInvoices.find((i) => String(i.id) === String(invoiceId));
          try {
            await window.MedisysPayments.payViaRazorpay({
              createOrderUrl: `/api/pharmacy-invoices/${invoiceId}/create-order`,
              verifyUrl: `/api/pharmacy-invoices/${invoiceId}/verify-payment`,
              name: "MEDISYS Pharmacy",
              description: inv ? `Invoice #${inv.invoice_number}` : "Pharmacy invoice",
            });
            showToast(t('pharmacy_toast.payment_collected', 'Payment collected! Invoice marked as Paid.'), "success");
            loadBillingSection();
          } catch (err) {
            if (!err.dismissed) showToast(err.message, "error");
          }
          return;
        }

        if (invoiceId) {
          await window.__markInvoicePaid(invoiceId, method);
        }
      });
    }
  }

  // --- PRINT SLIP UTILITIES ---
  window.__printPrescriptionSlip = function(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return alert(t('pharmacy_toast.order_not_found', 'Order details not found.'));
    
    const now = new Date();
    const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});

    openPrintWindow({
      title: "PHARMACY DISPENSING SLIP",
      slipNo: `SLIP-${order.id}`,
      dateStr: dateStr,
      patientName: order.patient_name || 'Patient (' + order.patient_uhid + ')',
      uhid: order.patient_uhid,
      doctor: order.doctor_user_id,
      medName: order.medicine_name,
      dosage: order.dosage,
      duration: order.duration + " Days",
      amount: order.amount ? `₹${parseFloat(order.amount).toFixed(2)}` : '₹15.00',
      status: 'DISPENSED'
    });
  };

  window.__printInvoiceSlip = async function(invoiceId) {
    try {
      const [invRes, itemsRes] = await Promise.all([
        fetch("/api/pharmacy-invoices", { credentials: "same-origin" }),
        fetch(`/api/pharmacy-invoices/${invoiceId}/items`, { credentials: "same-origin" }),
      ]);
      const data = await invRes.json();
      const itemsData = await itemsRes.json();
      if (!data.success) return alert(t('pharmacy_toast.error_fetching_invoice', 'Error fetching invoice.'));

      const inv = data.invoices.find(i => i.id === invoiceId);
      if (!inv) return alert(t('pharmacy_toast.invoice_not_found', 'Invoice not found.'));

      const items = (itemsData.success && itemsData.items.length > 0)
        ? itemsData.items.map(it => ({
            medName: it.medicine_name,
            dosage: it.dosage,
            duration: it.duration,
            amount: parseFloat(it.amount) || 0,
          }))
        : [{ medName: `Prescription Medicine (${inv.item_count} item)`, dosage: "As Prescribed", duration: "N/A", amount: parseFloat(inv.total_amount) || 0 }];

      const doctorName = (itemsData.success && itemsData.items[0]) ? itemsData.items[0].doctor_user_id : "N/A";
      const dateStr = inv.created_at ? new Date(inv.created_at).toLocaleString() : new Date().toLocaleString();

      openPrintWindow({
        title: "PHARMACY INVOICE & RECEIPT",
        slipNo: inv.invoice_number,
        dateStr: dateStr,
        patientName: inv.patient_name,
        uhid: inv.patient_uhid,
        doctor: doctorName,
        items,
        amount: `₹${(parseFloat(inv.total_amount) || 0).toFixed(2)}`,
        status: inv.payment_status.toUpperCase()
      });
    } catch (err) {
      console.error(err);
      alert(t('pharmacy_toast.print_error', 'Print error.'));
    }
  };

  function openPrintWindow(info) {
    const hospName = (sessionUser && sessionUser.hospitalName) ? sessionUser.hospitalName.toUpperCase() : 'CORE5 MEDISYS HOSPITAL';
    const pharmacistName = (sessionUser && (sessionUser.fullName || sessionUser.userId)) ? sessionUser.fullName || sessionUser.userId : 'Staff';

    // Single-medicine callers (legacy) pass medName/dosage/duration/amount directly;
    // bill callers pass a proper items[] array. Normalize to one shape here.
    const items = Array.isArray(info.items) && info.items.length > 0
      ? info.items
      : [{ medName: info.medName, dosage: info.dosage, duration: info.duration, amount: info.amount }];

    const rows = items.map((it) => `
      <tr>
        <td><strong>${escapeHtml(it.medName)}</strong></td>
        <td>${escapeHtml(it.dosage || '—')}</td>
        <td>${escapeHtml(it.duration || '—')}</td>
        <td style="text-align: right;">${typeof it.amount === 'number' ? '₹' + it.amount.toFixed(2) : escapeHtml(String(it.amount ?? '—'))}</td>
      </tr>`).join("");

    const printWin = window.open('', '_blank', 'width=650,height=700');
    if (!printWin) return alert(t('pharmacy_toast.allow_popups', 'Please allow popups to print the receipt.'));

    printWin.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${info.title} - ${info.slipNo}</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 30px; color: #1e293b; line-height: 1.5; }
          .header { text-align: center; border-bottom: 2px solid #0f2f6e; padding-bottom: 15px; margin-bottom: 20px; }
          .header h1 { font-size: 22px; margin: 0; color: #0f2f6e; letter-spacing: 0.5px; text-transform: uppercase; }
          .header p { font-size: 13px; color: #64748b; margin: 4px 0 0 0; }
          .meta-grid { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; background: #f8fafc; padding: 12px 16px; border-radius: 8px; border: 1px solid #e2e8f0; }
          .table { width: 100%; border-collapse: collapse; margin-bottom: 25px; font-size: 13px; }
          .table th { background: #0f2f6e; color: white; text-align: left; padding: 10px 12px; border-radius: 4px; }
          .table td { padding: 12px; border-bottom: 1px solid #e2e8f0; }
          .total-box { text-align: right; font-size: 16px; font-weight: bold; margin-bottom: 30px; }
          .footer { margin-top: 40px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 12px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 20px; }
          .stamp { font-weight: 600; color: #0f2f6e; }
          @media print {
            body { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${escapeHtml(hospName)}</h1>
          <p>Pharmacy Department &bull; Tax Invoice / Dispensing Bill</p>
        </div>

        <div class="meta-grid">
          <div>
            <strong>Receipt No:</strong> ${info.slipNo}<br/>
            <strong>Patient Name:</strong> ${escapeHtml(info.patientName)}<br/>
            <strong>UHID:</strong> ${escapeHtml(info.uhid)}
          </div>
          <div style="text-align: right;">
            <strong>Date &amp; Time:</strong> ${info.dateStr}<br/>
            <strong>Prescribed By:</strong> Dr. ${escapeHtml(info.doctor)}<br/>
            <strong>Status:</strong> <span class="stamp">${info.status}</span>
          </div>
        </div>

        <table class="table">
          <thead>
            <tr>
              <th>Item / Medicine</th>
              <th>Dosage</th>
              <th>Duration</th>
              <th style="text-align: right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <div class="total-box">
          Total Amount: <span style="color: #0f2f6e;">${info.amount}</span>
        </div>

        <div class="footer">
          <div>
            Thank you for visiting! Wish you good health.<br/>
            <em>* Computer generated slip. Signature not mandatory.</em>
          </div>
          <div style="text-align: right;">
            <br/><br/>
            ________________________<br/>
            Pharmacist: <strong>${escapeHtml(pharmacistName)}</strong>
          </div>
        </div>

        <script>
          window.onload = function() {
            window.print();
          };
        </script>
      </body>
      </html>
    `);
    printWin.document.close();
  };

  window.__markInvoicePaid = async function(invoiceId, paymentType = "Cash") {
    try {
      const res = await fetch(`/api/pharmacy-invoices/${invoiceId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentType }),
        credentials: "same-origin"
      });
      const data = await res.json();
      if (data.success) {
        showToast(t('pharmacy_toast.payment_collected', 'Payment collected! Invoice marked as Paid.'), "success");
        loadBillingSection();
      } else {
        showToast(t('pharmacy_toast.failed_mark_paid_prefix', 'Failed to mark as paid: ') + data.message, "error");
      }
    } catch (err) {
      console.error("Mark paid error:", err);
      showToast(t('pharmacy_toast.server_error_retry', 'Server error. Please try again.'), "error");
    }
  };

  const navInteraction = document.getElementById("navInteraction");
  const sectionInteraction = document.getElementById("sectionInteraction");

  const originalHideAllSections = hideAllSections;
  hideAllSections = function() {
    originalHideAllSections();
    if (sectionInteraction) sectionInteraction.hidden = true;
  };

  if (navBilling) {
    navBilling.addEventListener("click", () => {
      hideAllSections();
      navBilling.classList.add("active");
      if (sectionBilling) sectionBilling.hidden = false;
      loadReadyToBill();
      loadBillingSection();
    });
  }

  if (navInteraction) {
    navInteraction.addEventListener("click", async () => {
      hideAllSections();
      navInteraction.classList.add("active");
      if (sectionInteraction) sectionInteraction.hidden = false;

      // Load stock items for direct sale dropdown
      try {
        const stockRes = await fetch("/api/pharmacy-stock", { credentials: "same-origin" });
        const stockData = await stockRes.json();
        if (stockData.success) {
          allStock = stockData.stock;
          populateDirectSaleStockSelect();
        }
      } catch (err) {
        console.error("Error loading stock for direct sale:", err);
      }
    });
  }

  // --- DIRECT COUNTER SALE (OTC / AUTO DEDUCT) ---
  function populateDirectSaleStockSelect() {
    const select = document.getElementById("dsStockSelect");
    if (!select) return;

    if (allStock.length === 0) {
      select.innerHTML = `<option value="">-- No stock available --</option>`;
      return;
    }

    const availableStock = allStock.filter(s => s.stock_quantity > 0);
    if (availableStock.length === 0) {
      select.innerHTML = `<option value="">-- All stock items out of stock --</option>`;
      return;
    }

    select.innerHTML = `<option value="">-- Select Medicine --</option>` + availableStock.map(s => {
      return `<option value="${s.id}" data-stock="${s.stock_quantity}">${escapeHtml(s.medicine_name)} (Batch: ${escapeHtml(s.batch_number)}) - Qty: ${s.stock_quantity} left</option>`;
    }).join("");
  }

  const directSaleForm = document.getElementById("directSaleForm");
  if (directSaleForm) {
    directSaleForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const stockId = document.getElementById("dsStockSelect").value;
      const quantity = parseInt(document.getElementById("dsQuantity").value, 10);
      const patientName = document.getElementById("dsPatientName").value;
      const phone = document.getElementById("dsPhone").value;

      if (!stockId) return showToast(t('pharmacy_toast.select_medicine_stock', 'Please select a medicine from stock.'), "error");
      if (!quantity || quantity <= 0) return showToast(t('pharmacy_toast.valid_quantity', 'Please enter a valid quantity.'), "error");

      try {
        const res = await fetch("/api/pharmacy-direct-sale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stockId, quantity, patientName, phone }),
          credentials: "same-origin"
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message + t('pharmacy_toast.bill_sent_billing_suffix', ' Bill sent to Billing tab.'), "success");
          
          directSaleForm.reset();
          
          // Refresh stock & billing in real-time
          await loadPharmacyStock();
          populateDirectSaleStockSelect();
          loadBillingSection();
        } else {
          showToast(t('pharmacy_toast.failed_prefix', 'Failed: ') + data.message, "error");
        }
      } catch (err) {
        console.error("Direct sale error:", err);
        showToast(t('pharmacy_toast.server_error_retry', 'Server error. Please try again.'), "error");
      }
    });
  }

  if (navInteraction) {
    navInteraction.addEventListener("click", async () => {
      hideAllSections();
      navInteraction.classList.add("active");
      if (sectionInteraction) sectionInteraction.hidden = false;
      
      // Load latest stock and populate dropdown
      const stockRes = await fetch("/api/pharmacy-stock", { credentials: "same-origin" });
      const stockData = await stockRes.json();
      if (stockData.success) {
        allStock = stockData.stock;
        populateDirectSaleStockSelect();
      }
    });
  }

  // --- PATIENTS DIRECTORY & HISTORY ---
  let allPatients = [];
  let selectedPatient = null;

  async function loadPatientsSection(query = '') {
    try {
      const res = await fetch(`/api/pharmacy-patients?search=${encodeURIComponent(query)}`, { credentials: "same-origin" });
      const data = await res.json();
      if (data.success) {
        allPatients = data.patients || [];
        renderPatientsList();
      }
    } catch (err) {
      console.error("Error loading pharmacy patients:", err);
    }
  }

  function renderPatientsList() {
    const container = document.getElementById("patientsListContainer");
    if (!container) return;

    if (allPatients.length === 0) {
      container.innerHTML = `<p style="padding: 20px; text-align: center; color: #94a3b8; font-size: 13.5px; margin: 0;">No patients found.</p>`;
      return;
    }

    container.innerHTML = allPatients.map(p => {
      const isSelected = selectedPatient && selectedPatient.uhid === p.uhid;
      const borderStyle = isSelected ? 'border-color: var(--navy); background: #f0f3ff;' : 'border-color: #e2e8f0; background: white;';
      const lastDate = p.last_dispensed_at ? new Date(p.last_dispensed_at).toLocaleDateString() : 'No history';

      return `
        <div onclick="window.__selectPatient('${escapeHtml(p.uhid)}')" style="padding: 12px 14px; border-radius: 10px; border: 1px solid; ${borderStyle} cursor: pointer; transition: all 0.15s ease;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
            <strong style="font-size: 14px; color: #0f172a;">${escapeHtml(p.full_name || 'Patient')}</strong>
            <span style="font-size: 11px; font-weight: 700; background: #e2e8f0; color: #475569; padding: 2px 7px; border-radius: 999px;">${p.total_prescriptions || 0} Rx</span>
          </div>
          <div style="font-size: 12.5px; color: #64748b; display: flex; justify-content: space-between;">
            <span>${escapeHtml(p.uhid)}</span>
            <span>Last: ${lastDate}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  window.__selectPatient = async function(uhid) {
    selectedPatient = allPatients.find(p => p.uhid === uhid);
    renderPatientsList();

    if (!selectedPatient) return;

    // Render patient header
    const header = document.getElementById("patientDetailHeader");
    if (header) {
      header.style.display = "block";
      document.getElementById("pdName").textContent = selectedPatient.full_name || 'Patient';
      document.getElementById("pdUhid").textContent = selectedPatient.uhid;
      document.getElementById("pdGender").textContent = selectedPatient.gender || 'N/A';
      document.getElementById("pdDob").textContent = selectedPatient.dob ? selectedPatient.dob.split('T')[0] : 'N/A';
      document.getElementById("pdPrescriptionCount").textContent = `${selectedPatient.total_prescriptions || 0} Prescriptions`;
    }

    // Fetch history
    try {
      const res = await fetch(`/api/pharmacy-patients/${encodeURIComponent(uhid)}/history`, { credentials: "same-origin" });
      const data = await res.json();
      if (data.success) {
        renderPatientTimeline(data.orders || []);
      }
    } catch (err) {
      console.error("Error fetching patient history:", err);
    }
  };

  function renderPatientTimeline(history) {
    const container = document.getElementById("patientTimelineContainer");
    if (!container) return;

    if (history.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: #94a3b8;">
          <p style="margin: 0; font-size: 14px;">No pharmacy history found for this patient.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = history.map(item => {
      const dateStr = item.created_at ? new Date(item.created_at).toLocaleString() : 'N/A';
      const isDispensed = item.status === 'dispensed';
      const statusBadge = isDispensed 
        ? `<span style="background: #ecfdf5; color: #047857; padding: 3px 10px; border-radius: 6px; font-weight: 700; font-size: 11.5px;">Dispensed</span>`
        : `<span style="background: #fef3c7; color: #b45309; padding: 3px 10px; border-radius: 6px; font-weight: 700; font-size: 11.5px;">Pending</span>`;

      return `
        <div style="display: flex; gap: 16px; margin-bottom: 20px; position: relative;">
          <div style="width: 12px; height: 12px; border-radius: 50%; background: var(--navy); margin-top: 6px; flex-shrink: 0; position: relative; z-index: 2;"></div>
          <div style="flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 16px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
              <div>
                <strong style="font-size: 15px; color: #0f172a;">${escapeHtml(item.medicine_name)}</strong>
                <div style="font-size: 13px; color: #64748b; margin-top: 2px;">
                  Dose: ${escapeHtml(item.dosage)} &bull; Duration: ${escapeHtml(item.duration)} Days &bull; Dr. ${escapeHtml(item.doctor_name || item.doctor_user_id)}
                </div>
              </div>
              <div style="text-align: right;">
                ${statusBadge}
                <div style="font-size: 11.5px; color: #94a3b8; margin-top: 4px;">${dateStr}</div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  const patientSearchInput = document.getElementById("patientSearchInput");
  if (patientSearchInput) {
    let timeoutId = null;
    patientSearchInput.addEventListener("input", (e) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        loadPatientsSection(e.target.value.trim());
      }, 300);
    });
  }

  if (navPatients) {
    navPatients.addEventListener("click", () => {
      hideAllSections();
      navPatients.classList.add("active");
      if (sectionPatients) sectionPatients.hidden = false;
      loadPatientsSection();
    });
  }

  setupStockModal();
  setupThresholdModal();
  setupPayModal();

  // Nav bell badge + Low Stock tab need this from the start, not just when
  // the Medicine Stock or Low Stock tab is first opened.
  loadLowStock();
  loadPurchaseOrders();

  // Live push does the real-time work now; this is just a safety-net in case
  // a socket ever silently drops.
  setInterval(loadPharmacyOrders, 60000);

  if (window.MEDISYS_RT) {
    MEDISYS_RT.on("pharmacy_orders", () => {
      loadPharmacyOrders();
      loadReadyToBill();
    });
    MEDISYS_RT.on("pharmacy_invoices", loadBillingSection);
    // A dispense, a new/edited/deleted batch, or a threshold change can all
    // change who's low on stock — re-check on every "pharmacy_stock" push
    // (server-side, all of those already broadcast this topic).
    MEDISYS_RT.on("pharmacy_stock", () => {
      loadPharmacyStock();
      loadLowStock();
    });
    // Another pharmacist creating/cancelling/receiving a PO should update
    // this session's Orders tab + Low Stock list live too.
    MEDISYS_RT.on("pharmacy_purchase_orders", () => {
      loadPurchaseOrders();
      loadLowStock();
    });
    MEDISYS_RT.on("patients", () => loadPatientsSection());
  }

  window.addEventListener("i18n:languageChanged", () => {
    loadPharmacyOrders();
    loadPharmacyStock();
    if (window.i18n) window.i18n.applyTranslations();
  });
}

  document.addEventListener("DOMContentLoaded", init);
})();
