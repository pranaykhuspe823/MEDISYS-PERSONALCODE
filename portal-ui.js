// Shared portal chrome: moves the "Back to Dashboard" link into the header's
// top-right utility cluster as a proper button, adds a page-refresh icon button
// next to Logout, and exposes window.showToast(message, type) for success/error
// confirmations. Included on every staff/hospital/admin/patient subpage.
(function () {
  function ensureI18nAssets(callback) {
    if (!document.querySelector('link[href*="language-selector.css"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/css/language-selector.css';
      document.head.appendChild(link);
    }

    var pending = 0;
    function checkDone() {
      if (pending === 0 && callback) callback();
    }

    if (!window.i18n) {
      pending++;
      var s1 = document.createElement('script');
      s1.src = '/js/language-manager.js';
      s1.onload = function () {
        if (window.i18n && typeof window.i18n.init === 'function') {
          window.i18n.init().then(function () {
            pending--;
            checkDone();
          });
        } else {
          pending--;
          checkDone();
        }
      };
      document.head.appendChild(s1);
    } else if (window.i18n && typeof window.i18n.init === 'function') {
      pending++;
      window.i18n.init().then(function () {
        pending--;
        checkDone();
      });
    }

    if (!window.MedisysLanguageSelector) {
      pending++;
      var s2 = document.createElement('script');
      s2.src = '/js/language-selector.js';
      s2.onload = function () {
        pending--;
        checkDone();
      };
      document.head.appendChild(s2);
    }

    if (pending === 0 && callback) callback();
  }

  function refreshIconSvg() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.9-6.6"/><path d="M21 4v6h-6"/></svg>';
  }

  function relocateBackLink(headerRight) {
    const backLink = document.querySelector('.portal-back-link');
    if (!backLink || backLink.dataset.portalUiMoved) return;
    backLink.dataset.portalUiMoved = 'true';
    backLink.classList.add('portal-back-btn');
    headerRight.insertBefore(backLink, headerRight.firstChild);
  }

  function injectRefreshButton(headerRight, logoutBtn) {
    if (document.getElementById('portalRefreshBtn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'portalRefreshBtn';
    btn.title = 'Refresh this page';
    btn.setAttribute('aria-label', 'Refresh');
    btn.innerHTML = refreshIconSvg();
    btn.className = (logoutBtn && logoutBtn.className ? logoutBtn.className : 'portal-logout-btn') + ' portal-refresh-btn';
    btn.addEventListener('click', function () {
      btn.classList.add('portal-refresh-spinning');
      window.location.reload();
    });
    if (logoutBtn) {
      logoutBtn.parentElement.insertBefore(btn, logoutBtn);
    } else {
      headerRight.appendChild(btn);
    }
  }

  function injectLanguageSelector(headerRight, logoutBtn) {
    if (document.getElementById('portalLangSelectorWrap')) return;
    if (!window.MedisysLanguageSelector) return;
    var wrap = window.MedisysLanguageSelector.createElement();
    wrap.id = 'portalLangSelectorWrap';
    if (logoutBtn) {
      logoutBtn.parentElement.insertBefore(wrap, logoutBtn);
    } else {
      headerRight.appendChild(wrap);
    }
  }

  function T(key, fallback, params) {
    var text = fallback || key;
    if (window.i18n && typeof window.i18n.t === 'function') {
      var res = window.i18n.t(key, params);
      if (res && res !== key) text = res;
    }
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] !== undefined ? params[k] : m;
    });
  }

  // ---- Private message bell (every staff portal header — not hospital_admin,
  // who sends these from their own dashboard, and not patient, out of scope) ----
  var STAFF_ROLES_FOR_MESSAGES = ['receptionist', 'nurse', 'doctor', 'pathology_staff', 'pharmacist', 'blood_bank_staff'];

  function bellIconSvg() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
  }

  function renderMessagesPanel(panel, messages) {
    if (!messages || messages.length === 0) {
      panel.innerHTML =
        '<div class="portal-messages-panel-header">' + T('common.messages', 'Messages') + '</div>' +
        '<div class="portal-messages-empty">' + T('common.no_messages', 'No messages yet.') + '</div>';
      return;
    }
    // Read state is only ever shown, never toggled by clicking a single item
    // here — opening the bell itself is what marks everything read (see
    // markAllReadAndClearBadge below). Keeping the "unread" highlight as
    // rendered (rather than clearing it item-by-item) lets someone still see
    // which messages were new as of this particular time they opened it.
    panel.innerHTML =
      '<div class="portal-messages-panel-header">' + T('common.messages', 'Messages') + '</div>' +
      messages.map(function (m) {
        var when = new Date(m.created_at).toLocaleString();
        return '<div class="portal-message-item' + (m.is_read ? '' : ' unread') + '">' +
          '<div class="portal-message-from">' + escapeHtmlLocal(m.from_name) + '</div>' +
          '<div class="portal-message-text">' + escapeHtmlLocal(m.message) + '</div>' +
          '<div class="portal-message-time">' + escapeHtmlLocal(when) + '</div>' +
          '</div>';
      }).join('');
  }

  function escapeHtmlLocal(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var messagesBadgeEl = null;
  function updateMessagesBadge(count) {
    if (!messagesBadgeEl) return;
    if (count > 0) {
      messagesBadgeEl.textContent = count > 9 ? '9+' : String(count);
      messagesBadgeEl.hidden = false;
    } else {
      messagesBadgeEl.hidden = true;
    }
  }

  function injectMessagesBell(headerRight, logoutBtn, role) {
    if (STAFF_ROLES_FOR_MESSAGES.indexOf(role) === -1) return;
    if (document.getElementById('portalMessagesBtn')) return;

    // A <button> can't properly contain the panel's own clickable items
    // (invalid nesting, plus click-bubbling would re-toggle the button every
    // time a message inside it is clicked) — so the button and its dropdown
    // are siblings inside one positioned wrapper instead.
    var wrap = document.createElement('span');
    wrap.className = 'portal-messages-btn';
    wrap.style.display = 'inline-flex';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'portalMessagesBtn';
    btn.title = T('common.messages', 'Messages');
    btn.setAttribute('aria-label', T('common.messages', 'Messages'));
    btn.className = logoutBtn && logoutBtn.className ? logoutBtn.className : 'portal-logout-btn';
    btn.innerHTML = bellIconSvg();

    var badge = document.createElement('span');
    badge.className = 'portal-messages-badge';
    badge.hidden = true;
    btn.appendChild(badge);
    messagesBadgeEl = badge;

    var panel = document.createElement('div');
    panel.className = 'portal-messages-panel';
    panel.hidden = true;

    function loadMessages() {
      return fetch('/api/staff/messages', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.success) return;
          renderMessagesPanel(panel, data.messages);
          updateMessagesBadge(data.messages.filter(function (m) { return !m.is_read; }).length);
        })
        .catch(function () {});
    }

    // Opening the bell IS "seen" — every message gets marked read on the
    // server the moment the panel opens (not per-item), so the badge clears
    // immediately and stays cleared after a refresh or a fresh login, since
    // it's the same is_read column GET /api/staff/messages already reads.
    // Sequenced after loadMessages() resolves so the render above still
    // reflects each message's read state as of just before this call, not
    // after — otherwise everything would already show as read by the time
    // it's drawn.
    function markAllReadAndClearBadge() {
      fetch('/api/staff/messages/read-all', { method: 'POST', credentials: 'same-origin' })
        .then(function () { updateMessagesBadge(0); })
        .catch(function () {});
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      if (!panel.hidden) loadMessages().then(markAllReadAndClearBadge);
    });
    panel.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    document.addEventListener('click', function (e) {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true;
    });

    wrap.appendChild(btn);
    wrap.appendChild(panel);

    if (logoutBtn) {
      logoutBtn.parentElement.insertBefore(wrap, logoutBtn);
    } else {
      headerRight.appendChild(wrap);
    }

    loadMessages();
    if (window.MEDISYS_RT) {
      MEDISYS_RT.on('staff_messages', loadMessages);
    }
  }

  function ensureToastContainer() {
    let el = document.getElementById('toastContainer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toastContainer';
      el.className = 'toast-container';
      document.body.appendChild(el);
    }
    return el;
  }

  window.showToast = function (message, type) {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + (type || 'success');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'error' ? '⚠' : '✓';
    const text = document.createElement('span');
    text.className = 'toast-message';
    // Translate message key if message is an i18n key path
    text.textContent = window.i18n ? window.i18n.t(message) : message;
    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);
    requestAnimationFrame(function () {
      toast.classList.add('toast-show');
    });
    const AUTO_DISMISS_MS = 4200;
    const remove = function () {
      toast.classList.remove('toast-show');
      setTimeout(function () {
        toast.remove();
      }, 250);
    };
    const timer = setTimeout(remove, AUTO_DISMISS_MS);
    toast.addEventListener('click', function () {
      clearTimeout(timer);
      remove();
    });
  };

  // ---- Persistent sidebar app-shell (staff/*.html pages only) ----
  var NAV_ICONS = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>',
    registration: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 13l2 2 4-4"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
    admission: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5a3 3 0 0 0 6 0V3"/><path d="M12 11v4a5 5 0 0 0 10 0v-2"/><circle cx="21" cy="10" r="1.6"/></svg>',
    vitals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>',
    ward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l9-5 9 5v13M9 21v-6h6v6"/></svg>',
    bed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M3 18v2M21 18v2M6 10V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><circle cx="16" cy="9" r="2.6"/><path d="M2.5 20c0-3.3 2.6-5.6 5.5-5.6s5.5 2.3 5.5 5.6M14.5 14.9c2.4.2 4.5 2.3 4.5 5.1"/></svg>',
    bloodbank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-4 5-6 8.5-6 11a6 6 0 0 0 12 0c0-2.5-2-6-6-11z"/></svg>',
    records: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M8 13h2l1.5-3 2 6 1.5-3H16"/></svg>',
    prescription: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(45 12 12)"><rect x="4" y="9" width="16" height="6" rx="3"/><line x1="12" y1="9" x2="12" y2="15"/></g></svg>',
    bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6V2z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
    add_person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.6 2.9-6 5.5-6s5.5 2.4 5.5 6"/><path d="M18 8v6M15 11h6"/></svg>',
    departments: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="15" width="7" height="7" rx="1.5"/><rect x="14" y="15" width="7" height="7" rx="1.5"/></svg>',
    data_import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    nurse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="7" r="3.2"/><path d="M5.5 21c0-3.6 2.9-6.2 6.5-6.2S18.5 17.4 18.5 21"/><path d="M12 11.8v3.2M10.4 13.4h3.2"/></svg>',
    message: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v12H8l-4 4V5z"/></svg>',
    expense: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V19.5a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H4.5a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.04 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10.5a1.7 1.7 0 0 0 1.04-1.56V4.5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10.5a1.7 1.7 0 0 0 1.56 1.04h.01a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.04z"/></svg>',
  };

  var ROLE_NAV_ITEMS = {
    receptionist: [
      { href: '/staff/registration', icon: 'registration', label: 'Registration', i18nKey: 'navigation.registration' },
      { href: '/staff/opd', icon: 'calendar', label: 'OPD Queue', i18nKey: 'navigation.opd_queue' },
      { href: '/staff/opd-queue-board', icon: 'queue', label: 'Queue', i18nKey: 'navigation.queue_board' },
      { href: '/staff/ipd-admission', icon: 'admission', label: 'Admission', i18nKey: 'navigation.admission' },
    ],
    nurse: [
      { href: '/staff/vitals', icon: 'vitals', label: 'OPD Vitals', i18nKey: 'navigation.opd_vitals' },
      { href: '/staff/ward-setup', icon: 'ward', label: 'Ward & Bed', i18nKey: 'navigation.ward_bed' },
      { href: '/staff/bed-allocation', icon: 'bed', label: 'Bed Allocation', i18nKey: 'navigation.bed_allocation' },
      { href: '/staff/nurse-ipd', icon: 'admission', label: 'IPD Patients', i18nKey: 'navigation.ipd_patients' },
      { href: '/staff/nurse-patients', icon: 'queue', label: 'My Patients', i18nKey: 'navigation.my_patients' },
      { href: '/staff/nurse-all-patients', icon: 'queue', label: 'All Patients', i18nKey: 'navigation.all_patients' },
    ],
    doctor: [
      { href: '/staff/doctor-schedule', icon: 'clock', label: 'My Schedule', i18nKey: 'navigation.my_schedule' },
      { href: '/staff/doctor-queue', icon: 'queue', label: 'My Queue', i18nKey: 'navigation.my_queue' },
      { href: '/staff/doctor-ipd', icon: 'admission', label: 'IPD Rounds', i18nKey: 'navigation.ipd_rounds' },
      { href: '/staff/doctor-patients', icon: 'registration', label: 'My Patients', i18nKey: 'navigation.my_patients' },
    ],
    pharmacist: [{ href: '/staff/pharmacy-queue', icon: 'queue', label: 'Pharmacy Queue', i18nKey: 'navigation.pharmacy_queue' }],
    blood_bank_staff: [{ href: '/staff/blood-bank-queue', icon: 'bloodbank', label: 'Blood Bank', i18nKey: 'navigation.blood_bank' }],
    hospital_admin: [
      { href: '/hospital/add-staff', icon: 'add_person', label: 'Add Staff', i18nKey: 'navigation.add_staff' },
      { href: '/hospital/staff', icon: 'queue', label: 'Existing Staff', i18nKey: 'navigation.existing_staff' },
      { href: '/hospital/departments', icon: 'departments', label: 'Departments', i18nKey: 'navigation.departments' },
      { href: '/hospital/nurse-assignment', icon: 'nurse', label: 'Nurse Assignment', i18nKey: 'navigation.nurse_assignment' },
      { href: '/hospital/data-import', icon: 'data_import', label: 'Data Import', i18nKey: 'navigation.data_import' },
      { href: '/hospital/messages', icon: 'message', label: 'Messages', i18nKey: 'navigation.messages' },
      { href: '/hospital/expenses', icon: 'expense', label: 'Expense Log', i18nKey: 'navigation.expense_log' },
      { href: '/hospital/settings', icon: 'settings', label: 'Hospital Settings', i18nKey: 'navigation.hospital_settings' },
    ],
    patient: [
      { href: '/patient/records', icon: 'records', label: 'Medical Records', i18nKey: 'navigation.medical_records' },
      { href: '/patient/appointments', icon: 'calendar', label: 'Appointments', i18nKey: 'navigation.appointments' },
      { href: '/patient/prescriptions', icon: 'prescription', label: 'Prescriptions', i18nKey: 'navigation.prescriptions' },
      { href: '/patient/bills', icon: 'bill', label: 'Bills & Invoices', i18nKey: 'navigation.billing' },
    ],
  };

  var ROLE_DASHBOARD = { patient: '/patient/dashboard.html', hospital_admin: '/hospital/dashboard.html' };

  function navItemsForRole(role, details) {
    var dash = { href: ROLE_DASHBOARD[role] || '/staff/dashboard.html', icon: 'dashboard', label: 'Dashboard', i18nKey: 'navigation.dashboard' };
    var items;
    if (role === 'pathology_staff') {
      items =
        details && details.designation === 'Radiologist'
          ? [{ href: '/staff/radiology-queue', icon: 'queue', label: 'Radiology Queue', i18nKey: 'navigation.radiology_queue' }]
          : [{ href: '/staff/pathology-queue', icon: 'queue', label: 'Pathology & Lab', i18nKey: 'navigation.pathology_lab' }];
    } else {
      items = ROLE_NAV_ITEMS[role] || [];
    }
    return [dash].concat(items);
  }

  function injectSidebar() {
    var main = document.querySelector('.portal-main');
    if (!main || document.querySelector('.app-sidebar')) return;

    var KNOWN_ROLES = ['receptionist', 'nurse', 'doctor', 'pathology_staff', 'pharmacist', 'blood_bank_staff', 'patient', 'hospital_admin'];
    fetch('/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (sessionData) {
        var role = sessionData.user && sessionData.user.role;
        if (!sessionData.user || KNOWN_ROLES.indexOf(role) === -1) return null;
        if (role !== 'pathology_staff') return { role: role, details: null };
        return fetch('/api/me', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (meData) {
            return { role: role, details: meData.success ? meData.profile.details : null };
          });
      })
      .then(function (info) {
        if (!info) return;
        var items = navItemsForRole(info.role, info.details);
        var currentPath = window.location.pathname.replace(/\/+$/, '');

        var aside = document.createElement('aside');
        aside.className = 'app-sidebar';
        var eyebrow = document.createElement('div');
        eyebrow.className = 'app-sidebar-eyebrow';
        eyebrow.setAttribute('data-i18n', 'common.navigate');
        eyebrow.textContent = window.i18n ? window.i18n.t('common.navigate') : 'Navigate';
        aside.appendChild(eyebrow);

        items.forEach(function (item) {
          var a = document.createElement('a');
          a.href = item.href;
          a.className = 'app-sidebar-link' + (currentPath === item.href ? ' active' : '');
          var translatedLabel = window.i18n && item.i18nKey ? window.i18n.t(item.i18nKey) : item.label;
          a.title = translatedLabel;
          a.innerHTML =
            '<span class="app-sidebar-icon">' + (NAV_ICONS[item.icon] || '') + '</span>' +
            '<span class="app-sidebar-label" ' + (item.i18nKey ? 'data-i18n="' + item.i18nKey + '"' : '') + '>' + translatedLabel + '</span>';
          aside.appendChild(a);
        });

        var shell = document.createElement('div');
        shell.className = 'app-shell';
        main.parentNode.insertBefore(shell, main);
        shell.appendChild(aside);
        shell.appendChild(main);
      })
      .catch(function () {});
  }

  // Swaps the header logo and footer brand name for this hospital's own
  // custom branding, if set (see POST /api/hospital/logo and POST
  // /api/hospital/brand-name) — for that hospital's admin, staff, and
  // patients only. Falls back to (and reverts back to, if branding is later
  // removed) the default CORE5 MEDISYS logo/name automatically.
  function applyHospitalBranding(hospitalId) {
    if (!hospitalId) return;

    // Logo: test-loaded via a throwaway Image() first so a hospital with no
    // custom logo (a 404) never flashes a broken-image icon over the real
    // header logo; only swaps the real <img> once the replacement has
    // actually finished loading successfully. On a 404 (no/removed custom
    // logo) it reverts to whatever the page originally shipped with.
    var logoImg = document.querySelector('.brand-logo');
    if (logoImg) {
      if (logoImg.dataset.defaultSrc === undefined) {
        logoImg.dataset.defaultSrc = logoImg.getAttribute('src');
      }
      var candidate = '/api/hospital/' + hospitalId + '/logo?v=' + Date.now();
      var probe = new Image();
      probe.onload = function () { logoImg.src = candidate; };
      probe.onerror = function () { logoImg.src = logoImg.dataset.defaultSrc; };
      probe.src = candidate;
    }

    // Footer brand text: replaces "CORE5 MEDISYS" with the hospital's own
    // name if they've set one. The small label under it ("HOSPITAL PORTAL",
    // "STAFF PORTAL", etc.) switches to a fixed "Powered by CORE5 MEDISYS"
    // attribution in that case — this line is never editable by the hospital.
    var brandEl = document.querySelector('.footer-brand');
    var labelEl = document.querySelector('.footer-left small');
    if (brandEl && brandEl.dataset.defaultText === undefined) {
      brandEl.dataset.defaultText = brandEl.textContent;
    }
    if (labelEl && labelEl.dataset.defaultText === undefined) {
      labelEl.dataset.defaultText = labelEl.textContent;
    }
    if (!brandEl && !labelEl) return;

    fetch('/api/hospital/' + hospitalId + '/branding', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var brandName = data && data.brandName;
        if (brandEl) {
          brandEl.textContent = brandName || brandEl.dataset.defaultText;
        }
        if (labelEl) {
          labelEl.textContent = brandName ? 'Powered by CORE5 MEDISYS' : labelEl.dataset.defaultText;
        }
      })
      .catch(function () {});
  }

  function initPortalUi() {
    const headerRight = document.querySelector('.portal-header-right') || document.querySelector('.topbar-right');
    const logoutBtn = document.getElementById('logoutBtn');
    if (headerRight) {
      relocateBackLink(headerRight);
      injectRefreshButton(headerRight, logoutBtn);
      injectLanguageSelector(headerRight, logoutBtn);
    }
    fetch('/api/session', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var role = data.user && data.user.role;
        if (role && headerRight) injectMessagesBell(headerRight, logoutBtn, role);
        if (data.user && data.user.hospitalId) {
          applyHospitalBranding(data.user.hospitalId);
          if (window.MEDISYS_RT) {
            MEDISYS_RT.on('hospitals', function () {
              applyHospitalBranding(data.user.hospitalId);
            });
          }
        }
      })
      .catch(function () {});
    injectSidebar();
    if (window.i18n) {
      window.i18n.applyTranslations();
    }
  }

  window.addEventListener('i18n:languageChanged', function () {
    if (window.i18n) {
      window.i18n.applyTranslations();
    }
  });

  // SECURITY — stale portal page after logout via browser back/forward: the
  // server already sends Cache-Control: no-store on every page, which stops
  // modern browsers from using the back-forward cache (bfcache) for it at
  // all — that's the real fix. This is a second, independent layer: if a
  // page is ever somehow restored from bfcache anyway (an older/unusual
  // browser, or a future regression in that header), 'pageshow' with
  // event.persisted=true is the one reliable signal for that, and it fires
  // even though DOMContentLoaded (what every page's own guardSession() runs
  // on) never fires again on a bfcache restore — a two-finger trackpad
  // swipe back after logging out is exactly this case. On that signal,
  // re-check the session for real and bounce to login if it's gone, instead
  // of trusting whatever was already sitting on screen.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.user) {
          window.location.href = '../index';
        }
      })
      .catch(function () {});
  });

  document.addEventListener('DOMContentLoaded', function () {
    ensureI18nAssets(function () {
      initPortalUi();
    });
  });
})();

