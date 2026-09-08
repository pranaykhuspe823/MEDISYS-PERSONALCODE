(function () {
  // Was missing entirely — every t(...) call below was throwing
  // "ReferenceError: t is not defined", which silently broke both the
  // success toast and the loadSchedule() refresh right after it (the throw
  // happened before loadSchedule() could run), and also broke rendering any
  // existing schedule rows on page load. Found/fixed 2026-08-21.
  function t(key, fallback, params) {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const res = window.i18n.t(key, params);
      if (res && res !== key) return res;
    }
    const text = fallback || key;
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function formatDate(dateStr) {
    // avail_date comes back as a full ISO datetime from mysql2; keep only the date part.
    const d = new Date(dateStr);
    return `${DAY_NAMES[d.getDay()]}, ${d.toLocaleDateString()}`;
  }

  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || data.user.role !== "doctor") {
      window.location.href = "../index";
      return null;
    }
    document.getElementById("portalUser").textContent = data.user.fullName || data.user.userId;
    return data.user;
  }

  function wireLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "../index";
    });
  }

  async function loadSchedule() {
    const res = await fetch("/api/doctor/schedule", { credentials: "same-origin" });
    const data = await res.json();
    const tbody = document.getElementById("scheduleTableBody");
    const emptyState = document.getElementById("scheduleEmptyState");
    const table = document.getElementById("scheduleTable");

    if (!data.success || data.schedule.length === 0) {
      tbody.innerHTML = "";
      table.hidden = true;
      emptyState.hidden = false;
      return;
    }
    table.hidden = false;
    emptyState.hidden = true;

    tbody.innerHTML = data.schedule
      .map(
        (s) => `<tr>
          <td>${formatDate(s.avail_date)}</td>
          <td>${s.start_time}</td>
          <td>${s.end_time}</td>
          <td>${s.slot_minutes} ${t('doctor_schedule.min', 'min')}</td>
          <td><button type="button" class="icon-btn-delete delete-block-btn" data-id="${s.id}" aria-label="Remove">&times;</button></td>
        </tr>`
      )
      .join("");

    tbody.querySelectorAll(".delete-block-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/doctor/schedule/${btn.dataset.id}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        loadSchedule();
      });
    });
  }

  function wireRepeatToggle() {
    document.getElementById("repeatToggle").addEventListener("change", (e) => {
      document.getElementById("repeatOptions").hidden = !e.target.checked;
    });
  }

  function wireAddBlock() {
    document.getElementById("addBlockBtn").addEventListener("click", async () => {
      const errorEl = document.getElementById("scheduleFormError");
      errorEl.textContent = "";

      const date = document.getElementById("availDate").value;
      if (!date) {
        errorEl.textContent = t('doctor_schedule.pick_date', 'Pick a date.');
        return;
      }

      const repeat = document.getElementById("repeatToggle").checked;
      const endDate = repeat ? document.getElementById("repeatEndDate").value : undefined;
      if (repeat && !endDate) {
        errorEl.textContent = t('doctor_schedule.pick_end_date', 'Pick an end date for the range, or turn off the repeat option.');
        return;
      }
      const weekdays = repeat
        ? Array.from(document.querySelectorAll("#weekdayChecks input:checked")).map((el) => Number(el.value))
        : undefined;
      if (repeat && weekdays.length === 0) {
        errorEl.textContent = t('doctor_schedule.select_weekday', 'Select at least one day of the week to repeat on.');
        return;
      }

      const btn = document.getElementById("addBlockBtn");
      btn.disabled = true;
      try {
        const res = await fetch("/api/doctor/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            date,
            endDate,
            weekdays,
            startTime: document.getElementById("startTime").value,
            endTime: document.getElementById("endTime").value,
            slotMinutes: Number(document.getElementById("slotMinutes").value) || 15,
          }),
        });
        const data = await res.json();
        if (!data.success) {
          errorEl.textContent = data.message || t('doctor_schedule.could_not_add', 'Could not add availability.');
          return;
        }
        if (window.showToast) {
          const msg =
            data.datesRequested > 1
              ? `${t('doctor_schedule.added_avail_for', 'Added availability for')} ${data.datesCreated} ${t('doctor_schedule.of', 'of')} ${data.datesRequested} ${t('doctor_schedule.dates_dup_skipped', 'date(s) (duplicates skipped).')}`
              : t('doctor_schedule.avail_added', 'Availability added.');
          showToast(msg, "success");
        }
        loadSchedule();
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;
    wireLogout();
    wireAddBlock();
    wireRepeatToggle();
    const todayStr = new Date().toISOString().slice(0, 10);
    document.getElementById("availDate").min = todayStr;
    document.getElementById("availDate").value = todayStr;
    document.getElementById("repeatEndDate").min = todayStr;
    loadSchedule();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("consultations", loadSchedule);
    }
    window.addEventListener("i18n:languageChanged", () => {
      loadSchedule();
      if (window.i18n) window.i18n.applyTranslations();
    });
  });
})();
