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

  const STATUS_LABEL = { waiting: "Waiting", "in-consultation": "In Consultation", completed: "Completed" };

  let doctorFees = {}; // doctorUserId -> fee
  let selectedTeleSlot = null;

  async function loadDoctorsForBooking() {
    const select = document.getElementById("teleDoctorSelect");
    if (!select) return;
    const res = await fetch("/api/opd/doctors", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) {
      select.innerHTML = `<option value="">${t('tele.could_not_load_doctors', 'Could not load doctors')}</option>`;
      return;
    }

    doctorFees = {};
    data.doctors.forEach((d) => {
      const details = (() => {
        try {
          return typeof d.details === "string" ? JSON.parse(d.details) : d.details || {};
        } catch {
          return {};
        }
      })();
      doctorFees[d.user_id] = Number(details.consultationFee) || null;
    });

    // Same doctor list opd.js uses for in-person booking, just narrowed to
    // doctors who've actually enabled telemedicine (set a fee).
    const withFee = data.doctors.filter((d) => doctorFees[d.user_id]);
    select.innerHTML = withFee.length
      ? withFee.map((d) => `<option value="${escapeHtml(d.user_id)}">${escapeHtml(d.full_name)}</option>`).join("")
      : `<option value="">${t('tele.no_doctors_enabled', 'No doctors have enabled telemedicine yet')}</option>`;
    loadSlotsForBooking();
  }

  async function loadSlotsForBooking() {
    const doctorUserId = document.getElementById("teleDoctorSelect").value;
    const date = document.getElementById("teleDateInput").value;
    const slotGrid = document.getElementById("teleSlotGrid");
    const feeHint = document.getElementById("teleFeeHint");
    const bookBtn = document.getElementById("teleBookBtn");

    selectedTeleSlot = null;
    bookBtn.disabled = true;

    const fee = doctorFees[doctorUserId];
    feeHint.textContent = fee ? t('tele.consultation_fee_amount', 'Consultation fee: ₹{fee}', { fee }) : "";

    if (!doctorUserId || !date) {
      slotGrid.innerHTML = "";
      return;
    }

    const res = await fetch(`/api/opd/slots?doctorUserId=${encodeURIComponent(doctorUserId)}&date=${encodeURIComponent(date)}`, {
      credentials: "same-origin",
    });
    const data = await res.json();
    slotGrid.innerHTML = data.success && data.slots.length
      ? data.slots.map((s) => `<button type="button" class="slot-btn" data-slot="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")
      : `<p class="portal-subtitle">${t('tele.no_open_slots', "No open slots — this doctor hasn't set availability for this date.")}</p>`;

    slotGrid.querySelectorAll(".slot-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        slotGrid.querySelectorAll(".slot-btn").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedTeleSlot = btn.dataset.slot;
        bookBtn.disabled = false;
      });
    });
  }

  function wireTeleBookingForm() {
    const doctorSelect = document.getElementById("teleDoctorSelect");
    const dateInput = document.getElementById("teleDateInput");
    const bookBtn = document.getElementById("teleBookBtn");
    const errorEl = document.getElementById("teleBookError");
    if (!doctorSelect) return;

    const today = new Date().toISOString().slice(0, 10);
    dateInput.min = today;
    dateInput.value = today;

    doctorSelect.addEventListener("change", loadSlotsForBooking);
    dateInput.addEventListener("change", loadSlotsForBooking);

    bookBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      const doctorUserId = doctorSelect.value;
      const visitDate = dateInput.value;
      const slotTime = selectedTeleSlot;
      if (!doctorUserId || !visitDate || !slotTime) return;

      if (typeof Razorpay === "undefined") {
        errorEl.textContent = t('tele.payment_page_failed', 'Payment page failed to load. Check your connection and try again.');
        return;
      }

      bookBtn.disabled = true;
      try {
        const orderRes = await fetch("/api/telemedicine/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ doctorUserId, visitDate, slotTime }),
        });
        const orderData = await orderRes.json();
        if (!orderData.success) {
          errorEl.textContent = orderData.message || t('tele.could_not_start_payment', 'Could not start payment.');
          return;
        }

        const rzp = new Razorpay({
          key: orderData.keyId,
          amount: orderData.amount,
          currency: orderData.currency,
          order_id: orderData.orderId,
          name: "MEDISYS Telemedicine",
          description: `Consultation with ${orderData.doctorName}`,
          theme: { color: "#1b2f6e" },
          handler: async (response) => {
            try {
              const verifyRes = await fetch("/api/telemedicine/verify-payment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                  razorpayOrderId: response.razorpay_order_id,
                  razorpayPaymentId: response.razorpay_payment_id,
                  razorpaySignature: response.razorpay_signature,
                }),
              });
              const verifyData = await verifyRes.json();
              if (!verifyData.success) {
                errorEl.textContent = verifyData.message || t('tele.payment_succeeded_booking_failed', 'Payment succeeded but booking could not be confirmed. Contact the hospital.');
                return;
              }
              if (window.showToast) showToast(t('tele.payment_successful_booked', 'Payment successful — appointment booked!'), "success");
              loadSlotsForBooking();
              loadAppointments();
            } catch {
              errorEl.textContent = t('tele.payment_succeeded_confirm_failed', "Payment succeeded but we couldn't confirm the booking. Contact the hospital.");
            }
          },
          modal: {
            ondismiss: () => {
              bookBtn.disabled = false;
            },
          },
        });
        rzp.on("payment.failed", (resp) => {
          errorEl.textContent = t('tele.payment_failed_prefix', 'Payment failed: ') + (resp.error?.description || t('common.please_try_again', 'Please try again.'));
          bookBtn.disabled = false;
        });
        rzp.open();
      } catch (err) {
        errorEl.textContent = t('common.unable_to_reach_server', 'Unable to reach the server. Please try again.');
      } finally {
        bookBtn.disabled = false;
      }
    });
  }

  let currentUser = null;

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "patient") {
      window.location.href = "../index";
      return null;
    }
    currentUser = data.user;
    document.getElementById("portalUser").textContent = data.user.userId;
    return data.user;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
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

  async function loadAppointments() {
    const res = await fetch("/api/patients/me/appointments", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("appointmentsTableBody");
    const emptyState = document.getElementById("appointmentsEmptyState");

    if (!data.success || data.appointments.length === 0) {
      tbody.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;

    tbody.innerHTML = data.appointments
      .map((a) => {
        const rawStatus = a.status === "completed" ? "completed" : a.status === "in-consultation" ? "in-consultation" : "waiting";
        const statusKey = a.status === "completed" ? "opd.completed" : a.status === "in-consultation" ? "opd.in_consultation" : "opd.waiting";
        const statusLabel = t(statusKey, STATUS_LABEL[a.status] || a.status);
        const statusClass = rawStatus;
        const typeLabel =
          a.source === "telemedicine" ? t('appointments.telemedicine', 'Telemedicine') : a.source === "appointment" ? t('appointments.appointment', 'Appointment') : t('appointments.walk_in', 'Walk-in');
        const canJoin = a.source === "telemedicine" && a.status !== "completed";
        return `<tr>
          <td>${escapeHtml(new Date(a.visit_date).toLocaleDateString())}</td>
          <td>${escapeHtml(a.slot_time || t('appointments.walk_in', 'Walk-in'))}</td>
          <td>${escapeHtml(a.doctor_name || a.doctor_user_id)}</td>
          <td>${escapeHtml(typeLabel)}</td>
          <td><span class="queue-status ${statusClass}">${escapeHtml(statusLabel)}</span></td>
          <td>${canJoin ? `<button type="button" class="wizard-suggest-btn join-call-btn" data-visit-id="${a.id}">📹 ${t('doctor_queue.join_call', 'Join Call')}</button>` : ""}</td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".join-call-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        window.MedisysTelemedicine.openTelemedicineCall({
          visitId: btn.dataset.visitId,
          displayName: (currentUser && currentUser.fullName) || (currentUser && currentUser.userId) || "",
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    loadAppointments();
    loadDoctorsForBooking();
    wireTeleBookingForm();
    if (window.MEDISYS_RT) {
      ["opd_queue", "consultations"].forEach((resource) => MEDISYS_RT.on(resource, loadAppointments));
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadAppointments();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
