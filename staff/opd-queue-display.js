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

  // Same session check every other portal page does — this board still
  // shows patient names, so it stays behind normal staff login rather than
  // becoming a public unauthenticated URL. Open it once on the TV's
  // browser (or a shared kiosk account) and leave the tab logged in.
  async function guardSession() {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.user || !data.user.hospitalId) {
      window.location.href = "../index";
      return null;
    }
    if (data.user.hospitalName) {
      document.getElementById("hospitalNameHeading").innerHTML = `${escapeHtml(data.user.hospitalName)} — OPD Queue`;
    }
    return data.user;
  }

  function updateClock() {
    document.getElementById("boardClock").textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  async function loadQueue() {
    const res = await fetch("/api/opd/queue", { credentials: "same-origin" });
    const data = await res.json();
    if (!data.success) return;

    const called = data.queue.filter((v) => v.status === "called");
    const consulting = data.queue.filter((v) => v.status === "in-consultation");
    const waiting = data.queue.filter((v) => v.status === "waiting");

    // ---------- Now Calling hero strip ----------
    const heroCards = document.getElementById("heroCards");
    if (called.length === 0) {
      heroCards.innerHTML = `<div class="hero-empty">No one has been called yet — the next patient will appear here the moment a doctor calls them.</div>`;
    } else {
      heroCards.innerHTML = called
        .map(
          (v) => `<div class="hero-card">
            <div class="hero-token">#${v.token_number}</div>
            <div class="hero-info">
              <div class="hero-patient">${escapeHtml(v.patient_name || v.patient_uhid)}</div>
              <div class="hero-doctor">Dr. ${escapeHtml(v.doctor_name || v.doctor_user_id)}</div>
            </div>
            <span class="hero-pill">Please proceed</span>
          </div>`
        )
        .join("");
    }

    // ---------- In Consultation ----------
    const consultingCards = document.getElementById("consultingCards");
    const consultingEmpty = document.getElementById("consultingEmptyState");
    document.getElementById("consultingCount").textContent = consulting.length;
    if (consulting.length === 0) {
      consultingCards.innerHTML = "";
      consultingEmpty.hidden = false;
    } else {
      consultingEmpty.hidden = true;
      consultingCards.innerHTML = consulting
        .map(
          (v) => `<div class="token-card">
            <div class="token-number">#${v.token_number}</div>
            <div class="token-info">
              <div class="token-patient">${escapeHtml(v.patient_name || v.patient_uhid)}</div>
              <div class="token-doctor">Dr. ${escapeHtml(v.doctor_name || v.doctor_user_id)}</div>
            </div>
            <span class="token-status-pill">In Consultation</span>
          </div>`
        )
        .join("");
    }

    // ---------- Waiting ----------
    const waitingList = document.getElementById("waitingList");
    const waitingEmpty = document.getElementById("waitingEmptyState");
    document.getElementById("waitingCount").textContent = waiting.length;
    if (waiting.length === 0) {
      waitingList.innerHTML = "";
      waitingEmpty.hidden = false;
    } else {
      waitingEmpty.hidden = true;
      waitingList.innerHTML = waiting
        .map(
          (v) => `<div class="waiting-row">
            <span class="token-number">#${v.token_number}</span>
            <span class="token-patient">${escapeHtml(v.patient_name || v.patient_uhid)}</span>
          </div>`
        )
        .join("");
    }
  }

  function wireFullscreen() {
    const btn = document.getElementById("fullscreenBtn");
    btn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const user = await guardSession();
    if (!user) return;

    updateClock();
    setInterval(updateClock, 1000);

    loadQueue();
    wireFullscreen();

    if (window.MEDISYS_RT) {
      MEDISYS_RT.on("opd_queue", loadQueue);
    }

    // A TV tab can sit open unattended for hours — a socket can silently
    // drop without anything on this page noticing (no user around to
    // refresh). This poll is the safety net so the board can never go
    // stale for longer than 20s even if realtime misses an event.
    setInterval(loadQueue, 20000);
  });
})();
