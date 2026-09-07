require("dotenv").config({ quiet: true });
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const pool = require("./db");
const { ensureSchema, seedTestCatalog, seedBillingTariff } = require("./schema");
const { buildShortCode, generateStaffUserId, generateTempPassword, generateUhid } = require("./credentials");
const { ROLE_PREFIXES, ROLE_LABELS, STAFF_ROLES, DESIGNATION_PREFIXES } = require("./roles");
const { computeAvailableSlots } = require("./slots");
const { assignNurseForAdmission } = require("./nurseAssignment");
const { initRealtime, broadcast, broadcastGlobal, broadcastToUser } = require("./realtime");
const abdmService = require("./abdmService");
const razorpay = require("./razorpay");
const importRoutes = require("./importRoutes");
const { getEntity: getImportEntity } = require("./schemaRegistry");

const UPLOADS_DIR = path.join(__dirname, "uploads", "lab-results");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const labResultUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).slice(0, 10);
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const LAB_IMAGES_DIR = path.join(__dirname, "uploads", "lab-images");
fs.mkdirSync(LAB_IMAGES_DIR, { recursive: true });

const labImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LAB_IMAGES_DIR),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).slice(0, 10);
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// Voice dictation clips (doctor consult/rounds) are forwarded to the local
// AI4Bharat/NeMo service in language/ and never written to disk here.
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Per-hospital custom logo — one file per hospital, filename keyed on
// hospitalId so a re-upload naturally replaces it (see POST
// /api/hospital/logo, which also deletes the previous file explicitly
// before this would otherwise leave an orphaned old one with a different
// timestamp suffix behind).
const LOGOS_DIR = path.join(__dirname, "uploads", "hospital-logos");
fs.mkdirSync(LOGOS_DIR, { recursive: true });

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGOS_DIR),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).slice(0, 10) || ".png";
      cb(null, `hospital-${req.session.user.hospitalId}-${Date.now()}${safeExt}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});
const VOICE_SERVICE_URL = process.env.VOICE_SERVICE_URL || "http://127.0.0.1:8500";

// Server-local "today" as YYYY-MM-DD using local wall-clock fields (NOT
// toISOString/UTC — that rolls back a day for ~5.5 hours overnight in IST and any
// other UTC+ timezone). Also safe for parsing a Y-M-D string into a Date anchored at
// UTC noon, so calendar-date arithmetic (adding days, reading the weekday) never
// drifts across a local/UTC boundary either.
function todayLocalDateStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function parseDateStrUTC(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`);
}

// ---------- Disease outbreak detection ----------
//
// Doctors pick a diagnosis from this fixed list during an OPD consultation
// (see POST /api/opd/visits/:id/consultation below) — or "Other" plus free
// text for anything not on it (see MAX_DIAGNOSIS_LENGTH below), since a real
// outbreak isn't guaranteed to be one of these eleven. Kept in sync by hand
// with the <select> in staff/doctor-queue.html, the same duplication pattern
// already used for role lists between server and client (e.g. hospital.js
// ROLE_LABELS).
const DISEASE_WATCHLIST = [
  "Dengue",
  "Malaria",
  "Chikungunya",
  "Typhoid",
  "Cholera",
  "Influenza / Flu",
  "COVID-19",
  "Measles",
  "Diarrheal Disease",
  "Viral Hepatitis / Jaundice",
  "Tuberculosis",
];

// If this many-or-more cases of the same diagnosis land at one hospital within
// this many days, it's treated as a possible outbreak.
const OUTBREAK_CASE_THRESHOLD = 2;
const OUTBREAK_WINDOW_DAYS = 7;
// Matches consultations.diagnosis's column width — a free-text "Other"
// diagnosis is truncated to this rather than rejected outright.
const MAX_DIAGNOSIS_LENGTH = 100;

// No real SMS gateway is wired in anywhere in this app (see the existing OPD
// booking confirmation below) — sending real SMS in India also legally
// requires DLT sender/template registration, independent of which provider
// you'd use. This logs one summary line and is recorded in disease_alerts as
// "notified" so the rest of the feature (detection, admin portal, counts) is
// fully wired; swapping in a real provider later only means replacing this
// one function.
function simulateOutbreakSms(recipientCount, areaLabel, message) {
  console.log(`[stub] SMS: "${message}" sent to ${recipientCount} patient(s) in ${areaLabel}.`);
}

// Runs after every consultation that records a diagnosis — a watchlist pick
// or free "Other" text alike, matched as plain equality (MySQL's default
// utf8mb4_0900_ai_ci collation is already case/accent-insensitive, so
// "Zika Fever" from one doctor and "zika fever" from another count as the
// same disease with no extra normalization needed here). Counts cases of
// that diagnosis at this hospital in the trailing window; if the count
// crosses the threshold and no alert has already fired for this
// hospital+diagnosis within the window (so it doesn't re-fire on every
// subsequent case), it (a) simulates an SMS fan-out to the hospital's own
// patients and to patients of *other* hospitals in the same city ("nearby
// areas" — this app has no patient-level geocoding, so city match is the
// closest available proxy), (b) records the alert, and (c) pushes it to the
// hospital admin's portal in real time via the existing broadcast() — scoped
// to this hospital's room only, per hospitalId, so it is never visible to
// any other hospital's admin. Only aggregate counts are ever stored/sent —
// never another hospital's patient list — so this can't leak cross-tenant PII.
async function checkDiseaseOutbreak(req, hospitalId, diagnosis) {
  if (!diagnosis) return null;

  const [[{ caseCount }]] = await pool.query(
    `SELECT COUNT(*) AS caseCount FROM consultations
     WHERE hospital_id = ? AND diagnosis = ? AND created_at >= NOW() - INTERVAL ? DAY`,
    [hospitalId, diagnosis, OUTBREAK_WINDOW_DAYS]
  );
  if (caseCount < OUTBREAK_CASE_THRESHOLD) return null;

  const [alreadyAlerted] = await pool.query(
    `SELECT id FROM disease_alerts
     WHERE hospital_id = ? AND diagnosis = ? AND created_at >= NOW() - INTERVAL ? DAY LIMIT 1`,
    [hospitalId, diagnosis, OUTBREAK_WINDOW_DAYS]
  );
  if (alreadyAlerted.length > 0) return null;

  const [[hospitalRow]] = await pool.query(`SELECT name, city FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
  const hospitalName = hospitalRow?.name || "your hospital";
  const city = hospitalRow?.city || null;

  const [hospitalPatients] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM patients WHERE hospital_id = ? AND phone IS NOT NULL AND phone <> ''`,
    [hospitalId]
  );
  const hospitalPatientsNotified = hospitalPatients[0].cnt;

  let nearbyPatientsNotified = 0;
  if (city) {
    const [nearbyPatients] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM patients p
       JOIN hospitals h ON h.id = p.hospital_id
       WHERE p.hospital_id != ? AND h.city = ? AND p.phone IS NOT NULL AND p.phone <> ''`,
      [hospitalId, city]
    );
    nearbyPatientsNotified = nearbyPatients[0].cnt;
  }

  const message = `MEDISYS ALERT: A rise in ${diagnosis} cases has been reported near ${hospitalName}. If you notice symptoms, please consult a doctor promptly.`;
  if (hospitalPatientsNotified > 0) simulateOutbreakSms(hospitalPatientsNotified, `${hospitalName}`, message);
  if (nearbyPatientsNotified > 0) simulateOutbreakSms(nearbyPatientsNotified, `nearby areas (${city})`, message);

  await pool.query(
    `INSERT INTO disease_alerts
       (hospital_id, diagnosis, case_count, window_days, hospital_patients_notified, nearby_patients_notified)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [hospitalId, diagnosis, caseCount, OUTBREAK_WINDOW_DAYS, hospitalPatientsNotified, nearbyPatientsNotified]
  );

  broadcast(req, "disease_alerts", { diagnosis, caseCount });

  return { diagnosis, caseCount, hospitalPatientsNotified, nearbyPatientsNotified };
}

// ---------- Generic Razorpay payment orders ----------
//
// Shared by every "collect payment" flow that isn't telemedicine (pharmacy
// invoices, blood bank billing, billing desk bills) — see payment_orders in
// schema.js. Each route below still owns its own domain-specific "mark paid"
// logic (different tables, different status columns); these two functions
// just handle the Razorpay order/signature plumbing all of them share.
async function createPaymentOrder(req, hospitalId, resourceType, resourceId, amount) {
  const receipt = `${resourceType}_${resourceId}_${Date.now()}`;
  const order = await razorpay.createOrder(amount, receipt, {
    hospitalId: String(hospitalId),
    resourceType,
    resourceId: String(resourceId),
  });
  await pool.query(
    `INSERT INTO payment_orders (hospital_id, resource_type, resource_id, amount, razorpay_order_id, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'created', ?)`,
    [hospitalId, resourceType, resourceId, amount, order.id, req.session.user.userId]
  );
  return order;
}

// Verifies the signature and flips the payment_orders row to paid/failed —
// does NOT touch the domain table (pharmacy_invoices/blood_billing/bills);
// the caller does that only after this returns ok:true, exactly mirroring how
// POST /api/telemedicine/verify-payment only inserts the opd_visits row after
// its own signature check passes.
async function verifyPaymentOrder(hospitalId, resourceType, resourceId, razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  const [rows] = await pool.query(
    `SELECT * FROM payment_orders
     WHERE razorpay_order_id = ? AND hospital_id = ? AND resource_type = ? AND resource_id = ? AND status = 'created' LIMIT 1`,
    [razorpayOrderId, hospitalId, resourceType, resourceId]
  );
  if (rows.length === 0) {
    return { ok: false, status: 404, message: "No pending payment found for this order." };
  }
  const order = rows[0];

  const isValid = razorpay.verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
  if (!isValid) {
    await pool.query(`UPDATE payment_orders SET status = 'failed', razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?`, [
      razorpayPaymentId,
      razorpaySignature,
      order.id,
    ]);
    return { ok: false, status: 400, message: "Payment verification failed. If money was deducted, it will be refunded automatically by Razorpay." };
  }

  await pool.query(
    `UPDATE payment_orders SET status = 'paid', razorpay_payment_id = ?, razorpay_signature = ?, paid_at = NOW() WHERE id = ?`,
    [razorpayPaymentId, razorpaySignature, order.id]
  );
  return { ok: true, amount: order.amount };
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
// Named so the same instance can be reused to authenticate the Socket.IO
// handshake (see initRealtime below) — a second session({...}) call would
// create a disconnected in-memory store and never find the cookie's session.
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000,
  },
});
app.use(sessionMiddleware);
// Guard against express.static serving repo-root paths it shouldn't (server source/secrets,
// SQL dumps with password hashes, and uploaded patient files) — only the frontend
// folders (html/css/js/images at the repo root) are meant to be publicly reachable.
app.use(["/server", "/database"], (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname, "..")));
// CSV/XLSX data import pipeline (hospital admin only) — see server/importRoutes.js.
app.use("/api/import", importRoutes);

function requireSuperadmin(req, res, next) {
  if (req.session.user && req.session.user.role === "superadmin") {
    return next();
  }
  return res.status(401).json({ success: false, message: "Superadmin session required." });
}

function requireHospitalAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === "hospital_admin") {
    return next();
  }
  return res.status(401).json({ success: false, message: "Hospital admin session required." });
}

function requireTenantUser(req, res, next) {
  if (req.session.user && req.session.user.hospitalId) {
    return next();
  }
  return res.status(401).json({ success: false, message: "Session required." });
}

// Read-only lookup for a hospital's auto-created custom fields (see
// server/importRoutes.js commit step) — this is what lets a page dynamically
// append per-hospital extra inputs/columns without any global schema change.
// A hospital admin may only ever read their own hospital's fields; a
// hospital that never imported a given field simply gets an empty list back,
// so nothing extra ever renders for hospitals that don't have that data.
app.get("/api/hospitals/:id/custom-fields", requireHospitalAdmin, async (req, res) => {
  if (Number(req.params.id) !== req.session.user.hospitalId) {
    return res.status(403).json({ success: false, message: "You can only view your own hospital's custom fields." });
  }
  const entity = getImportEntity(req.query.entity) ? req.query.entity : null;
  if (!entity) {
    return res.status(400).json({ success: false, message: "A valid entity query param is required." });
  }
  try {
    const [rows] = await pool.query(
      `SELECT field_key, field_label, field_type FROM hospital_custom_fields WHERE hospital_id = ? AND entity = ? ORDER BY field_label`,
      [req.params.id, entity]
    );
    res.json({ success: true, customFields: rows });
  } catch (err) {
    console.error("Get hospital custom fields error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// New, dedicated endpoint for the hospital admin's imported-data review screen
// (hospital/data-import.html) — deliberately not a change to the existing,
// shared GET /api/patients/search (used by staff pages this feature must not
// touch). Returns extra_fields alongside the normal columns so that screen
// can render hospital-scoped custom fields as extra table columns.
app.get("/api/hospital/patients", requireHospitalAdmin, async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const { hospitalId } = req.session.user;
    const like = `%${q}%`;
    const [rows] = q
      ? await pool.query(
          `SELECT uhid, full_name, dob, gender, phone, category, blood_group, extra_fields, created_at
           FROM patients WHERE hospital_id = ? AND (full_name LIKE ? OR phone LIKE ? OR uhid LIKE ?)
           ORDER BY created_at DESC LIMIT 100`,
          [hospitalId, like, like, like]
        )
      : await pool.query(
          `SELECT uhid, full_name, dob, gender, phone, category, blood_group, extra_fields, created_at
           FROM patients WHERE hospital_id = ? ORDER BY created_at DESC LIMIT 100`,
          [hospitalId]
        );
    res.json({ success: true, patients: rows });
  } catch (err) {
    console.error("List hospital patients error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

function requireReceptionistOrAdmin(req, res, next) {
  const role = req.session.user && req.session.user.role;
  if (role === "receptionist" || role === "hospital_admin") {
    return next();
  }
  return res.status(401).json({ success: false, message: "OPD/front-desk or admin session required." });
}

function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.session.user && req.session.user.role;
    if (roles.includes(role)) {
      return next();
    }
    return res.status(401).json({ success: false, message: "Insufficient permissions for this action." });
  };
}

app.post("/api/login", async (req, res) => {
  const { userId, password } = req.body || {};

  if (!userId || !password) {
    return res.status(400).json({ success: false, message: "User ID and password are required." });
  }

  try {
    const [directoryRows] = await pool.query(
      "SELECT hospital_id, account_type FROM user_directory WHERE user_id = ? LIMIT 1",
      [userId]
    );

    if (directoryRows.length > 0) {
      const { hospital_id: hospitalId, account_type: accountType } = directoryRows[0];

      const [hospitalRows] = await pool.query("SELECT name FROM hospitals WHERE id = ? LIMIT 1", [
        hospitalId,
      ]);

      if (hospitalRows.length === 0) {
        return res.status(401).json({ success: false, message: "Invalid User ID or password." });
      }

      if (accountType === "patient") {
        const [patientRows] = await pool.query(
          "SELECT uhid, password_hash, full_name FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1",
          [userId, hospitalId]
        );

        if (patientRows.length === 0) {
          return res.status(401).json({ success: false, message: "Invalid User ID or password." });
        }

        const patient = patientRows[0];
        const isMatch = patient.password_hash && (await bcrypt.compare(password, patient.password_hash));

        if (!isMatch) {
          return res.status(401).json({ success: false, message: "Invalid User ID or password." });
        }

        req.session.user = {
          userId: patient.uhid,
          fullName: patient.full_name,
          role: "patient",
          hospitalId,
          hospitalName: hospitalRows[0].name,
        };

        return res.json({ success: true, user: req.session.user });
      }

      const [userRows] = await pool.query(
        "SELECT user_id, password_hash, full_name, role, details FROM users WHERE user_id = ? AND hospital_id = ? LIMIT 1",
        [userId, hospitalId]
      );

      if (userRows.length === 0) {
        return res.status(401).json({ success: false, message: "Invalid User ID or password." });
      }

      const tenantUser = userRows[0];
      const isMatch = await bcrypt.compare(password, tenantUser.password_hash);

      if (!isMatch) {
        return res.status(401).json({ success: false, message: "Invalid User ID or password." });
      }

      req.session.user = {
        userId: tenantUser.user_id,
        fullName: tenantUser.full_name,
        role: tenantUser.role,
        details: tenantUser.details || {},
        hospitalId,
        hospitalName: hospitalRows[0].name,
      };

      return res.json({ success: true, user: req.session.user });
    }

    const [rows] = await pool.query(
      "SELECT user_id, password_hash, full_name, role FROM users WHERE user_id = ? AND role = 'superadmin' LIMIT 1",
      [userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid User ID or password." });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid User ID or password." });
    }

    req.session.user = { userId: user.user_id, fullName: user.full_name, role: user.role };

    return res.json({
      success: true,
      user: { userId: user.user_id, fullName: user.full_name, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Self-service password reset — looks a User ID up the same way /api/login does
// (user_directory first, then the standalone superadmin row) and overwrites that
// account's password_hash. No prior password or extra verification is required by
// design, so anyone who knows/guesses a valid User ID can reset it — see README/
// commit notes before relying on this for real patient data.
app.post("/api/forgot-password", async (req, res) => {
  const { userId, newPassword } = req.body || {};

  if (!userId || !newPassword) {
    return res.status(400).json({ success: false, message: "User ID and new password are required." });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }

  try {
    const passwordHash = await bcrypt.hash(newPassword, 12);

    const [directoryRows] = await pool.query(
      "SELECT hospital_id, account_type FROM user_directory WHERE user_id = ? LIMIT 1",
      [userId]
    );

    if (directoryRows.length > 0) {
      const { hospital_id: hospitalId, account_type: accountType } = directoryRows[0];
      const [result] =
        accountType === "patient"
          ? await pool.query("UPDATE patients SET password_hash = ? WHERE uhid = ? AND hospital_id = ?", [
              passwordHash,
              userId,
              hospitalId,
            ])
          : await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ? AND hospital_id = ?", [
              passwordHash,
              userId,
              hospitalId,
            ]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ success: false, message: "User ID not found." });
      }
      return res.json({ success: true });
    }

    const [result] = await pool.query(
      "UPDATE users SET password_hash = ? WHERE user_id = ? AND role = 'superadmin'",
      [passwordHash, userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "User ID not found." });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error("Forgot password error:", err.message);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get("/api/hospitals", requireSuperadmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, city, state, bed_count, status, admin_name, admin_email, short_code, admin_user_id, created_at
       FROM hospitals ORDER BY created_at DESC`
    );
    res.json({ success: true, hospitals: rows });
  } catch (err) {
    console.error("List hospitals error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/hospitals/:id", requireSuperadmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, license_number, pan, hfr_id, address, city, state, pincode,
              bed_count, opd_volume, admin_name, admin_email, modules, dpdp_consent,
              status, short_code, admin_user_id, created_at
       FROM hospitals WHERE id = ? LIMIT 1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Hospital not found." });
    }

    res.json({ success: true, hospital: rows[0] });
  } catch (err) {
    console.error("Get hospital error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/hospital/me", requireHospitalAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT name, status, modules, nurse_assignment_mode, logo_path, brand_name FROM hospitals WHERE id = ? LIMIT 1",
      [req.session.user.hospitalId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Hospital not found." });
    }

    const hospital = rows[0];
    res.json({
      success: true,
      hospital: {
        ...hospital,
        logoUrl: hospital.logo_path ? `/api/hospital/${req.session.user.hospitalId}/logo` : null,
        brandName: hospital.brand_name || null,
      },
    });
  } catch (err) {
    console.error("Get hospital/me error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.patch("/api/hospital/settings", requireHospitalAdmin, async (req, res) => {
  const { nurseAssignmentMode } = req.body || {};
  if (!["ward_based", "doctor_team"].includes(nurseAssignmentMode)) {
    return res.status(400).json({ success: false, message: "A valid nurse assignment mode is required." });
  }
  try {
    await pool.query("UPDATE hospitals SET nurse_assignment_mode = ? WHERE id = ?", [
      nurseAssignmentMode,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "hospitals");
    res.json({ success: true, nurseAssignmentMode });
  } catch (err) {
    console.error("Update hospital settings error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Outbreak alerts already raised for this hospital — see checkDiseaseOutbreak() above.
// requireHospitalAdmin (not requireTenantUser) so this stays admin-only, per hospital,
// exactly as intended: never visible to another hospital's admin or to patients/staff.
app.get("/api/hospital/disease-alerts", requireHospitalAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, diagnosis, case_count, window_days, hospital_patients_notified,
              nearby_patients_notified, created_at
       FROM disease_alerts WHERE hospital_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, alerts: rows });
  } catch (err) {
    console.error("List disease alerts error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/me", requireTenantUser, async (req, res) => {
  const { userId, fullName, role, hospitalId, hospitalName, details } = req.session.user;
  const profile = { fullName, role, roleLabel: ROLE_LABELS[role] || role, hospitalName, details: details || {} };

  // Patients log in as their own UHID — surface their linked ABHA (if any) so
  // the portal can show it without a second round trip. Staff/admin roles
  // don't have a patient row, so this only runs for role === "patient".
  if (role === "patient") {
    try {
      const [rows] = await pool.query(
        "SELECT abha_id, abha_address, abha_verified, abha_link_status FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1",
        [userId, hospitalId]
      );
      if (rows.length > 0) {
        profile.abha = {
          abhaId: rows[0].abha_id || null,
          abhaAddress: rows[0].abha_address || null,
          verified: Boolean(rows[0].abha_verified),
          linkStatus: rows[0].abha_link_status || null,
        };
      }
    } catch (err) {
      console.error("Fetch patient ABHA for /api/me error:", err.message);
      // Non-fatal — profile still loads without the ABHA block.
    }
  }

  res.json({ success: true, profile });
});

app.get("/api/hospital/staff", requireHospitalAdmin, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT u.id, u.user_id, u.full_name, u.email, u.phone, u.role, u.details, u.created_at,
              d.name AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.hospital_id = ? AND u.role != 'hospital_admin'
       ORDER BY u.role, u.full_name`,
      [hospitalId]
    );
    res.json({ success: true, staff: rows });
  } catch (err) {
    console.error("List staff error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/hospital/staff", requireHospitalAdmin, async (req, res) => {
  const {
    role,
    fullName,
    email,
    phone,
    details,
    departmentId,
    userId: customUserId,
    password: customPassword,
  } = req.body || {};

  if (!STAFF_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: "A valid staff role is required." });
  }

  if (!fullName || !email) {
    return res.status(400).json({ success: false, message: "Full name and email are required." });
  }

  if (customUserId && !/^[A-Za-z0-9_-]+$/.test(customUserId)) {
    return res.status(400).json({
      success: false,
      message: "User ID can only contain letters, numbers, hyphens, and underscores.",
    });
  }

  if (customPassword && customPassword.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }

  try {
    if (customUserId) {
      const [taken] = await pool.query("SELECT user_id FROM user_directory WHERE user_id = ?", [
        customUserId,
      ]);
      if (taken.length > 0) {
        return res.status(409).json({
          success: false,
          message: `User ID "${customUserId}" is already in use. Please choose a different one.`,
        });
      }
    }

    const { hospitalId } = req.session.user;
    const [hospitalRows] = await pool.query("SELECT short_code FROM hospitals WHERE id = ? LIMIT 1", [
      hospitalId,
    ]);
    const shortCode = hospitalRows[0]?.short_code || "HOSP";

    const prefix =
      role === "pathology_staff"
        ? DESIGNATION_PREFIXES[details?.designation] || ROLE_PREFIXES.pathology_staff
        : ROLE_PREFIXES[role];
    const userId = customUserId || generateStaffUserId(prefix, shortCode);
    const password = customPassword || generateTempPassword();
    const passwordHash = await bcrypt.hash(password, 12);

    await pool.query(
      `INSERT INTO users (hospital_id, user_id, password_hash, full_name, role, email, phone, details, department_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId,
        userId,
        passwordHash,
        fullName,
        role,
        email,
        phone || null,
        JSON.stringify(details || {}),
        role === "doctor" ? departmentId || null : null,
      ]
    );

    await pool.query("INSERT INTO user_directory (user_id, hospital_id) VALUES (?, ?)", [
      userId,
      hospitalId,
    ]);

    broadcast(req, "staff");
    res.json({
      success: true,
      staff: { userId, password, role, roleLabel: ROLE_LABELS[role] || role, fullName },
    });
  } catch (err) {
    console.error("Create staff error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Sets/updates one doctor's telemedicine consultation fee (stored in users.details,
// same JSON blob as specialization/qualification/etc.) — shown to a patient before
// they pay for a telemedicine booking (see POST /api/telemedicine/create-order).
app.patch("/api/hospital/staff/:userId/fee", requireHospitalAdmin, async (req, res) => {
  const { consultationFee } = req.body || {};
  const fee = Number(consultationFee);
  if (!Number.isFinite(fee) || fee <= 0) {
    return res.status(400).json({ success: false, message: "A consultation fee greater than 0 is required." });
  }

  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT details FROM users WHERE user_id = ? AND hospital_id = ? AND role = 'doctor' LIMIT 1`,
      [req.params.userId, hospitalId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }
    const details = (() => {
      try {
        return typeof rows[0].details === "string" ? JSON.parse(rows[0].details) : rows[0].details || {};
      } catch {
        return {};
      }
    })();
    details.consultationFee = fee;

    await pool.query(`UPDATE users SET details = ? WHERE user_id = ? AND hospital_id = ?`, [
      JSON.stringify(details),
      req.params.userId,
      hospitalId,
    ]);
    broadcast(req, "staff");
    res.json({ success: true, consultationFee: fee });
  } catch (err) {
    console.error("Set doctor fee error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Bulk password reset from the Existing Staff page — either one selected
// staff member or every one of them ("Select All"), always with a password
// the admin types by hand (never auto-generated) so it can be handed to the
// affected staff directly. Scoped to this admin's own hospital and excludes
// hospital_admin rows as defense in depth, even though the Existing Staff
// page never lists them to begin with (see GET /api/hospital/staff above).
app.post("/api/hospital/staff/reset-password", requireHospitalAdmin, async (req, res) => {
  const { userIds, newPassword } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ success: false, message: "Select at least one staff member." });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }
  try {
    const { hospitalId } = req.session.user;
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const [result] = await pool.query(
      `UPDATE users SET password_hash = ? WHERE hospital_id = ? AND role != 'hospital_admin' AND user_id IN (?)`,
      [passwordHash, hospitalId, userIds]
    );
    res.json({ success: true, updatedCount: result.affectedRows, requestedCount: userIds.length });
  } catch (err) {
    console.error("Bulk staff password reset error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Hospital admin dashboard: live overview ----------
//
// Every number here is a real, live query against the exact tables every
// other feature already writes to — nothing is estimated or hardcoded.
// Revenue in particular is summed straight from each module's own
// authoritative "was this actually paid" record (bills.paid_amount already
// tracks partial cash+online payments; pharmacy_invoices/blood_billing/
// telemedicine_payments each have their own payment_status/status column) —
// deliberately NOT from the generic payment_orders table, which would
// double-count anything paid online since those three modules also log an
// entry there for the Razorpay transaction itself.
// month-over-month growth, or "how much of the current total showed up
// this month" when there's no real previous-period baseline (e.g. total
// patients before this month was 0) — never a made-up number, just the
// honest percentage that formula produces, including 0% when nothing changed.
function pctChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

app.get("/api/hospital/overview", requireHospitalAdmin, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const today = todayLocalDateStr();
    // ?date= scopes only the "today" figures (OPD visits, admitted,
    // discharged, department breakdown) to a different day for review —
    // revenue/expenses/patient growth stay tied to the real current
    // calendar month regardless, since "which month is this" isn't
    // something a single day picker should change.
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : today;
    const firstOfMonth = today.slice(0, 8) + "01";
    const firstOfLastMonthDate = new Date(`${firstOfMonth}T12:00:00Z`);
    firstOfLastMonthDate.setUTCMonth(firstOfLastMonthDate.getUTCMonth() - 1);
    const firstOfLastMonth = firstOfLastMonthDate.toISOString().slice(0, 10);

    const [[revenue]] = await pool.query(
      `SELECT
         COALESCE((SELECT SUM(paid_amount) FROM bills WHERE hospital_id = ?), 0) AS bills_total,
         COALESCE((SELECT SUM(paid_amount) FROM bills WHERE hospital_id = ? AND bill_date >= ?), 0) AS bills_month,
         COALESCE((SELECT SUM(paid_amount) FROM bills WHERE hospital_id = ? AND bill_date >= ? AND bill_date < ?), 0) AS bills_last_month,
         COALESCE((SELECT SUM(total_amount) FROM medisys_pharmacy.pharmacy_invoices WHERE hospital_id = ? AND payment_status = 'Paid'), 0) AS pharmacy_total,
         COALESCE((SELECT SUM(total_amount) FROM medisys_pharmacy.pharmacy_invoices WHERE hospital_id = ? AND payment_status = 'Paid' AND paid_at >= ?), 0) AS pharmacy_month,
         COALESCE((SELECT SUM(total_amount) FROM medisys_pharmacy.pharmacy_invoices WHERE hospital_id = ? AND payment_status = 'Paid' AND paid_at >= ? AND paid_at < ?), 0) AS pharmacy_last_month,
         COALESCE((SELECT SUM(amount) FROM blood_billing WHERE hospital_id = ? AND status = 'paid'), 0) AS blood_total,
         COALESCE((SELECT SUM(amount) FROM blood_billing WHERE hospital_id = ? AND status = 'paid' AND paid_at >= ?), 0) AS blood_month,
         COALESCE((SELECT SUM(amount) FROM blood_billing WHERE hospital_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?), 0) AS blood_last_month,
         COALESCE((SELECT SUM(amount) FROM telemedicine_payments WHERE hospital_id = ? AND status = 'paid'), 0) AS tele_total,
         COALESCE((SELECT SUM(amount) FROM telemedicine_payments WHERE hospital_id = ? AND status = 'paid' AND paid_at >= ?), 0) AS tele_month,
         COALESCE((SELECT SUM(amount) FROM telemedicine_payments WHERE hospital_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at < ?), 0) AS tele_last_month`,
      [
        hospitalId, hospitalId, firstOfMonth, hospitalId, firstOfLastMonth, firstOfMonth,
        hospitalId, hospitalId, firstOfMonth, hospitalId, firstOfLastMonth, firstOfMonth,
        hospitalId, hospitalId, firstOfMonth, hospitalId, firstOfLastMonth, firstOfMonth,
        hospitalId, hospitalId, firstOfMonth, hospitalId, firstOfLastMonth, firstOfMonth,
      ]
    );

    const [[expenses]] = await pool.query(
      `SELECT
         COALESCE(SUM(amount), 0) AS total,
         COALESCE(SUM(CASE WHEN expense_date >= ? THEN amount ELSE 0 END), 0) AS this_month,
         COALESCE(SUM(CASE WHEN expense_date >= ? AND expense_date < ? THEN amount ELSE 0 END), 0) AS last_month
       FROM hospital_expenses WHERE hospital_id = ?`,
      [firstOfMonth, firstOfLastMonth, firstOfMonth, hospitalId]
    );

    const [[patients]] = await pool.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN DATE(created_at) = ? THEN 1 ELSE 0 END) AS new_today,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_this_month,
         SUM(CASE WHEN created_at < ? THEN 1 ELSE 0 END) AS total_before_this_month
       FROM patients WHERE hospital_id = ?`,
      [today, firstOfMonth, firstOfMonth, hospitalId]
    );

    const [[census]] = await pool.query(
      `SELECT
         SUM(CASE WHEN status = 'admitted' THEN 1 ELSE 0 END) AS currently_admitted,
         SUM(CASE WHEN DATE(discharged_at) = ? THEN 1 ELSE 0 END) AS discharged_today,
         SUM(CASE WHEN discharged_at >= ? THEN 1 ELSE 0 END) AS discharged_this_month,
         SUM(CASE WHEN DATE(admitted_at) = ? THEN 1 ELSE 0 END) AS admitted_today,
         SUM(CASE WHEN admitted_at >= ? THEN 1 ELSE 0 END) AS admitted_this_month
       FROM ipd_admissions WHERE hospital_id = ?`,
      [selectedDate, firstOfMonth, selectedDate, firstOfMonth, hospitalId]
    );

    const [[opd]] = await pool.query(`SELECT COUNT(*) AS today_visits FROM opd_visits WHERE hospital_id = ? AND visit_date = ?`, [
      hospitalId,
      selectedDate,
    ]);
    const [[opdMonth]] = await pool.query(`SELECT COUNT(*) AS this_month_visits FROM opd_visits WHERE hospital_id = ? AND visit_date >= ?`, [
      hospitalId,
      firstOfMonth,
    ]);

    const [[staffCount]] = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE hospital_id = ? AND role != 'hospital_admin'`, [
      hospitalId,
    ]);

    const [[bedStats]] = await pool.query(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) AS occupied FROM beds WHERE hospital_id = ?`,
      [hospitalId]
    );

    // A visit's "department" is its doctor's department — opd_visits has no
    // department of its own. A doctor with no department set (or a visit
    // whose doctor account no longer exists) is grouped under "Other
    // Departments" rather than dropped from the chart.
    const [deptRows] = await pool.query(
      `SELECT COALESCE(d.name, 'Other Departments') AS name, COUNT(*) AS count
       FROM opd_visits v
       LEFT JOIN users u ON u.user_id = v.doctor_user_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE v.hospital_id = ? AND v.visit_date = ?
       GROUP BY COALESCE(d.name, 'Other Departments')
       ORDER BY count DESC`,
      [hospitalId, selectedDate]
    );

    const revenueTotal =
      Number(revenue.bills_total) + Number(revenue.pharmacy_total) + Number(revenue.blood_total) + Number(revenue.tele_total);
    const revenueMonth =
      Number(revenue.bills_month) + Number(revenue.pharmacy_month) + Number(revenue.blood_month) + Number(revenue.tele_month);
    const revenueLastMonth =
      Number(revenue.bills_last_month) + Number(revenue.pharmacy_last_month) + Number(revenue.blood_last_month) + Number(revenue.tele_last_month);
    const expensesTotal = Number(expenses.total);
    const expensesMonth = Number(expenses.this_month);
    const expensesLastMonth = Number(expenses.last_month);
    const netTotal = revenueTotal - expensesTotal;
    const netMonth = revenueMonth - expensesMonth;
    const netLastMonth = revenueLastMonth - expensesLastMonth;

    res.json({
      success: true,
      date: selectedDate,
      revenue: {
        total: revenueTotal,
        thisMonth: revenueMonth,
        pctChange: pctChange(revenueMonth, revenueLastMonth),
        breakdown: {
          billingDesk: Number(revenue.bills_total),
          pharmacy: Number(revenue.pharmacy_total),
          bloodBank: Number(revenue.blood_total),
          telemedicine: Number(revenue.tele_total),
        },
      },
      expenses: { total: expensesTotal, thisMonth: expensesMonth, pctChange: pctChange(expensesMonth, expensesLastMonth) },
      net: { total: netTotal, thisMonth: netMonth, pctChange: pctChange(netMonth, netLastMonth) },
      patients: {
        total: patients.total || 0,
        newToday: Number(patients.new_today) || 0,
        newThisMonth: Number(patients.new_this_month) || 0,
        pctChange: pctChange(patients.total, patients.total_before_this_month),
      },
      census: {
        currentlyAdmitted: Number(census.currently_admitted) || 0,
        dischargedToday: Number(census.discharged_today) || 0,
        dischargedThisMonth: Number(census.discharged_this_month) || 0,
        admittedToday: Number(census.admitted_today) || 0,
        admittedThisMonth: Number(census.admitted_this_month) || 0,
      },
      opdVisitsToday: opd.today_visits || 0,
      opdVisitsThisMonth: opdMonth.this_month_visits || 0,
      totalStaff: staffCount.total || 0,
      beds: {
        total: bedStats.total || 0,
        occupied: Number(bedStats.occupied) || 0,
        available: (bedStats.total || 0) - (Number(bedStats.occupied) || 0),
        occupancyPct: bedStats.total > 0 ? Math.round((Number(bedStats.occupied) / bedStats.total) * 100) : 0,
      },
      departmentBreakdown: deptRows.map((d) => ({ name: d.name, count: d.count })),
    });
  } catch (err) {
    console.error("Hospital overview error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Hospital admin dashboard: expense log ----------

app.get("/api/hospital/expenses", requireHospitalAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, category, amount, note, expense_date, created_by, created_at
       FROM hospital_expenses WHERE hospital_id = ? ORDER BY expense_date DESC, id DESC LIMIT 50`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, expenses: rows });
  } catch (err) {
    console.error("List hospital expenses error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/hospital/expenses", requireHospitalAdmin, async (req, res) => {
  const { category, amount, note, expenseDate } = req.body || {};
  const numericAmount = Number(amount);
  if (!category || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ success: false, message: "A category and an amount greater than 0 are required." });
  }
  try {
    const { hospitalId, userId } = req.session.user;
    const date = expenseDate || todayLocalDateStr();
    const [result] = await pool.query(
      `INSERT INTO hospital_expenses (hospital_id, category, amount, note, expense_date, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [hospitalId, category, numericAmount, note || null, date, userId]
    );
    broadcast(req, "hospital_expenses");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Add hospital expense error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/hospital/expenses/:id", requireHospitalAdmin, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [result] = await pool.query(`DELETE FROM hospital_expenses WHERE id = ? AND hospital_id = ?`, [req.params.id, hospitalId]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Expense entry not found." });
    }
    broadcast(req, "hospital_expenses");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete hospital expense error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Private messages: hospital admin -> one staff member ----------
//
// One-way by design (matches what was asked for): the admin composes and
// sends, the recipient sees it appear live in their own portal (via the
// message bell in portal-ui.js, fed by the same "user:<userId>" Socket.IO
// room every other real-time feature already uses) and can mark it read.

app.post("/api/hospital/messages", requireHospitalAdmin, async (req, res) => {
  const { toUserId, message } = req.body || {};
  const text = (message || "").trim();
  if (!toUserId || !text) {
    return res.status(400).json({ success: false, message: "Choose a staff member and write a message." });
  }
  try {
    const { hospitalId, userId, fullName } = req.session.user;
    const [staffRows] = await pool.query(
      `SELECT user_id FROM users WHERE user_id = ? AND hospital_id = ? AND role != 'hospital_admin' LIMIT 1`,
      [toUserId, hospitalId]
    );
    if (staffRows.length === 0) {
      return res.status(404).json({ success: false, message: "Staff member not found." });
    }
    const [result] = await pool.query(
      `INSERT INTO staff_messages (hospital_id, from_user_id, from_name, to_user_id, message) VALUES (?, ?, ?, ?, ?)`,
      [hospitalId, userId, fullName || userId, toUserId, text]
    );
    broadcastToUser(toUserId, "staff_messages");
    broadcast(req, "staff_messages_sent");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Send staff message error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/hospital/messages", requireHospitalAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.to_user_id, u.full_name AS to_name, u.role AS to_role, m.message, m.is_read, m.created_at
       FROM staff_messages m LEFT JOIN users u ON u.user_id = m.to_user_id
       WHERE m.hospital_id = ? ORDER BY m.created_at DESC LIMIT 100`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, messages: rows });
  } catch (err) {
    console.error("List sent staff messages error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Any logged-in staff member's own inbox — deliberately not role-restricted
// beyond requireTenantUser (same bar as most read-only staff endpoints in
// this file) since every staff role can receive one of these.
app.get("/api/staff/messages", requireTenantUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, from_name, message, is_read, created_at FROM staff_messages WHERE to_user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.userId]
    );
    res.json({ success: true, messages: rows });
  } catch (err) {
    console.error("List own staff messages error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/staff/messages/:id/read", requireTenantUser, async (req, res) => {
  try {
    const [result] = await pool.query(`UPDATE staff_messages SET is_read = TRUE WHERE id = ? AND to_user_id = ?`, [
      req.params.id,
      req.session.user.userId,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Mark staff message read error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Opening the message bell counts as "seen" — every message in the inbox at
// that moment is marked read in one call, so the unread badge clears the
// instant the panel opens rather than needing each message clicked one by
// one. Persisted in the same is_read column as the per-message route above,
// so it survives a refresh or a fresh login exactly the same way — there is
// no separate "seen" state living only in the browser to lose.
app.post("/api/staff/messages/read-all", requireTenantUser, async (req, res) => {
  try {
    await pool.query(`UPDATE staff_messages SET is_read = TRUE WHERE to_user_id = ? AND is_read = FALSE`, [req.session.user.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error("Mark all staff messages read error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Per-hospital custom branding (logo) ----------
//
// Once set, every portal page for this hospital — staff, hospital admin, and
// patients created by this hospital — shows this logo instead of the
// default CORE5 MEDISYS one (see portal-ui.js, which swaps the header <img>
// for anyone whose session has this hospitalId). Other hospitals and
// superadmin are unaffected: the logo URL is keyed on hospitalId, and a
// session with a different (or no) hospitalId never resolves to this one.

app.post("/api/hospital/logo", requireHospitalAdmin, logoUpload.single("logo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "Choose an image file to upload." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [[existing]] = await pool.query(`SELECT logo_path FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
    await pool.query(`UPDATE hospitals SET logo_path = ? WHERE id = ?`, [req.file.filename, hospitalId]);

    // Best-effort cleanup of the previous file — never lets a failure here
    // fail the request, since the new logo is already saved and pointed to.
    if (existing && existing.logo_path) {
      fs.unlink(path.join(LOGOS_DIR, existing.logo_path), () => {});
    }

    broadcast(req, "hospitals");
    res.json({ success: true, logoUrl: `/api/hospital/${hospitalId}/logo?v=${Date.now()}` });
  } catch (err) {
    console.error("Upload hospital logo error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/hospital/logo", requireHospitalAdmin, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [[existing]] = await pool.query(`SELECT logo_path FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
    await pool.query(`UPDATE hospitals SET logo_path = NULL WHERE id = ?`, [hospitalId]);
    if (existing && existing.logo_path) {
      fs.unlink(path.join(LOGOS_DIR, existing.logo_path), () => {});
    }
    broadcast(req, "hospitals");
    res.json({ success: true });
  } catch (err) {
    console.error("Remove hospital logo error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Deliberately public (no session guard) — a logo image is never sensitive,
// and every page that might show it (including the pre-login index.html,
// in principle) needs to be able to request it by plain <img src>, the same
// way /logo.png itself is a public static file.
app.get("/api/hospital/:id/logo", async (req, res) => {
  try {
    const [[row]] = await pool.query(`SELECT logo_path FROM hospitals WHERE id = ? LIMIT 1`, [req.params.id]);
    if (!row || !row.logo_path) {
      return res.status(404).end();
    }
    res.sendFile(path.join(LOGOS_DIR, row.logo_path), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    console.error("Serve hospital logo error:", err.message);
    res.status(500).end();
  }
});

// Custom footer/header display name — replaces "CORE5 MEDISYS" in the big
// brand text for this hospital only. Sending an empty/blank name resets to
// the default. The "Powered by CORE5 MEDISYS" attribution line is fixed in
// portal-ui.js itself and is never affected by this — hospitals can rename
// their own brand text, but the CORE5 MEDISYS attribution always stays.
app.post("/api/hospital/brand-name", requireHospitalAdmin, async (req, res) => {
  const raw = typeof req.body?.brandName === "string" ? req.body.brandName.trim() : "";
  if (raw.length > 80) {
    return res.status(400).json({ success: false, message: "Keep the name under 80 characters." });
  }
  try {
    const { hospitalId } = req.session.user;
    await pool.query("UPDATE hospitals SET brand_name = ? WHERE id = ?", [raw || null, hospitalId]);
    broadcast(req, "hospitals");
    res.json({ success: true, brandName: raw || null });
  } catch (err) {
    console.error("Update hospital brand name error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Deliberately public (no session guard), same reasoning as the logo route
// above — a display name isn't sensitive, and every portal page for staff
// and patients (not just the hospital admin) needs to read it by hospitalId
// alone to swap the footer text, the same way it swaps the header logo.
app.get("/api/hospital/:id/branding", async (req, res) => {
  try {
    const [[row]] = await pool.query(`SELECT brand_name FROM hospitals WHERE id = ? LIMIT 1`, [req.params.id]);
    res.json({ success: true, brandName: row && row.brand_name ? row.brand_name : null });
  } catch (err) {
    console.error("Get hospital branding error:", err.message);
    res.status(500).json({ success: false, brandName: null });
  }
});

app.get("/api/patients/search", requireTenantUser, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) {
    return res.json({ success: true, patients: [] });
  }

  try {
    const like = `%${q}%`;
    const [rows] = await pool.query(
      `SELECT uhid, full_name, dob, gender, phone, category, created_at
       FROM patients
       WHERE hospital_id = ? AND (full_name LIKE ? OR phone LIKE ? OR uhid LIKE ? OR abha_id = ?)
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.session.user.hospitalId, like, like, like, q]
    );
    res.json({ success: true, patients: rows });
  } catch (err) {
    console.error("Search patients error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/patients/:uhid", requireTenantUser, async (req, res) => {
  // A patient may only ever look up their own record — without this, any logged-in
  // patient could read another patient's full profile by guessing/enumerating UHIDs.
  if (req.session.user.role === "patient" && req.session.user.userId !== req.params.uhid) {
    return res.status(403).json({ success: false, message: "You can only view your own record." });
  }
  try {
    const [rows] = await pool.query(
      `SELECT uhid, full_name, dob, gender, phone, address, emergency_contact_name,
              emergency_contact_phone, abha_id, category, registered_by, created_at
       FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`,
      [req.params.uhid, req.session.user.hospitalId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Patient not found." });
    }

    res.json({ success: true, patient: rows[0] });
  } catch (err) {
    console.error("Get patient error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.patch("/api/patients/:uhid", requireRole("doctor", "receptionist", "hospital_admin"), async (req, res) => {
  const {
    fullName,
    dob,
    gender,
    phone,
    address,
    emergencyContactName,
    emergencyContactPhone,
    abhaId,
    category,
  } = req.body || {};

  if (!fullName || !fullName.trim()) {
    return res.status(400).json({ success: false, message: "Patient name is required." });
  }

  try {
    const { hospitalId } = req.session.user;
    const [result] = await pool.query(
      `UPDATE patients
       SET full_name = ?, dob = ?, gender = ?, phone = ?, address = ?,
           emergency_contact_name = ?, emergency_contact_phone = ?, abha_id = ?, category = ?
       WHERE uhid = ? AND hospital_id = ?`,
      [
        fullName.trim(),
        dob || null,
        gender || null,
        phone || null,
        address || null,
        emergencyContactName || null,
        emergencyContactPhone || null,
        abhaId || null,
        category || null,
        req.params.uhid,
        hospitalId,
      ]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Patient not found." });
    }
    broadcast(req, "patients");
    res.json({ success: true });
  } catch (err) {
    console.error("Update patient error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/patients", requireReceptionistOrAdmin, async (req, res) => {
  const {
    fullName,
    dob,
    gender,
    phone,
    address,
    emergencyContactName,
    emergencyContactPhone,
    abhaId,
    abhaAddress,
    abhaVerified,
    abhaLinkStatus,
    category,
    uhid: customUhid,
    password: customPassword,
  } = req.body || {};

  if (!fullName) {
    return res.status(400).json({ success: false, message: "Patient name is required." });
  }

  if (customUhid && !/^[A-Za-z0-9_-]+$/.test(customUhid)) {
    return res.status(400).json({
      success: false,
      message: "UHID can only contain letters, numbers, hyphens, and underscores.",
    });
  }

  if (customPassword && customPassword.length < 6) {
    return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
  }

  try {
    const { hospitalId, userId } = req.session.user;

    if (customUhid) {
      const [taken] = await pool.query("SELECT user_id FROM user_directory WHERE user_id = ?", [
        customUhid,
      ]);
      if (taken.length > 0) {
        return res.status(409).json({
          success: false,
          message: `UHID "${customUhid}" is already in use. Please choose a different one.`,
        });
      }
    }

    const [hospitalRows] = await pool.query("SELECT short_code FROM hospitals WHERE id = ? LIMIT 1", [
      hospitalId,
    ]);
    const shortCode = hospitalRows[0]?.short_code || "HOSP";

    const password = customPassword || generateTempPassword();
    const passwordHash = await bcrypt.hash(password, 12);

    const ALLOWED_ABHA_LINK_STATUSES = ["verified", "pending", "not_found"];
    const linkStatus = abhaVerified
      ? "verified"
      : ALLOWED_ABHA_LINK_STATUSES.includes(abhaLinkStatus)
      ? abhaLinkStatus
      : null;

    const [result] = await pool.query(
      `INSERT INTO patients
        (hospital_id, uhid, password_hash, full_name, dob, gender, phone, address, emergency_contact_name,
         emergency_contact_phone, abha_id, abha_address, abha_verified, abha_link_status, category, registered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId,
        customUhid || null,
        passwordHash,
        fullName,
        dob || null,
        gender || null,
        phone || null,
        address || null,
        emergencyContactName || null,
        emergencyContactPhone || null,
        abhaId || null,
        abhaAddress || null,
        abhaVerified ? 1 : 0,
        linkStatus,
        category || null,
        userId,
      ]
    );

    const uhid = customUhid || generateUhid(shortCode, result.insertId);
    if (!customUhid) {
      await pool.query(`UPDATE patients SET uhid = ? WHERE id = ?`, [uhid, result.insertId]);
    }

    await pool.query(
      "INSERT INTO user_directory (user_id, hospital_id, account_type) VALUES (?, ?, 'patient')",
      [uhid, hospitalId]
    );

    broadcast(req, "patients");
    res.json({
      success: true,
      patient: { uhid, fullName, dob, gender, phone, category, password },
    });
  } catch (err) {
    console.error("Create patient error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- ABHA (Ayushman Bharat Health Account) fetch-on-registration ----------
// Lets the receptionist pull an existing ABHA holder's demographics (name, DOB,
// gender, address, ABHA number/address) via mobile or Aadhaar + OTP, to auto-fill
// the New Patient form instead of typing everything by hand. Falls back to a
// "create a new ABHA" (Aadhaar OTP enrollment) flow if none is found.
//
// Each requested txnId is remembered server-side (short TTL, in-memory) so verify
// can't be called with an OTP for a different identifier than the one that
// actually requested it, and so stale txns don't linger.
const abdmTxns = new Map(); // txnId -> { kind: 'login'|'enroll', identifierType, identifierValue, createdAt }
const ABDM_TXN_TTL_MS = 10 * 60 * 1000;

function rememberAbdmTxn(txnId, entry) {
  abdmTxns.set(txnId, { ...entry, createdAt: Date.now() });
}
function takeAbdmTxn(txnId) {
  const entry = abdmTxns.get(txnId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ABDM_TXN_TTL_MS) {
    abdmTxns.delete(txnId);
    return null;
  }
  return entry;
}
setInterval(() => {
  const now = Date.now();
  for (const [txnId, entry] of abdmTxns) {
    if (now - entry.createdAt > ABDM_TXN_TTL_MS) abdmTxns.delete(txnId);
  }
}, 5 * 60 * 1000).unref();

// Provider outages/timeouts/missing-config all surface as PROVIDER_ERROR or
// NOT_CONFIGURED — both are reported to the frontend as `providerDown: true`
// so staff can carry on registering the patient manually (with abha_link_status
// left 'pending' for a later retry) instead of being blocked by an ABDM/Eka
// Care hiccup.
function respondAbdmError(res, err, fallbackMessage) {
  if (err.code === "INVALID_OTP") {
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err.code === "NOT_FOUND") {
    return res.status(404).json({
      success: false,
      notFound: true,
      message: "No ABHA found for this identifier. Continue with manual registration, or create a new ABHA.",
    });
  }
  if (err.code === "NOT_CONFIGURED" || err.code === "PROVIDER_ERROR") {
    console.error("ABHA provider unavailable:", err.message);
    return res.status(502).json({
      success: false,
      providerDown: true,
      message: `${fallbackMessage} You can continue with manual registration — this patient will be flagged for an ABHA retry later.`,
    });
  }
  console.error("ABHA unexpected error:", err.message);
  return res.status(502).json({ success: false, providerDown: true, message: fallbackMessage });
}

app.post("/api/abha/request-otp", requireReceptionistOrAdmin, async (req, res) => {
  const { type, value } = req.body || {};
  if (!["mobile", "aadhaar"].includes(type) || !value) {
    return res.status(400).json({ success: false, message: "A mobile number or Aadhaar number is required." });
  }
  const digits = String(value).replace(/\D/g, "");
  if (type === "mobile" && !/^[6-9]\d{9}$/.test(digits)) {
    return res.status(400).json({ success: false, message: "Enter a valid 10-digit mobile number." });
  }
  if (type === "aadhaar" && !/^\d{12}$/.test(digits)) {
    return res.status(400).json({ success: false, message: "Enter a valid 12-digit Aadhaar number." });
  }

  try {
    const { txnId } = await abdmService.requestLoginOtp(type, digits);
    rememberAbdmTxn(txnId, { kind: "login", identifierType: type, identifierValue: digits });
    res.json({ success: true, txnId, mock: abdmService.isMock(), provider: abdmService.currentProviderName() });
  } catch (err) {
    respondAbdmError(res, err, "Could not reach the ABHA provider to send an OTP.");
  }
});

app.post("/api/abha/verify-otp", requireReceptionistOrAdmin, async (req, res) => {
  const { txnId, otp } = req.body || {};
  if (!txnId || !otp) {
    return res.status(400).json({ success: false, message: "OTP is required." });
  }
  const entry = takeAbdmTxn(txnId);
  if (!entry || entry.kind !== "login") {
    return res.status(400).json({ success: false, message: "This OTP request has expired. Please fetch details again." });
  }

  try {
    const profile = await abdmService.verifyLoginOtp(txnId, String(otp).trim(), entry.identifierType);
    abdmTxns.delete(txnId);
    res.json({ success: true, profile });
  } catch (err) {
    respondAbdmError(res, err, "Could not verify the OTP with the ABHA provider.");
  }
});

// Create-a-new-ABHA fallback (Aadhaar OTP enrollment) — reuses the same OTP UI.
app.post("/api/abha/enroll/request-otp", requireReceptionistOrAdmin, async (req, res) => {
  const { aadhaar } = req.body || {};
  const digits = String(aadhaar || "").replace(/\D/g, "");
  if (!/^\d{12}$/.test(digits)) {
    return res.status(400).json({ success: false, message: "Enter a valid 12-digit Aadhaar number." });
  }

  try {
    const { txnId } = await abdmService.requestEnrollmentOtp(digits);
    rememberAbdmTxn(txnId, { kind: "enroll", identifierType: "aadhaar", identifierValue: digits });
    res.json({ success: true, txnId, mock: abdmService.isMock(), provider: abdmService.currentProviderName() });
  } catch (err) {
    respondAbdmError(res, err, "Could not reach the ABHA provider to send an OTP.");
  }
});

app.post("/api/abha/enroll/verify-otp", requireReceptionistOrAdmin, async (req, res) => {
  const { txnId, otp, mobile } = req.body || {};
  if (!txnId || !otp) {
    return res.status(400).json({ success: false, message: "OTP is required." });
  }
  const entry = takeAbdmTxn(txnId);
  if (!entry || entry.kind !== "enroll") {
    return res.status(400).json({ success: false, message: "This OTP request has expired. Please try again." });
  }

  try {
    const profile = await abdmService.verifyEnrollmentOtp(txnId, String(otp).trim(), mobile);
    abdmTxns.delete(txnId);
    res.json({ success: true, profile });
  } catch (err) {
    respondAbdmError(res, err, "Could not create the ABHA with the provider.");
  }
});

// ---------- Doctor's own patient list ----------

app.get("/api/doctor/patients", requireRole("doctor"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT p.uhid, p.full_name, p.phone, p.gender, p.dob,
              (SELECT MAX(v.created_at) FROM opd_visits v WHERE v.patient_uhid = p.uhid AND v.doctor_user_id = ?) AS last_opd_visit,
              (SELECT COUNT(*) FROM lab_orders lo WHERE lo.patient_uhid = p.uhid AND lo.doctor_user_id = ? AND lo.status IN ('completed', 'verified')) AS completed_report_count,
              (SELECT COUNT(*) FROM lab_orders lo WHERE lo.patient_uhid = p.uhid AND lo.doctor_user_id = ? AND lo.status NOT IN ('completed', 'verified')) AS pending_report_count
       FROM patients p
       WHERE p.hospital_id = ? AND p.uhid IN (
         SELECT DISTINCT patient_uhid FROM opd_visits WHERE doctor_user_id = ? AND hospital_id = ?
         UNION
         SELECT DISTINCT patient_uhid FROM ipd_admissions WHERE admitting_doctor_user_id = ? AND hospital_id = ?
       )
       ORDER BY p.full_name`,
      [userId, userId, userId, hospitalId, userId, hospitalId, userId, hospitalId]
    );
    res.json({ success: true, patients: rows });
  } catch (err) {
    console.error("List doctor patients error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Doctor schedule ----------

app.get("/api/doctor/schedule", requireRole("doctor"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, avail_date, start_time, end_time, slot_minutes
       FROM doctor_calendar_availability
       WHERE hospital_id = ? AND doctor_user_id = ? AND avail_date >= CURDATE()
       ORDER BY avail_date, start_time`,
      [req.session.user.hospitalId, req.session.user.userId]
    );
    res.json({ success: true, schedule: rows });
  } catch (err) {
    console.error("Get schedule error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/doctor/schedule", requireRole("doctor"), async (req, res) => {
  const { date, endDate, weekdays, startTime, endTime, slotMinutes } = req.body || {};
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ success: false, message: "Date, start time, and end time are required." });
  }
  if (endTime <= startTime) {
    return res.status(400).json({
      success: false,
      message: "End time must be after start time (use 23:45 for end-of-day, not 00:00).",
    });
  }
  const today = todayLocalDateStr();
  if (date < today) {
    return res.status(400).json({ success: false, message: `${date} is in the past. Pick today or a later date.` });
  }
  if (endDate && endDate < date) {
    return res.status(400).json({ success: false, message: "End date must be on or after the start date." });
  }

  // Single date, or a date range optionally filtered to specific weekdays — either way
  // every row we insert is a concrete calendar date, never a recurring day-of-week rule.
  // Anchored at UTC noon (parseDateStrUTC) so the day-of-week and date-string round-trip
  // never drift across the local/UTC boundary.
  const dates = [];
  const cursor = parseDateStrUTC(date);
  const last = parseDateStrUTC(endDate || date);
  const weekdaySet = Array.isArray(weekdays) && weekdays.length > 0 ? new Set(weekdays.map(Number)) : null;
  while (cursor <= last) {
    if (!weekdaySet || weekdaySet.has(cursor.getUTCDay())) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (dates.length === 0) {
    return res.status(400).json({ success: false, message: "No matching dates in that range." });
  }
  if (dates.length > 366) {
    return res.status(400).json({ success: false, message: "That range is too large — please split it up." });
  }

  try {
    const { hospitalId, userId } = req.session.user;
    const values = dates.map((d) => [hospitalId, userId, d, startTime, endTime, slotMinutes || 15]);
    const [result] = await pool.query(
      `INSERT IGNORE INTO doctor_calendar_availability
        (hospital_id, doctor_user_id, avail_date, start_time, end_time, slot_minutes)
       VALUES ?`,
      [values]
    );
    broadcast(req, "consultations");
    res.json({ success: true, datesRequested: dates.length, datesCreated: result.affectedRows });
  } catch (err) {
    console.error("Create schedule error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/doctor/schedule/:id", requireRole("doctor"), async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM doctor_calendar_availability WHERE id = ? AND hospital_id = ? AND doctor_user_id = ?`,
      [req.params.id, req.session.user.hospitalId, req.session.user.userId]
    );
    broadcast(req, "consultations");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete schedule error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- OPD booking & queue ----------

// ---------- Departments (Stage 0) ----------

app.get("/api/departments", requireTenantUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name FROM departments WHERE hospital_id = ? ORDER BY name`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, departments: rows });
  } catch (err) {
    console.error("List departments error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/departments", requireRole("hospital_admin"), async (req, res) => {
  const { name } = req.body || {};
  if (!name) {
    return res.status(400).json({ success: false, message: "Department name is required." });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO departments (hospital_id, name, created_by) VALUES (?, ?, ?)`,
      [req.session.user.hospitalId, name, req.session.user.userId]
    );
    broadcast(req, "departments");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Create department error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/departments/:id", requireRole("hospital_admin"), async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    await pool.query(`UPDATE users SET department_id = NULL WHERE department_id = ? AND hospital_id = ?`, [
      req.params.id,
      hospitalId,
    ]);
    await pool.query(`DELETE FROM departments WHERE id = ? AND hospital_id = ?`, [req.params.id, hospitalId]);
    broadcast(req, "departments");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete department error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/opd/doctors", requireTenantUser, async (req, res) => {
  const { departmentId } = req.query;
  try {
    const { hospitalId } = req.session.user;
    let query = `SELECT u.user_id, u.full_name, u.details, u.department_id, d.name AS department_name
                 FROM users u
                 LEFT JOIN departments d ON d.id = u.department_id
                 WHERE u.hospital_id = ? AND u.role = 'doctor'`;
    const params = [hospitalId];
    if (departmentId) {
      query += " AND u.department_id = ?";
      params.push(departmentId);
    }
    query += " ORDER BY u.full_name";

    const [rows] = await pool.query(query, params);
    res.json({ success: true, doctors: rows });
  } catch (err) {
    console.error("List doctors error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/opd/slots", requireTenantUser, async (req, res) => {
  const { doctorUserId, date } = req.query;
  if (!doctorUserId || !date) {
    return res.status(400).json({ success: false, message: "doctorUserId and date are required." });
  }
  try {
    const { hospitalId } = req.session.user;

    const [scheduleRows] = await pool.query(
      `SELECT start_time, end_time, slot_minutes FROM doctor_calendar_availability
       WHERE hospital_id = ? AND doctor_user_id = ? AND avail_date = ?`,
      [hospitalId, doctorUserId, date]
    );
    const [bookedRows] = await pool.query(
      `SELECT slot_time FROM opd_visits
       WHERE hospital_id = ? AND doctor_user_id = ? AND visit_date = ? AND slot_time IS NOT NULL`,
      [hospitalId, doctorUserId, date]
    );

    const slots = computeAvailableSlots(
      scheduleRows,
      bookedRows.map((r) => r.slot_time)
    );
    res.json({ success: true, slots });
  } catch (err) {
    console.error("Get slots error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/opd/visits", requireReceptionistOrAdmin, async (req, res) => {
  const { patientUhid, doctorUserId, visitDate, slotTime, confirmDuplicate } = req.body || {};
  if (!patientUhid || !doctorUserId || !visitDate) {
    return res.status(400).json({ success: false, message: "Patient, doctor, and date are required." });
  }

  const today = todayLocalDateStr();
  if (visitDate < today) {
    return res.status(400).json({
      success: false,
      message: `${visitDate} is in the past. Pick today (${today}) or a later date.`,
    });
  }

  try {
    const { hospitalId, userId } = req.session.user;

    if (slotTime) {
      const [conflict] = await pool.query(
        `SELECT id FROM opd_visits WHERE hospital_id = ? AND doctor_user_id = ? AND visit_date = ? AND slot_time = ?`,
        [hospitalId, doctorUserId, visitDate, slotTime]
      );
      if (conflict.length > 0) {
        return res.status(409).json({
          success: false,
          message: "That slot has just been booked. Please pick another.",
        });
      }
    }

    // Warn (don't hard-block) if this patient already has other unresolved bookings —
    // easy to create several by accident when re-picking dates/doctors while searching
    // for an open slot. The caller can resubmit with confirmDuplicate: true to proceed.
    if (!confirmDuplicate) {
      const [pending] = await pool.query(
        `SELECT v.id, v.visit_date, v.slot_time, u.full_name AS doctor_name, v.doctor_user_id
         FROM opd_visits v LEFT JOIN users u ON u.user_id = v.doctor_user_id
         WHERE v.hospital_id = ? AND v.patient_uhid = ? AND v.status IN ('waiting', 'in-consultation')`,
        [hospitalId, patientUhid]
      );
      if (pending.length > 0) {
        return res.status(409).json({
          success: false,
          duplicateWarning: true,
          message: `This patient already has ${pending.length} unresolved booking(s).`,
          existingVisits: pending.map((v) => ({
            id: v.id,
            visitDate: v.visit_date,
            slotTime: v.slot_time,
            doctorName: v.doctor_name || v.doctor_user_id,
          })),
        });
      }
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM opd_visits WHERE hospital_id = ? AND visit_date = ?`,
      [hospitalId, visitDate]
    );
    const tokenNumber = countRows[0].cnt + 1;

    const [patientRows] = await pool.query(
      `SELECT phone FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`,
      [patientUhid, hospitalId]
    );
    const patientPhone = patientRows[0]?.phone;
    const source = slotTime ? "appointment" : "walk-in";

    const [result] = await pool.query(
      `INSERT INTO opd_visits
        (hospital_id, token_number, patient_uhid, doctor_user_id, visit_date, slot_time, source, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      [hospitalId, tokenNumber, patientUhid, doctorUserId, visitDate, slotTime || null, source, userId]
    );

    const confirmation = patientPhone
      ? `[stub] SMS/WhatsApp confirmation sent to ${patientPhone}: token #${tokenNumber} on ${visitDate}${
          slotTime ? ` at ${slotTime}` : ""
        }.`
      : "[stub] No phone on file for this patient — confirmation not sent.";
    console.log(confirmation);

    broadcast(req, "opd_queue");
    broadcast(req, "patients");
    res.json({
      success: true,
      visit: { id: result.insertId, tokenNumber, visitDate, slotTime: slotTime || null, source },
      confirmation,
    });
  } catch (err) {
    console.error("Book visit error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/opd/queue", requireTenantUser, async (req, res) => {
  const { date, doctorUserId } = req.query;
  const visitDate = date || todayLocalDateStr();

  try {
    const { hospitalId } = req.session.user;
    let query = `SELECT v.id, v.token_number, v.patient_uhid, v.doctor_user_id, v.visit_date, v.slot_time,
                        v.source, v.status, p.full_name AS patient_name, u.full_name AS doctor_name
                 FROM opd_visits v
                 LEFT JOIN patients p ON p.uhid = v.patient_uhid
                 LEFT JOIN users u ON u.user_id = v.doctor_user_id
                 WHERE v.hospital_id = ? AND v.visit_date = ?`;
    const params = [hospitalId, visitDate];

    if (doctorUserId) {
      query += " AND v.doctor_user_id = ?";
      params.push(doctorUserId);
    }
    query += " ORDER BY (v.slot_time IS NULL), v.slot_time, v.created_at";

    const [rows] = await pool.query(query, params);
    res.json({ success: true, queue: rows });
  } catch (err) {
    console.error("Get queue error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Deliberately its own endpoint rather than a column on the shared
// GET /api/opd/queue listing — that listing is also used by receptionists/
// admins viewing a whole day's queue, and the Jitsi room slug is the only
// thing gating entry to a video consultation (meet.jit.si has no access
// control of its own), so it must only ever go to the exact patient or
// doctor on that one visit — never anyone else browsing the queue.
app.get("/api/opd/visits/:id/meeting-room", requireTenantUser, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT patient_uhid, doctor_user_id, source, meeting_room FROM opd_visits WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.id, req.session.user.hospitalId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Visit not found." });
    }
    const visit = rows[0];
    if (visit.source !== "telemedicine" || !visit.meeting_room) {
      return res.status(400).json({ success: false, message: "This is not a telemedicine visit." });
    }
    const { userId } = req.session.user;
    if (userId !== visit.patient_uhid && userId !== visit.doctor_user_id) {
      return res.status(403).json({ success: false, message: "Not authorized for this visit." });
    }
    res.json({
      success: true,
      meetingRoom: visit.meeting_room,
      subject: `MEDISYS TELE VISIT ${req.params.id}`,
    });
  } catch (err) {
    console.error("Get meeting room error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.patch("/api/opd/visits/:id/status", requireRole("doctor", "hospital_admin"), async (req, res) => {
  const { status } = req.body || {};
  // 'called' sits between waiting and in-consultation — a doctor clicking
  // "Call" moves a patient here first (see staff/doctor-queue.js), and only
  // clicking "Start Consulting" moves them to in-consultation. Both changes
  // broadcast on the same "opd_queue" channel the live queue board (see
  // staff/opd-queue-board.html / opd-queue-display.html) listens to.
  if (!["waiting", "called", "in-consultation", "completed"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid status." });
  }
  try {
    await pool.query(`UPDATE opd_visits SET status = ? WHERE id = ? AND hospital_id = ?`, [
      status,
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "opd_queue");
    res.json({ success: true });
  } catch (err) {
    console.error("Update visit status error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Patient EMR history ----------

app.get("/api/patients/:uhid/history", requireTenantUser, async (req, res) => {
  // Same reasoning as GET /api/patients/:uhid — a patient must be pinned to their own UHID.
  if (req.session.user.role === "patient" && req.session.user.userId !== req.params.uhid) {
    return res.status(403).json({ success: false, message: "You can only view your own record." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [consultations] = await pool.query(
      `SELECT c.id, c.symptoms, c.notes, c.decision, c.created_at, u.full_name AS doctor_name
       FROM consultations c
       LEFT JOIN users u ON u.user_id = c.doctor_user_id
       WHERE c.hospital_id = ? AND c.patient_uhid = ? ORDER BY c.created_at DESC`,
      [hospitalId, req.params.uhid]
    );
    const [admissions] = await pool.query(
      `SELECT id, status, admission_notes, created_at, admitted_at
       FROM ipd_admissions WHERE hospital_id = ? AND patient_uhid = ? ORDER BY created_at DESC`,
      [hospitalId, req.params.uhid]
    );
    const [labOrderRows] = await pool.query(
      `SELECT lo.id, tc.name AS test_name, tc.category, tc.department, lo.status,
              lo.result_notes, lo.result_file_name, lo.completed_at, lo.created_at,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', li.id, 'fileName', li.file_name))
                 FROM lab_order_images li WHERE li.lab_order_id = lo.id) AS images
       FROM lab_orders lo
       LEFT JOIN test_catalog tc ON tc.id = lo.test_id
       WHERE lo.hospital_id = ? AND lo.patient_uhid = ? ORDER BY lo.created_at DESC`,
      [hospitalId, req.params.uhid]
    );
    const labOrders = labOrderRows.map((r) => ({
      ...r,
      images: typeof r.images === "string" ? JSON.parse(r.images) : r.images || [],
    }));
    res.json({ success: true, history: { consultations, admissions, labOrders } });
  } catch (err) {
    console.error("Get patient history error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Patient's own portal — every endpoint below derives the patient from the
// session (req.session.user.userId), never from a URL/body param, so there is no way
// for a patient to request another patient's data by passing a different UHID. ----------

app.get("/api/patients/me/records", requireRole("patient"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const [consultations] = await pool.query(
      `SELECT c.id, c.opd_visit_id, c.symptoms, c.notes, c.decision, c.diagnosis, c.created_at, u.full_name AS doctor_name
       FROM consultations c
       LEFT JOIN users u ON u.user_id = c.doctor_user_id
       WHERE c.hospital_id = ? AND c.patient_uhid = ? ORDER BY c.created_at DESC`,
      [hospitalId, userId]
    );
    const [admissions] = await pool.query(
      `SELECT a.id, a.status, a.admission_notes, a.created_at, a.admitted_at, a.discharged_at,
              w.name AS ward_name, b.bed_number, u.full_name AS doctor_name
       FROM ipd_admissions a
       LEFT JOIN wards w ON w.id = a.ward_id
       LEFT JOIN beds b ON b.id = a.bed_id
       LEFT JOIN users u ON u.user_id = a.admitting_doctor_user_id
       WHERE a.hospital_id = ? AND a.patient_uhid = ? ORDER BY a.created_at DESC`,
      [hospitalId, userId]
    );
    const [labOrderRows] = await pool.query(
      `SELECT lo.id, tc.name AS test_name, tc.category, tc.department, lo.status,
              lo.result_notes, lo.result_file_name, lo.completed_at, lo.created_at,
              lo.doctor_user_id, u.full_name AS doctor_name,
              lo.verified_by, v.full_name AS verified_by_name, lo.verified_at,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', li.id, 'fileName', li.file_name))
                 FROM lab_order_images li WHERE li.lab_order_id = lo.id) AS images
       FROM lab_orders lo
       LEFT JOIN test_catalog tc ON tc.id = lo.test_id
       LEFT JOIN users u ON u.user_id = lo.doctor_user_id
       LEFT JOIN users v ON v.user_id = lo.verified_by
       WHERE lo.hospital_id = ? AND lo.patient_uhid = ? ORDER BY lo.created_at DESC`,
      [hospitalId, userId]
    );
    const labOrders = labOrderRows.map((r) => ({
      ...r,
      images: typeof r.images === "string" ? JSON.parse(r.images) : r.images || [],
    }));
    const [vitals] = await pool.query(
      `SELECT id, bp, temperature, weight, spo2, recorded_at
       FROM vitals WHERE hospital_id = ? AND patient_uhid = ? ORDER BY recorded_at DESC LIMIT 20`,
      [hospitalId, userId]
    );
    res.json({ success: true, records: { consultations, admissions, labOrders, vitals } });
  } catch (err) {
    console.error("Get my records error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/patients/me/appointments", requireRole("patient"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT v.id, v.token_number, v.doctor_user_id, u.full_name AS doctor_name, v.visit_date,
              v.slot_time, v.source, v.status, v.created_at
       FROM opd_visits v
       LEFT JOIN users u ON u.user_id = v.doctor_user_id
       WHERE v.hospital_id = ? AND v.patient_uhid = ?
       ORDER BY v.visit_date DESC, v.slot_time DESC, v.created_at DESC`,
      [hospitalId, userId]
    );
    res.json({ success: true, appointments: rows });
  } catch (err) {
    console.error("Get my appointments error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/patients/me/appointments", requireRole("patient"), async (req, res) => {
  const { doctorUserId, visitDate, slotTime, source, symptoms, confirmDuplicate } = req.body || {};
  if (!doctorUserId || !visitDate) {
    return res.status(400).json({ success: false, message: "Doctor and date are required." });
  }
  // Telemedicine bookings must go through POST /api/telemedicine/create-order +
  // verify-payment instead — this endpoint has no payment gate, so a telemedicine
  // visit created here would reach the doctor's queue without the patient ever paying.
  if (source === "telemedicine") {
    return res.status(400).json({
      success: false,
      message: "Telemedicine appointments require payment — use the telemedicine booking flow.",
    });
  }

  const today = todayLocalDateStr();
  if (visitDate < today) {
    return res.status(400).json({
      success: false,
      message: `${visitDate} is in the past. Pick today (${today}) or a later date.`,
    });
  }

  try {
    const { hospitalId, userId: patientUhid } = req.session.user;

    if (slotTime) {
      const [conflict] = await pool.query(
        `SELECT id FROM opd_visits WHERE hospital_id = ? AND doctor_user_id = ? AND visit_date = ? AND slot_time = ?`,
        [hospitalId, doctorUserId, visitDate, slotTime]
      );
      if (conflict.length > 0) {
        return res.status(409).json({
          success: false,
          message: "That time slot has already been booked. Please select another slot.",
        });
      }
    }

    if (!confirmDuplicate) {
      const [pending] = await pool.query(
        `SELECT v.id, v.visit_date, v.slot_time, u.full_name AS doctor_name
         FROM opd_visits v LEFT JOIN users u ON u.user_id = v.doctor_user_id
         WHERE v.hospital_id = ? AND v.patient_uhid = ? AND v.status IN ('waiting', 'in-consultation')`,
        [hospitalId, patientUhid]
      );
      if (pending.length > 0) {
        return res.status(409).json({
          success: false,
          duplicateWarning: true,
          message: `You already have ${pending.length} unresolved appointment(s).`,
          existingVisits: pending.map((v) => ({
            id: v.id,
            visitDate: v.visit_date,
            slotTime: v.slot_time,
            doctorName: v.doctor_name || v.doctor_user_id,
          })),
        });
      }
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM opd_visits WHERE hospital_id = ? AND visit_date = ?`,
      [hospitalId, visitDate]
    );
    const tokenNumber = countRows[0].cnt + 1;

    const [patientRows] = await pool.query(
      `SELECT phone FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`,
      [patientUhid, hospitalId]
    );
    const patientPhone = patientRows[0]?.phone;
    const visitSource = source === "telemedicine" ? "telemedicine" : (slotTime ? "appointment" : "walk-in");

    const [result] = await pool.query(
      `INSERT INTO opd_visits
        (hospital_id, token_number, patient_uhid, doctor_user_id, visit_date, slot_time, source, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      [hospitalId, tokenNumber, patientUhid, doctorUserId, visitDate, slotTime || null, visitSource, patientUhid]
    );

    const confirmation = patientPhone
      ? `[stub] SMS/WhatsApp confirmation sent to ${patientPhone}: token #${tokenNumber} on ${visitDate}${
          slotTime ? ` at ${slotTime}` : ""
        }.`
      : "[stub] No phone on file — confirmation not sent.";

    broadcast(req, "opd_queue");
    broadcast(req, "patients");
    res.json({
      success: true,
      visit: { id: result.insertId, tokenNumber, visitDate, slotTime: slotTime || null, source: visitSource },
      confirmation,
    });
  } catch (err) {
    console.error("Patient book appointment error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});


// ---------- Telemedicine booking + payment (Razorpay) ----------
//
// Two-step flow, mirroring how Razorpay Checkout is meant to be used:
//   1. create-order: server creates a Razorpay order for the doctor's fee and
//      records a 'created' telemedicine_payments row. No opd_visits row exists
//      yet — the doctor's queue can't see this booking.
//   2. verify-payment: the browser only reaches this after Razorpay Checkout
//      reports success. The server independently verifies the HMAC signature
//      Razorpay returned (never trusting the client's "it succeeded" claim) and
//      only then inserts the real opd_visits row, making it visible to the
//      doctor. A failed/skipped/tampered payment never produces a visit.

app.post("/api/telemedicine/create-order", requireRole("patient"), async (req, res) => {
  const { doctorUserId, visitDate, slotTime } = req.body || {};
  if (!doctorUserId || !visitDate) {
    return res.status(400).json({ success: false, message: "Doctor and date are required." });
  }

  const today = todayLocalDateStr();
  if (visitDate < today) {
    return res.status(400).json({
      success: false,
      message: `${visitDate} is in the past. Pick today (${today}) or a later date.`,
    });
  }

  if (!razorpay.isConfigured()) {
    return res.status(503).json({
      success: false,
      message: "Online payment isn't configured on this server yet. Please contact the hospital.",
    });
  }

  try {
    const { hospitalId, userId: patientUhid } = req.session.user;

    const [doctorRows] = await pool.query(
      `SELECT full_name, details FROM users WHERE user_id = ? AND hospital_id = ? AND role = 'doctor' LIMIT 1`,
      [doctorUserId, hospitalId]
    );
    if (doctorRows.length === 0) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }
    const details = (() => {
      try {
        return typeof doctorRows[0].details === "string" ? JSON.parse(doctorRows[0].details) : doctorRows[0].details || {};
      } catch {
        return {};
      }
    })();
    const fee = Number(details.consultationFee);
    if (!Number.isFinite(fee) || fee <= 0) {
      return res.status(400).json({
        success: false,
        message: "This doctor hasn't set a telemedicine consultation fee yet. Please choose another doctor.",
      });
    }

    if (slotTime) {
      const [conflict] = await pool.query(
        `SELECT id FROM opd_visits WHERE hospital_id = ? AND doctor_user_id = ? AND visit_date = ? AND slot_time = ?`,
        [hospitalId, doctorUserId, visitDate, slotTime]
      );
      if (conflict.length > 0) {
        return res.status(409).json({ success: false, message: "That time slot has already been booked. Please select another slot." });
      }
    }

    const receipt = `tele_${hospitalId}_${Date.now()}`;
    const order = await razorpay.createOrder(fee, receipt, {
      hospitalId: String(hospitalId),
      patientUhid,
      doctorUserId,
      visitDate,
    });

    await pool.query(
      `INSERT INTO telemedicine_payments
        (hospital_id, patient_uhid, doctor_user_id, visit_date, slot_time, amount, razorpay_order_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`,
      [hospitalId, patientUhid, doctorUserId, visitDate, slotTime || null, fee, order.id]
    );

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      doctorName: doctorRows[0].full_name,
      fee,
    });
  } catch (err) {
    console.error("Create telemedicine order error:", err.message);
    res.status(500).json({ success: false, message: err.message || "Server error. Please try again." });
  }
});

app.post("/api/telemedicine/verify-payment", requireRole("patient"), async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: "Incomplete payment response." });
  }

  try {
    const { hospitalId, userId: patientUhid } = req.session.user;

    const [paymentRows] = await pool.query(
      `SELECT * FROM telemedicine_payments
       WHERE razorpay_order_id = ? AND hospital_id = ? AND patient_uhid = ? AND status = 'created' LIMIT 1`,
      [razorpayOrderId, hospitalId, patientUhid]
    );
    if (paymentRows.length === 0) {
      return res.status(404).json({ success: false, message: "No pending payment found for this order." });
    }
    const payment = paymentRows[0];

    const isValid = razorpay.verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) {
      await pool.query(
        `UPDATE telemedicine_payments SET status = 'failed', razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?`,
        [razorpayPaymentId, razorpaySignature, payment.id]
      );
      return res.status(400).json({ success: false, message: "Payment verification failed. If money was deducted, it will be refunded automatically by Razorpay." });
    }

    // Slot could have been taken by someone else between order creation and now —
    // re-check before minting the visit rather than silently double-booking it.
    if (payment.slot_time) {
      const [conflict] = await pool.query(
        `SELECT id FROM opd_visits WHERE hospital_id = ? AND doctor_user_id = ? AND visit_date = ? AND slot_time = ?`,
        [hospitalId, payment.doctor_user_id, payment.visit_date, payment.slot_time]
      );
      if (conflict.length > 0) {
        await pool.query(`UPDATE telemedicine_payments SET status = 'failed' WHERE id = ?`, [payment.id]);
        return res.status(409).json({
          success: false,
          message: "That slot was just booked by someone else. Your payment was verified but not charged again — please contact the hospital for a refund and pick another slot.",
        });
      }
    }

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM opd_visits WHERE hospital_id = ? AND visit_date = ?`,
      [hospitalId, payment.visit_date]
    );
    const tokenNumber = countRows[0].cnt + 1;
    // Jitsi (meet.jit.si) has no access control of its own — the room slug IS
    // the access credential, so it must be unguessable, never derived from
    // the visit id or any other public value.
    const meetingRoom = "medisys-" + crypto.randomBytes(16).toString("hex");

    const [visitResult] = await pool.query(
      `INSERT INTO opd_visits
        (hospital_id, token_number, patient_uhid, doctor_user_id, visit_date, slot_time, source, status, created_by, meeting_room)
       VALUES (?, ?, ?, ?, ?, ?, 'telemedicine', 'waiting', ?, ?)`,
      [hospitalId, tokenNumber, patientUhid, payment.doctor_user_id, payment.visit_date, payment.slot_time, patientUhid, meetingRoom]
    );

    await pool.query(
      `UPDATE telemedicine_payments
       SET status = 'paid', razorpay_payment_id = ?, razorpay_signature = ?, opd_visit_id = ?, paid_at = NOW()
       WHERE id = ?`,
      [razorpayPaymentId, razorpaySignature, visitResult.insertId, payment.id]
    );

    broadcast(req, "opd_queue");
    broadcast(req, "patients");
    res.json({
      success: true,
      visit: {
        id: visitResult.insertId,
        tokenNumber,
        visitDate: payment.visit_date,
        slotTime: payment.slot_time,
        source: "telemedicine",
        meetingRoom,
      },
    });
  } catch (err) {
    console.error("Verify telemedicine payment error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/patients/me/prescriptions", requireRole("patient"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    // opd_visit_id/doctor_name added so the patient portal can group these
    // by visit and generate a per-consultation prescription PDF (see
    // patient/records.js) — previously there was no way to tell which
    // medicines came from which visit, or who prescribed them.
    const [rows] = await pool.query(
      `SELECT po.id, po.opd_visit_id, po.ipd_admission_id, po.medicine_name, po.dosage, po.duration,
              po.urgency, po.food_instruction, po.status, po.created_at, po.dispensed_at,
              po.doctor_user_id, u.full_name AS doctor_name, pi.invoice_number, pi.payment_status
       FROM medisys_pharmacy.pharmacy_orders po
       LEFT JOIN users u ON u.user_id = po.doctor_user_id
       LEFT JOIN medisys_pharmacy.pharmacy_invoices pi ON pi.id = po.invoice_id
       WHERE po.hospital_id = ? AND po.patient_uhid = ? ORDER BY po.created_at DESC`,
      [hospitalId, userId]
    );
    res.json({ success: true, prescriptions: rows });
  } catch (err) {
    console.error("Get my prescriptions error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/patients/me/bills", requireRole("patient"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    await reconcilePatientCharges(hospitalId);

    const [outstandingCharges] = await pool.query(
      `SELECT id, description, department, rate, created_at
       FROM patient_charges WHERE hospital_id = ? AND patient_uhid = ? AND bill_id IS NULL
       ORDER BY created_at ASC`,
      [hospitalId, userId]
    );
    const [billRows] = await pool.query(
      `SELECT b.id, b.bill_no, b.department, b.bill_date, b.subtotal, b.discount_amount, b.tax_amount,
              b.total_amount, b.paid_amount, b.balance_amount, b.status, b.is_insurance, b.payer_name, b.created_at,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('description', bi.description, 'qty', bi.qty, 'rate', bi.rate, 'amount', bi.amount))
                 FROM bill_items bi WHERE bi.bill_id = b.id) AS items
       FROM bills b WHERE b.hospital_id = ? AND b.patient_uhid = ? ORDER BY b.bill_date DESC, b.id DESC`,
      [hospitalId, userId]
    );
    const bills = billRows.map((r) => ({ ...r, items: typeof r.items === "string" ? JSON.parse(r.items) : r.items || [] }));

    const [pharmacyInvoiceRows] = await pool.query(
      `SELECT pi.id, pi.invoice_number, pi.item_count, pi.total_amount, pi.payment_status, pi.created_at, pi.paid_at,
              (SELECT JSON_ARRAYAGG(JSON_OBJECT('medicineName', po.medicine_name, 'dosage', po.dosage, 'duration', po.duration, 'foodInstruction', po.food_instruction))
                 FROM medisys_pharmacy.pharmacy_orders po WHERE po.invoice_id = pi.id) AS medicines
       FROM medisys_pharmacy.pharmacy_invoices pi WHERE pi.hospital_id = ? AND pi.patient_uhid = ?
       ORDER BY pi.created_at DESC`,
      [hospitalId, userId]
    );
    const pharmacyInvoices = pharmacyInvoiceRows.map((r) => ({
      ...r,
      medicines: typeof r.medicines === "string" ? JSON.parse(r.medicines) : r.medicines || [],
    }));

    const outstandingTotal = outstandingCharges.reduce((sum, c) => sum + parseFloat(c.rate), 0);
    res.json({ success: true, outstandingCharges, outstandingTotal, bills, pharmacyInvoices });
  } catch (err) {
    console.error("Get my bills error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Outbreak alerts a patient should see: raised at their own hospital, or at any other
// hospital in the same city ("nearby areas" — same proxy used when the alert was first
// raised, see checkDiseaseOutbreak above). Only ever exposes diagnosis/city/hospital name
// and aggregate counts, never another hospital's patient data.
app.get("/api/patients/me/disease-alerts", requireRole("patient"), async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [[ownHospital]] = await pool.query(`SELECT city FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
    const city = ownHospital?.city || null;

    const [rows] = await pool.query(
      `SELECT da.id, da.diagnosis, da.case_count, da.window_days, da.created_at,
              h.name AS hospital_name, h.city, (da.hospital_id = ?) AS is_own_hospital
       FROM disease_alerts da
       JOIN hospitals h ON h.id = da.hospital_id
       WHERE da.hospital_id = ? OR (? IS NOT NULL AND h.city = ?)
       ORDER BY da.created_at DESC LIMIT 20`,
      [hospitalId, hospitalId, city, city]
    );
    res.json({ success: true, alerts: rows });
  } catch (err) {
    console.error("List patient disease alerts error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Pathology / Radiology test catalog ----------

app.get("/api/tests/search", requireTenantUser, async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const [rows] = await pool.query(
      `SELECT id, name, category, department, sample_type, price, turnaround_hours
       FROM test_catalog
       WHERE hospital_id = ? AND name LIKE ? ORDER BY name LIMIT 20`,
      [req.session.user.hospitalId, `%${q}%`]
    );
    res.json({ success: true, tests: rows });
  } catch (err) {
    console.error("Search tests error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Consultation (doctor decision point) ----------

app.post("/api/opd/visits/:id/consultation", requireRole("doctor"), async (req, res) => {
  const { symptoms, notes, diagnosis, testIds, admit } = req.body || {};
  const prescriptions = Array.isArray(req.body?.prescriptions) ? req.body.prescriptions : [];
  const tests = Array.isArray(testIds) ? testIds : [];
  const wantsAdmit = admit === true;

  // A consultation can combine any mix of prescribe / order tests / admit — at least
  // one action is required, but none of them are mutually exclusive anymore.
  if (prescriptions.length === 0 && tests.length === 0 && !wantsAdmit) {
    return res.status(400).json({
      success: false,
      message: "Add at least one action: prescribe a medicine, order a test, or admit the patient.",
    });
  }
  for (const p of prescriptions) {
    if (!p || !p.medicineName || !p.dosage || !p.duration) {
      return res.status(400).json({ success: false, message: "Each prescription needs a medicine, dosage, and duration." });
    }
  }

  try {
    const { hospitalId, userId } = req.session.user;
    const [visitRows] = await pool.query(
      `SELECT patient_uhid FROM opd_visits WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (visitRows.length === 0) {
      return res.status(404).json({ success: false, message: "Visit not found." });
    }
    const patientUhid = visitRows[0].patient_uhid;

    const actions = [];
    if (prescriptions.length > 0) actions.push("prescribe");
    if (tests.length > 0) actions.push("order_tests");
    if (wantsAdmit) actions.push("admit");
    const decision = actions.join(",");

    // Either a watchlist pick or free text typed under "Other" on the client —
    // both are accepted here and fed into outbreak monitoring the same way;
    // see checkDiseaseOutbreak's collation note on why differently-cased
    // duplicates of a custom name still count as the same disease.
    const trimmedDiagnosis = typeof diagnosis === "string" ? diagnosis.trim().slice(0, MAX_DIAGNOSIS_LENGTH) : "";
    const diagnosisValue = trimmedDiagnosis || null;
    await pool.query(
      `INSERT INTO consultations (hospital_id, opd_visit_id, patient_uhid, doctor_user_id, symptoms, notes, decision, diagnosis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [hospitalId, req.params.id, patientUhid, userId, symptoms || null, notes || null, decision, diagnosisValue]
    );
    await pool.query(`UPDATE opd_visits SET status = 'completed' WHERE id = ? AND hospital_id = ?`, [
      req.params.id,
      hospitalId,
    ]);

    if (prescriptions.length > 0) {
      const FOOD_INSTRUCTIONS = ["Before Meal", "After Meal", "With Meal", "Empty Stomach"];
      const values = prescriptions.map((p) => [
        hospitalId,
        req.params.id,
        patientUhid,
        userId,
        p.medicineName,
        p.dosage,
        p.duration,
        p.urgency === "urgent" ? "urgent" : "routine",
        FOOD_INSTRUCTIONS.includes(p.foodInstruction) ? p.foodInstruction : null,
      ]);
      await pool.query(
        `INSERT INTO medisys_pharmacy.pharmacy_orders
           (hospital_id, opd_visit_id, patient_uhid, doctor_user_id, medicine_name, dosage, duration, urgency, food_instruction)
         VALUES ?`,
        [values]
      );
    }

    if (tests.length > 0) {
      const values = tests.map((testId) => [hospitalId, req.params.id, patientUhid, testId, userId]);
      await pool.query(
        `INSERT INTO lab_orders (hospital_id, opd_visit_id, patient_uhid, test_id, doctor_user_id) VALUES ?`,
        [values]
      );
    }

    let admissionId = null;
    let admissionAlreadyExisted = false;
    if (wantsAdmit) {
      const [existing] = await pool.query(
        `SELECT id FROM ipd_admissions
         WHERE hospital_id = ? AND patient_uhid = ? AND status IN ('requested', 'admitted') LIMIT 1`,
        [hospitalId, patientUhid]
      );

      if (existing.length > 0) {
        admissionId = existing[0].id;
        admissionAlreadyExisted = true;
      } else {
        const [admissionResult] = await pool.query(
          `INSERT INTO ipd_admissions (hospital_id, patient_uhid, admitting_doctor_user_id, opd_visit_id, created_by)
           VALUES (?, ?, ?, ?, ?)`,
          [hospitalId, patientUhid, userId, req.params.id, userId]
        );
        admissionId = admissionResult.insertId;
      }
    }

    broadcast(req, "opd_queue");
    broadcast(req, "consultations");
    if (prescriptions.length > 0) broadcast(req, "pharmacy_orders");
    if (tests.length > 0) broadcast(req, "lab_orders");
    if (wantsAdmit) broadcast(req, "ipd_admissions");

    let outbreakAlert = null;
    if (diagnosisValue) {
      try {
        outbreakAlert = await checkDiseaseOutbreak(req, hospitalId, diagnosisValue);
      } catch (err) {
        // An outbreak-alert failure should never fail the consultation save itself.
        console.error("Disease outbreak check error:", err.message);
      }
    }

    res.json({
      success: true,
      admissionId,
      admissionAlreadyExisted,
      prescriptionCount: prescriptions.length,
      testCount: tests.length,
      outbreakAlert,
    });
  } catch (err) {
    console.error("Record consultation error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Voice prescription (Sarvam AI, see language/) ----------
// Doctor dictates in an Indian language; the clip is forwarded to the local
// language/service.py process, which transcribes, translates, and drafts a
// structured prescription for the doctor to review before saving as usual.

app.post("/api/voice/prescribe", requireRole("doctor"), voiceUpload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No audio recorded." });
  }
  const language = (req.body.language || "hi").toLowerCase();
  try {
    const form = new FormData();
    form.append("language", language);
    form.append("audio", new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }), "dictation.webm");

    const upstream = await fetch(`${VOICE_SERVICE_URL}/transcribe`, { method: "POST", body: form });
    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, message: data.error || "Voice service error." });
    }
    res.json({ success: true, ...data });
  } catch (err) {
    console.error("Voice prescribe error:", err.message);
    res.status(503).json({
      success: false,
      message: "Voice dictation service is unreachable. Make sure language/service.py is running (see language/README.md).",
    });
  }
});

// ---------- Lab orders (Pathology / Laboratory / Radiology queues) ----------

app.get("/api/lab-orders", requireRole("pathology_staff", "hospital_admin"), async (req, res) => {
  const { department, scope, status } = req.query;
  try {
    const { hospitalId, userId } = req.session.user;
    let query = `SELECT lo.id, lo.patient_uhid, p.full_name AS patient_name, p.dob, p.gender,
                        lo.test_id, tc.name AS test_name, tc.category, tc.department, tc.sample_type, tc.turnaround_hours,
                        lo.doctor_user_id, u.full_name AS doctor_name,
                        lo.status, lo.priority, lo.assigned_to, a.full_name AS assigned_to_name,
                        lo.result_notes, lo.result_file_name, lo.completed_by, lo.completed_at,
                        lo.verified_by, v.full_name AS verified_by_name, lo.verified_at, lo.created_at,
                        (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', li.id, 'fileName', li.file_name))
                           FROM lab_order_images li WHERE li.lab_order_id = lo.id) AS images
                 FROM lab_orders lo
                 LEFT JOIN patients p ON p.uhid = lo.patient_uhid
                 LEFT JOIN test_catalog tc ON tc.id = lo.test_id
                 LEFT JOIN users u ON u.user_id = lo.doctor_user_id
                 LEFT JOIN users a ON a.user_id = lo.assigned_to
                 LEFT JOIN users v ON v.user_id = lo.verified_by`;
    const conditions = ["lo.hospital_id = ?"];
    const params = [hospitalId];

    if (department) {
      conditions.push("tc.department = ?");
      params.push(department);
    }
    if (scope === "unclaimed") {
      conditions.push("lo.status = 'pending'");
    } else if (scope === "mine") {
      conditions.push("lo.assigned_to = ? AND lo.status NOT IN ('completed', 'verified')");
      params.push(userId);
    } else if (scope === "completed") {
      conditions.push("lo.status IN ('completed', 'verified')");
    }
    if (status && status !== "all") {
      conditions.push("lo.status = ?");
      params.push(status);
    }
    if (conditions.length) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
    query += " ORDER BY lo.created_at DESC";

    const [rows] = await pool.query(query, params);
    const orders = rows.map((r) => ({
      ...r,
      images: typeof r.images === "string" ? JSON.parse(r.images) : r.images || [],
    }));
    res.json({ success: true, orders });
  } catch (err) {
    console.error("List lab orders error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/lab-orders/:id/claim", requireRole("pathology_staff"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const [result] = await pool.query(
      `UPDATE lab_orders SET assigned_to = ?, status = 'in_progress'
       WHERE id = ? AND hospital_id = ? AND status = 'pending'`,
      [userId, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ success: false, message: "This order has already been claimed." });
    }
    broadcast(req, "lab_orders");
    res.json({ success: true });
  } catch (err) {
    console.error("Claim lab order error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post(
  "/api/lab-orders/:id/complete",
  requireRole("pathology_staff"),
  labResultUpload.single("file"),
  async (req, res) => {
    const { resultNotes } = req.body || {};
    try {
      const { hospitalId, userId } = req.session.user;
      const [result] = await pool.query(
        `UPDATE lab_orders
         SET status = 'completed', result_notes = ?, result_file_path = ?, result_file_name = ?,
             assigned_to = COALESCE(assigned_to, ?), completed_by = ?, completed_at = NOW()
         WHERE id = ? AND hospital_id = ? AND status != 'completed'`,
        [
          resultNotes || null,
          req.file ? req.file.filename : null,
          req.file ? req.file.originalname : null,
          userId,
          userId,
          req.params.id,
          hospitalId,
        ]
      );
      if (result.affectedRows === 0) {
        return res.status(409).json({ success: false, message: "This order was already completed." });
      }
      broadcast(req, "lab_orders");
      res.json({ success: true });
    } catch (err) {
      console.error("Complete lab order error:", err.message);
      res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  }
);

app.get("/api/lab-orders/:id/result-file", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT result_file_path, result_file_name FROM lab_orders WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (rows.length === 0 || !rows[0].result_file_path) {
      return res.status(404).json({ success: false, message: "No result file found." });
    }
    res.download(path.join(UPLOADS_DIR, rows[0].result_file_path), rows[0].result_file_name || "result");
  } catch (err) {
    console.error("Download lab result error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Escalate/de-escalate a study's priority (radiology triage).
app.post("/api/lab-orders/:id/priority", requireRole("pathology_staff", "hospital_admin"), async (req, res) => {
  const { priority } = req.body || {};
  if (!["routine", "urgent", "stat"].includes(priority)) {
    return res.status(400).json({ success: false, message: "A valid priority is required." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [result] = await pool.query(
      `UPDATE lab_orders SET priority = ? WHERE id = ? AND hospital_id = ?`,
      [priority, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    broadcast(req, "lab_orders");
    res.json({ success: true });
  } catch (err) {
    console.error("Update lab order priority error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Save a report in progress. Auto-claims unassigned orders and moves them to "reported"
// (drafted, not yet signed) — kept separate from "verified" so doctors don't see it until signed.
app.post("/api/lab-orders/:id/draft", requireRole("pathology_staff"), async (req, res) => {
  const { resultNotes } = req.body || {};
  try {
    const { hospitalId, userId } = req.session.user;
    const [result] = await pool.query(
      `UPDATE lab_orders
       SET result_notes = ?, assigned_to = COALESCE(assigned_to, ?),
           status = CASE WHEN status IN ('pending', 'in_progress') THEN 'reported' ELSE status END
       WHERE id = ? AND hospital_id = ? AND status NOT IN ('completed', 'verified')`,
      [resultNotes || null, userId, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ success: false, message: "This order is already finalized." });
    }
    broadcast(req, "lab_orders");
    res.json({ success: true });
  } catch (err) {
    console.error("Save lab order draft error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Sign & finalize a report. Terminal state, visible to the ordering doctor from here on.
app.post("/api/lab-orders/:id/verify", requireRole("pathology_staff"), async (req, res) => {
  const { resultNotes } = req.body || {};
  try {
    const { hospitalId, userId } = req.session.user;
    const [result] = await pool.query(
      `UPDATE lab_orders
       SET result_notes = ?, status = 'verified', verified_by = ?, verified_at = NOW(),
           assigned_to = COALESCE(assigned_to, ?), completed_by = ?, completed_at = NOW()
       WHERE id = ? AND hospital_id = ? AND status NOT IN ('completed', 'verified')`,
      [resultNotes || null, userId, userId, userId, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ success: false, message: "This order is already finalized." });
    }
    broadcast(req, "lab_orders");
    res.json({ success: true });
  } catch (err) {
    console.error("Verify lab order error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Reassign a study to a specific staff member (or clear assignment by passing no userId).
app.post("/api/lab-orders/:id/reassign", requireRole("pathology_staff", "hospital_admin"), async (req, res) => {
  const { userId: targetUserId } = req.body || {};
  try {
    const { hospitalId } = req.session.user;
    if (!targetUserId) {
      const [result] = await pool.query(
        `UPDATE lab_orders SET assigned_to = NULL, status = IF(status = 'in_progress', 'pending', status)
         WHERE id = ? AND hospital_id = ? AND status NOT IN ('completed', 'verified')`,
        [req.params.id, hospitalId]
      );
      if (result.affectedRows === 0) {
        return res.status(409).json({ success: false, message: "This order is already finalized." });
      }
      broadcast(req, "lab_orders");
      return res.json({ success: true });
    }

    const [staffRows] = await pool.query(
      `SELECT user_id FROM users WHERE user_id = ? AND hospital_id = ? AND role = 'pathology_staff' LIMIT 1`,
      [targetUserId, hospitalId]
    );
    if (staffRows.length === 0) {
      return res.status(400).json({ success: false, message: "That staff member was not found." });
    }

    const [result] = await pool.query(
      `UPDATE lab_orders
       SET assigned_to = ?, status = IF(status = 'pending', 'in_progress', status)
       WHERE id = ? AND hospital_id = ? AND status NOT IN ('completed', 'verified')`,
      [targetUserId, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ success: false, message: "This order is already finalized." });
    }
    broadcast(req, "lab_orders");
    res.json({ success: true });
  } catch (err) {
    console.error("Reassign lab order error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Staff directory for the reassign dropdown — pathology_staff in this hospital, optionally
// narrowed to the Radiologist designation when department=Radiology.
app.get("/api/lab-orders/staff", requireRole("pathology_staff", "hospital_admin"), async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT user_id, full_name, details FROM users
       WHERE hospital_id = ? AND role = 'pathology_staff' ORDER BY full_name`,
      [hospitalId]
    );
    const wantRadiology = req.query.department === "Radiology";
    const staff = rows
      .filter((r) => {
        const details = typeof r.details === "string" ? JSON.parse(r.details) : r.details || {};
        const isRadiologist = details.designation === "Radiologist";
        return wantRadiology ? isRadiologist : !isRadiologist;
      })
      .map((r) => ({ userId: r.user_id, fullName: r.full_name }));
    res.json({ success: true, staff });
  } catch (err) {
    console.error("List lab staff error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Multiple study images per order (radiology).
app.get("/api/lab-orders/:id/images", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [orderRows] = await pool.query(`SELECT id FROM lab_orders WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.id,
      hospitalId,
    ]);
    if (orderRows.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const [rows] = await pool.query(
      `SELECT id, file_name AS fileName FROM lab_order_images WHERE lab_order_id = ? AND hospital_id = ? ORDER BY id`,
      [req.params.id, hospitalId]
    );
    res.json({ success: true, images: rows });
  } catch (err) {
    console.error("List lab order images error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post(
  "/api/lab-orders/:id/images",
  requireRole("pathology_staff"),
  labImageUpload.array("images", 10),
  async (req, res) => {
    try {
      const { hospitalId, userId } = req.session.user;
      const [orderRows] = await pool.query(
        `SELECT id FROM lab_orders WHERE id = ? AND hospital_id = ? LIMIT 1`,
        [req.params.id, hospitalId]
      );
      if (orderRows.length === 0) {
        return res.status(404).json({ success: false, message: "Order not found." });
      }
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ success: false, message: "No image files were uploaded." });
      }
      const values = files.map((f) => [hospitalId, req.params.id, f.filename, f.originalname, userId]);
      await pool.query(
        `INSERT INTO lab_order_images (hospital_id, lab_order_id, file_path, file_name, uploaded_by) VALUES ?`,
        [values]
      );
      const [rows] = await pool.query(
        `SELECT id, file_name AS fileName FROM lab_order_images WHERE lab_order_id = ? AND hospital_id = ? ORDER BY id`,
        [req.params.id, hospitalId]
      );
      broadcast(req, "lab_orders");
      res.json({ success: true, images: rows });
    } catch (err) {
      console.error("Upload lab order images error:", err.message);
      res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  }
);

app.get("/api/lab-orders/:id/images/:imageId", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT file_path, file_name FROM lab_order_images
       WHERE id = ? AND lab_order_id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.imageId, req.params.id, hospitalId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Image not found." });
    }
    res.sendFile(path.join(LAB_IMAGES_DIR, rows[0].file_path));
  } catch (err) {
    console.error("Fetch lab order image error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Pharmacy Orders ----------

app.post("/api/pharmacy-orders", requireRole("doctor"), async (req, res) => {
  const { opdVisitId, ipdAdmissionId, patientUhid, medicineName, dosage, duration, urgency, foodInstruction } = req.body;
  if (!patientUhid || !medicineName || !dosage || !duration) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }
  const FOOD_INSTRUCTIONS = ["Before Meal", "After Meal", "With Meal", "Empty Stomach"];
  try {
    const { userId, hospitalId } = req.session.user;
    await pool.query(
      `INSERT INTO medisys_pharmacy.pharmacy_orders
       (hospital_id, opd_visit_id, ipd_admission_id, patient_uhid, doctor_user_id, medicine_name, dosage, duration, urgency, food_instruction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId || 1,
        opdVisitId || null,
        ipdAdmissionId || null,
        patientUhid,
        userId,
        medicineName,
        dosage,
        duration,
        urgency || 'routine',
        FOOD_INSTRUCTIONS.includes(foodInstruction) ? foodInstruction : null,
      ]
    );
    broadcast(req, "pharmacy_orders");
    res.json({ success: true, message: "Prescription sent to pharmacy." });
  } catch (err) {
    console.error("Create pharmacy order error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/pharmacy-orders", requireTenantUser, async (req, res) => {
  try {
    // Was missing a hospital_id filter — every logged-in staff member, at
    // any hospital, could see every other hospital's pharmacy orders. Found
    // while building the admin Pharmacy overview on 2026-08-21.
    const { hospitalId } = req.session.user;
    const [orders] = await pool.query(
      `SELECT po.*, p.full_name as patient_name, p.dob as patient_dob, p.gender as patient_gender
       FROM medisys_pharmacy.pharmacy_orders po
       LEFT JOIN patients p ON po.patient_uhid = p.uhid
       WHERE po.hospital_id = ?
       ORDER BY po.created_at DESC`,
      [hospitalId]
    );
    res.json({ success: true, orders });
  } catch (err) {
    console.error("Get pharmacy orders error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/pharmacy-orders/:id/dispense", requireTenantUser, async (req, res) => {
  try {
    const { userId, hospitalId } = req.session.user;
    const orderId = req.params.id;

    // 1. Get the order to find medicine name
    const [orders] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_orders WHERE id = ? AND hospital_id = ?`, [orderId, hospitalId]
    );
    if (orders.length === 0) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }
    const order = orders[0];
    if (order.status === 'dispensed') {
      return res.status(400).json({ success: false, message: "Already dispensed." });
    }

    // 2. Auto-deduct stock — find matching stock by medicine name (case-insensitive, closest match)
    //    Pick the batch with earliest expiry (FEFO — First Expiry First Out) that has stock > 0
    //    Scoped to this hospital — was missing hospital_id, so dispensing here
    //    could silently deduct another hospital's stock. Found/fixed alongside
    //    the low-stock alert feature on 2026-08-21.
    const medName = order.medicine_name.trim();
    const [matchingStock] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_stock
       WHERE hospital_id = ? AND LOWER(medicine_name) LIKE CONCAT('%', LOWER(?), '%') AND stock_quantity > 0
       ORDER BY expiry_date ASC LIMIT 1`,
      [hospitalId, medName]
    );

    let stockDeducted = false;
    let stockWarning = null;
    if (matchingStock.length > 0) {
      const stock = matchingStock[0];
      await pool.query(
        `UPDATE medisys_pharmacy.pharmacy_stock SET stock_quantity = stock_quantity - 1 WHERE id = ? AND stock_quantity > 0`,
        [stock.id]
      );
      stockDeducted = true;
      if (stock.stock_quantity - 1 <= stock.min_stock_level) {
        stockWarning = `Low stock alert: ${stock.medicine_name} has only ${stock.stock_quantity - 1} left.`;
      }
    }

    // 3. Price this dose now, while we still know which stock batch it came from —
    // billing reads this back later instead of re-matching stock at bill time.
    const dispensedAmount = matchingStock.length > 0 && matchingStock[0].unit_price
      ? matchingStock[0].unit_price
      : (order.amount || 15.00);

    // 4. Mark order as dispensed. No invoice is created here — dispensing just moves
    // the medicine into the "ready to bill" pool; a pharmacist combines everything
    // pending for a patient into one invoice from the Billing tab.
    await pool.query(
      `UPDATE medisys_pharmacy.pharmacy_orders
       SET status = 'dispensed', dispensed_by = ?, dispensed_at = NOW(), amount = ?
       WHERE id = ?`,
      [userId, dispensedAmount, orderId]
    );

    broadcast(req, "pharmacy_orders");
    broadcast(req, "pharmacy_stock");
    res.json({
      success: true,
      message: "Medicine dispensed successfully.",
      stockDeducted,
      stockWarning,
    });
  } catch (err) {
    console.error("Dispense pharmacy order error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Dispensed medicines waiting to be combined into one bill for their patient.
app.get("/api/pharmacy-orders/ready-to-bill", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [orders] = await pool.query(
      `SELECT po.*, p.full_name as patient_name, p.dob as patient_dob, p.gender as patient_gender
       FROM medisys_pharmacy.pharmacy_orders po
       LEFT JOIN patients p ON po.patient_uhid = p.uhid
       WHERE po.hospital_id = ? AND po.status = 'dispensed' AND po.invoice_id IS NULL
       ORDER BY po.dispensed_at DESC`,
      [hospitalId]
    );
    res.json({ success: true, orders });
  } catch (err) {
    console.error("Get ready-to-bill orders error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Pharmacy Invoices / Billing ----------

app.get("/api/pharmacy-invoices", requireTenantUser, async (req, res) => {
  try {
    const [invoices] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_invoices ORDER BY created_at DESC`
    );
    
    // Calculate stats
    let totalBilled = 0;
    let collected = 0;
    let pendingCount = 0;

    invoices.forEach(inv => {
      const amt = parseFloat(inv.total_amount) || 0;
      totalBilled += amt;
      if (inv.payment_status === 'Paid') {
        collected += amt;
      } else {
        pendingCount += 1;
      }
    });

    res.json({
      success: true,
      invoices,
      stats: {
        totalBilled,
        collected,
        pendingCount
      }
    });
  } catch (err) {
    console.error("Get pharmacy invoices error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/pharmacy-invoices/:id/pay", requireTenantUser, async (req, res) => {
  try {
    const { paymentType } = req.body || {};
    const pType = paymentType && paymentType.trim() ? paymentType.trim() : 'Cash';

    await pool.query(
      `UPDATE medisys_pharmacy.pharmacy_invoices SET payment_status = 'Paid', payment_type = ?, paid_at = NOW() WHERE id = ? AND hospital_id = ?`,
      [pType, req.params.id, req.session.user.hospitalId]
    );
    broadcast(req, "pharmacy_invoices");
    res.json({ success: true, message: "Payment marked as Paid." });
  } catch (err) {
    console.error("Mark invoice paid error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Real online payment for a pharmacy invoice — the "Razorpay" tile in the
// Collect Payment modal (staff/pharmacy-queue.html) used to just call the
// manual /pay endpoint above with paymentType="Razorpay" with no actual
// transaction; these two routes make that real.
app.post("/api/pharmacy-invoices/:id/create-order", requireTenantUser, async (req, res) => {
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ success: false, message: "Online payment isn't configured on this server yet." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT total_amount, payment_status FROM medisys_pharmacy.pharmacy_invoices WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Invoice not found." });
    if (rows[0].payment_status === "Paid") {
      return res.status(409).json({ success: false, message: "This invoice is already paid." });
    }

    const order = await createPaymentOrder(req, hospitalId, "pharmacy_invoice", req.params.id, rows[0].total_amount);
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error("Create pharmacy invoice order error:", err.message);
    res.status(500).json({ success: false, message: err.message || "Server error. Please try again." });
  }
});

app.post("/api/pharmacy-invoices/:id/verify-payment", requireTenantUser, async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: "Incomplete payment response." });
  }
  try {
    const { hospitalId } = req.session.user;
    const result = await verifyPaymentOrder(hospitalId, "pharmacy_invoice", req.params.id, razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

    await pool.query(
      `UPDATE medisys_pharmacy.pharmacy_invoices SET payment_status = 'Paid', payment_type = 'Razorpay', paid_at = NOW() WHERE id = ? AND hospital_id = ?`,
      [req.params.id, hospitalId]
    );
    broadcast(req, "pharmacy_invoices");
    res.json({ success: true });
  } catch (err) {
    console.error("Verify pharmacy invoice payment error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Combines every dispensed-but-unbilled medicine picked for one patient into a
// single invoice — this is the "final combined bill" a pharmacist generates.
app.post("/api/pharmacy-invoices/generate", requireTenantUser, async (req, res) => {
  const { orderIds } = req.body || {};
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ success: false, message: "Select at least one dispensed medicine to bill." });
  }

  try {
    const { userId, hospitalId } = req.session.user;

    const [orders] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_orders
       WHERE id IN (?) AND hospital_id = ? AND status = 'dispensed' AND invoice_id IS NULL`,
      [orderIds, hospitalId]
    );

    if (orders.length === 0) {
      return res.status(409).json({
        success: false,
        message: "Those medicines are no longer available to bill — they may already be on another invoice.",
      });
    }

    const patientUhid = orders[0].patient_uhid;
    if (orders.some((o) => o.patient_uhid !== patientUhid)) {
      return res.status(400).json({ success: false, message: "All medicines in one bill must belong to the same patient." });
    }

    let patientName = "Patient (" + patientUhid + ")";
    const [pRows] = await pool.query(`SELECT full_name FROM patients WHERE uhid = ?`, [patientUhid]);
    if (pRows.length > 0 && pRows[0].full_name) patientName = pRows[0].full_name;

    const totalAmount = orders.reduce((sum, o) => sum + parseFloat(o.amount || 15), 0);
    const invNum = "PHINV-" + (8800 + Math.floor(Math.random() * 1000));

    const [result] = await pool.query(
      `INSERT INTO medisys_pharmacy.pharmacy_invoices
       (hospital_id, invoice_number, order_id, patient_uhid, patient_name, payment_type, item_count, total_amount, payment_status, created_by)
       VALUES (?, ?, ?, ?, ?, 'Cash', ?, ?, 'Pending', ?)`,
      [hospitalId, invNum, orders[0].id, patientUhid, patientName, orders.length, totalAmount, userId]
    );
    const invoiceId = result.insertId;

    await pool.query(`UPDATE medisys_pharmacy.pharmacy_orders SET invoice_id = ? WHERE id IN (?)`, [
      invoiceId,
      orders.map((o) => o.id),
    ]);

    broadcast(req, "pharmacy_orders");
    broadcast(req, "pharmacy_invoices");
    res.json({ success: true, invoiceId, invoiceNumber: invNum, itemCount: orders.length, totalAmount });
  } catch (err) {
    console.error("Generate pharmacy invoice error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// The medicine-level line items behind one invoice — what the printed bill itemizes.
app.get("/api/pharmacy-invoices/:id/items", requireTenantUser, async (req, res) => {
  try {
    const [items] = await pool.query(
      `SELECT id, medicine_name, dosage, duration, urgency, amount, doctor_user_id, dispensed_at
       FROM medisys_pharmacy.pharmacy_orders WHERE invoice_id = ? ORDER BY id ASC`,
      [req.params.id]
    );
    res.json({ success: true, items });
  } catch (err) {
    console.error("Get invoice items error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Pharmacy Patients Directory ----------

app.get("/api/pharmacy-patients", requireTenantUser, async (req, res) => {
  try {
    const query = req.query.search ? req.query.search.trim() : '';

    let sql = `
      SELECT p.uhid, p.full_name, p.dob, p.gender, p.phone,
             COUNT(po.id) as total_prescriptions,
             MAX(po.created_at) as last_dispensed_at
      FROM patients p
      LEFT JOIN medisys_pharmacy.pharmacy_orders po ON p.uhid = po.patient_uhid
    `;
    const params = [];

    if (query) {
      sql += ` WHERE p.full_name LIKE ? OR p.uhid LIKE ? OR p.phone LIKE ?`;
      params.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }

    sql += ` GROUP BY p.uhid, p.full_name, p.dob, p.gender, p.phone ORDER BY last_dispensed_at DESC, p.full_name ASC LIMIT 50`;

    const [patients] = await pool.query(sql, params);
    res.json({ success: true, patients });
  } catch (err) {
    console.error("Get pharmacy patients error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/pharmacy-patients/:uhid/history", requireTenantUser, async (req, res) => {
  try {
    const { uhid } = req.params;

    const [orders] = await pool.query(
      `SELECT po.*, u.full_name as doctor_name
       FROM medisys_pharmacy.pharmacy_orders po
       LEFT JOIN users u ON po.doctor_user_id = u.user_id
       WHERE po.patient_uhid = ?
       ORDER BY po.created_at DESC`,
      [uhid]
    );

    res.json({ success: true, orders });
  } catch (err) {
    console.error("Get patient pharmacy history error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Direct Pharmacy Sale / Auto Stock Deduct ----------

app.post("/api/pharmacy-direct-sale", requireTenantUser, async (req, res) => {
  try {
    const { userId, hospitalId } = req.session.user;
    const { stockId, quantity, patientName, phone, paymentMode } = req.body;

    const qty = parseInt(quantity, 10);
    if (!stockId || !qty || qty <= 0) {
      return res.status(400).json({ success: false, message: "Valid medicine and quantity are required." });
    }

    // 1. Check stock availability
    const [stocks] = await pool.query(`SELECT * FROM medisys_pharmacy.pharmacy_stock WHERE id = ?`, [stockId]);
    if (stocks.length === 0) {
      return res.status(404).json({ success: false, message: "Medicine stock item not found." });
    }

    const stock = stocks[0];
    if (stock.stock_quantity < qty) {
      return res.status(400).json({ 
        success: false, 
        message: `Insufficient stock. Only ${stock.stock_quantity} left in stock.` 
      });
    }

    // 2. Auto-deduct stock
    await pool.query(
      `UPDATE medisys_pharmacy.pharmacy_stock SET stock_quantity = stock_quantity - ? WHERE id = ?`,
      [qty, stockId]
    );

    // 3. Create Bill Invoice (Pending Payment)
    const invNum = "PHINV-" + (8800 + Math.floor(Math.random() * 1000));
    const unitPrice = parseFloat(stock.unit_price) || 15.00;
    const totalAmount = unitPrice * qty;
    const pName = patientName && patientName.trim() ? patientName.trim() : "Walk-in Counter Patient";
    const pUhid = phone && phone.trim() ? "PH-" + phone.trim() : "WALKIN-OTC";

    await pool.query(
      `INSERT INTO medisys_pharmacy.pharmacy_invoices 
       (hospital_id, invoice_number, patient_uhid, patient_name, payment_type, item_count, total_amount, payment_status, created_by)
       VALUES (?, ?, ?, ?, 'Pending', ?, ?, 'Pending', ?)`,
      [hospitalId || 1, invNum, pUhid, pName, qty, totalAmount, userId]
    );

    broadcast(req, "pharmacy_stock");
    broadcast(req, "pharmacy_invoices");
    res.json({
      success: true,
      message: `Successfully dispensed ${qty} unit(s) of ${stock.medicine_name}. Stock auto-deducted!`,
      newQuantity: stock.stock_quantity - qty,
      invoiceNumber: invNum
    });
  } catch (err) {
    console.error("Direct pharmacy sale error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Pharmacy Stock ----------

app.get("/api/pharmacy-stock", requireTenantUser, async (req, res) => {
  try {
    // Was missing a hospital_id filter — every hospital's stock was visible
    // to every other hospital's staff. Found/fixed alongside the low-stock
    // alert feature on 2026-08-21.
    const { hospitalId } = req.session.user;
    const [stock] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_stock WHERE hospital_id = ? ORDER BY medicine_name ASC`,
      [hospitalId]
    );
    res.json({ success: true, stock });
  } catch (err) {
    console.error("Get pharmacy stock error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/pharmacy-stock", requireTenantUser, async (req, res) => {
  try {
    const { userId, hospitalId } = req.session.user;
    const { medicineName, category, batchNumber, expiryDate, stockQuantity, minStockLevel, unitPrice, supplierName } = req.body;

    if (!medicineName || !category || !batchNumber || !expiryDate || stockQuantity === undefined) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // received_quantity is set once here and never mutated again — it's the
    // batch's original size, kept separate from stock_quantity (which
    // dispensing/edits move) so "10% of the last-received batch" default
    // reorder thresholds stay meaningful after the batch has been drawn down.
    await pool.query(
      `INSERT INTO medisys_pharmacy.pharmacy_stock
       (hospital_id, medicine_name, category, batch_number, expiry_date, stock_quantity, received_quantity, min_stock_level, unit_price, supplier_name, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [hospitalId || 1, medicineName, category, batchNumber, expiryDate, stockQuantity, stockQuantity, minStockLevel || 10, unitPrice || null, supplierName || null, userId]
    );
    broadcast(req, "pharmacy_stock");
    res.json({ success: true, message: "Stock added successfully." });
  } catch (err) {
    console.error("Add pharmacy stock error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Edit stock
app.put("/api/pharmacy-stock/:id", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const { medicineName, category, batchNumber, expiryDate, stockQuantity, minStockLevel, unitPrice, supplierName } = req.body;
    // Scoped to hospital_id so staff can't edit another hospital's stock row
    // by guessing/incrementing an id.
    const [result] = await pool.query(
      `UPDATE medisys_pharmacy.pharmacy_stock SET
       medicine_name = ?, category = ?, batch_number = ?, expiry_date = ?,
       stock_quantity = ?, min_stock_level = ?, unit_price = ?, supplier_name = ?
       WHERE id = ? AND hospital_id = ?`,
      [medicineName, category, batchNumber, expiryDate, stockQuantity, minStockLevel || 10, unitPrice || null, supplierName || null, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Stock entry not found." });
    }
    broadcast(req, "pharmacy_stock");
    res.json({ success: true, message: "Stock updated." });
  } catch (err) {
    console.error("Update pharmacy stock error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Delete stock
app.delete("/api/pharmacy-stock/:id", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [result] = await pool.query(
      `DELETE FROM medisys_pharmacy.pharmacy_stock WHERE id = ? AND hospital_id = ?`,
      [req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Stock entry not found." });
    }
    broadcast(req, "pharmacy_stock");
    res.json({ success: true, message: "Stock entry deleted." });
  } catch (err) {
    console.error("Delete pharmacy stock error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Low Stock Alerts (per-medicine, aggregated across batches) ----------
//
// pharmacy_stock has no separate "medicines" table — every batch just repeats
// the medicine's name as a string, so "per medicine" here means grouping
// batches by (case-insensitive) medicine_name. A medicine counts as low stock
// when its total quantity across all *non-expired* batches is at or below its
// reorder threshold — either a manually-set value (medicine_thresholds table)
// or, if never set, a live-computed default of 10% of the most recently
// received batch's original size.
app.get("/api/pharmacy-stock/low-stock", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [batches] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_stock WHERE hospital_id = ? ORDER BY created_at DESC`,
      [hospitalId]
    );
    const [thresholdRows] = await pool.query(
      `SELECT medicine_name, reorder_threshold, reorder_threshold_type FROM medisys_pharmacy.medicine_thresholds WHERE hospital_id = ?`,
      [hospitalId]
    );
    const thresholdMap = new Map(thresholdRows.map((r) => [r.medicine_name.trim().toLowerCase(), r]));

    // A medicine with a 'Submitted' PO already covering it shouldn't nag the
    // pharmacist again on the Low Stock tab — they've already acted on it.
    // items_summary is just a comma-joined string of medicine names (see
    // auto-generate/reorder below), so this is a substring match rather than
    // a proper foreign key — good enough at this scale, matches how dispense
    // already fuzzy-matches medicine names elsewhere in this file.
    const [pendingOrders] = await pool.query(
      `SELECT items_summary FROM medisys_pharmacy.pharmacy_purchase_orders WHERE hospital_id = ? AND status = 'Submitted'`,
      [hospitalId]
    );
    function hasPendingOrderFor(medicineName) {
      const needle = medicineName.trim().toLowerCase();
      return pendingOrders.some((po) =>
        po.items_summary
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .includes(needle)
      );
    }

    const byMedicine = new Map();
    for (const b of batches) {
      const key = b.medicine_name.trim().toLowerCase();
      if (!byMedicine.has(key)) {
        byMedicine.set(key, { medicineName: b.medicine_name, category: b.category, batches: [], lastBatch: b });
      }
      const group = byMedicine.get(key);
      group.batches.push(b);
      // batches were fetched ORDER BY created_at DESC, so the first one seen
      // per medicine is already the most recently received.
    }

    const now = new Date();
    const DEFAULT_THRESHOLD_PCT = 10;
    const medicines = [];
    for (const [key, group] of byMedicine) {
      const currentStock = group.batches
        .filter((b) => new Date(b.expiry_date) >= now)
        .reduce((sum, b) => sum + Number(b.stock_quantity), 0);

      const th = thresholdMap.get(key);
      const hasCustomThreshold = Boolean(th && th.reorder_threshold !== null);
      const thresholdType = hasCustomThreshold ? th.reorder_threshold_type : "percentage";
      const thresholdValue = hasCustomThreshold ? Number(th.reorder_threshold) : DEFAULT_THRESHOLD_PCT;
      // Older rows added before received_quantity existed fall back to their
      // current stock_quantity as the closest available approximation.
      const lastBatchReceivedQty = Number(group.lastBatch.received_quantity ?? group.lastBatch.stock_quantity);
      const effectiveThreshold =
        thresholdType === "percentage" ? Math.round((thresholdValue / 100) * lastBatchReceivedQty) : Math.round(thresholdValue);

      medicines.push({
        medicineName: group.medicineName,
        category: group.category,
        currentStock,
        threshold: effectiveThreshold,
        reorderThreshold: hasCustomThreshold ? thresholdValue : null,
        reorderThresholdType: thresholdType,
        isCustomThreshold: hasCustomThreshold,
        lastSupplier: group.lastBatch.supplier_name || null,
        lastBatchAt: group.lastBatch.created_at,
        isLow: currentStock <= effectiveThreshold,
        hasPendingOrder: hasPendingOrderFor(group.medicineName),
      });
    }

    medicines.sort((a, b) => a.medicineName.localeCompare(b.medicineName));
    res.json({ success: true, medicines });
  } catch (err) {
    console.error("Low stock check error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.put("/api/pharmacy-stock/thresholds", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const { medicineName, reorderThreshold, reorderThresholdType } = req.body || {};
    if (!medicineName || !String(medicineName).trim()) {
      return res.status(400).json({ success: false, message: "Medicine name is required." });
    }
    const type = reorderThresholdType === "fixed" ? "fixed" : "percentage";
    const value = reorderThreshold === "" || reorderThreshold === undefined || reorderThreshold === null ? null : Number(reorderThreshold);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ success: false, message: "Threshold must be a non-negative number." });
    }

    await pool.query(
      `INSERT INTO medisys_pharmacy.medicine_thresholds (hospital_id, medicine_name, reorder_threshold, reorder_threshold_type, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE reorder_threshold = VALUES(reorder_threshold), reorder_threshold_type = VALUES(reorder_threshold_type),
         updated_by = VALUES(updated_by), updated_at = NOW()`,
      [hospitalId, String(medicineName).trim(), value, type, userId]
    );
    broadcast(req, "pharmacy_stock");
    res.json({ success: true, message: "Reorder threshold updated." });
  } catch (err) {
    console.error("Update medicine threshold error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Pharmacy Purchase Orders ----------

app.get("/api/pharmacy-purchase-orders", requireTenantUser, async (req, res) => {
  try {
    // Was missing a hospital_id filter — every hospital's purchase orders
    // were visible to every other hospital's staff. Found/fixed alongside
    // the low-stock alert feature on 2026-08-21.
    const { hospitalId } = req.session.user;
    const [orders] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_purchase_orders WHERE hospital_id = ? ORDER BY created_at DESC`,
      [hospitalId]
    );
    res.json({ success: true, orders });
  } catch (err) {
    console.error("Get purchase orders error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/pharmacy-purchase-orders/auto-generate", requireTenantUser, async (req, res) => {
  try {
    const { userId, hospitalId } = req.session.user;

    // Find all low/out of stock items — was missing a hospital_id filter
    // (would generate a PO listing every hospital's low-stock batches).
    // Found/fixed alongside the low-stock alert feature on 2026-08-21.
    const [lowStock] = await pool.query(
      `SELECT * FROM medisys_pharmacy.pharmacy_stock WHERE hospital_id = ? AND stock_quantity <= min_stock_level`,
      [hospitalId]
    );

    if (lowStock.length === 0) {
      return res.json({ success: false, message: "Nothing needs reordering right now." });
    }

    const poNumber = "PO-" + Date.now().toString().slice(-6);
    const supplierName = "Central Pharma Wholesalers Ltd.";
    const itemsSummary = lowStock.map(s => s.medicine_name).join(", ");
    const totalItems = lowStock.length;

    await pool.query(
      `INSERT INTO medisys_pharmacy.pharmacy_purchase_orders
       (hospital_id, po_number, supplier_name, items_summary, total_items, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'Submitted', ?)`,
      [hospitalId || 1, poNumber, supplierName, itemsSummary, totalItems, userId]
    );

    // "pharmacy_stock" is what drives the Low Stock tab's live refresh
    // (it re-fetches /api/pharmacy-stock/low-stock, which now excludes
    // medicines with a pending PO) — without this broadcast, staff would
    // have to manually reload to see the item drop off the list.
    broadcast(req, "pharmacy_stock");
    broadcast(req, "pharmacy_purchase_orders");
    res.json({ success: true, message: `Generated PO #${poNumber} for ${totalItems} item(s).`, poNumber });
  } catch (err) {
    console.error("Auto generate PO error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Reorder a single medicine from the Low Stock tab — same PO-creation
// mechanics as auto-generate above, just scoped to one medicine instead of
// every currently-low batch, per the "Create PO" button on each low-stock row.
app.post("/api/pharmacy-purchase-orders/reorder", requireTenantUser, async (req, res) => {
  try {
    const { userId, hospitalId } = req.session.user;
    const { medicineName, supplierName } = req.body || {};
    if (!medicineName || !String(medicineName).trim()) {
      return res.status(400).json({ success: false, message: "Medicine name is required." });
    }

    const poNumber = "PO-" + Date.now().toString().slice(-6);
    const resolvedSupplier = supplierName || "Central Pharma Wholesalers Ltd.";

    await pool.query(
      `INSERT INTO medisys_pharmacy.pharmacy_purchase_orders
       (hospital_id, po_number, supplier_name, items_summary, total_items, status, created_by)
       VALUES (?, ?, ?, ?, 1, 'Submitted', ?)`,
      [hospitalId, poNumber, resolvedSupplier, String(medicineName).trim(), userId]
    );

    // Same reasoning as auto-generate above: "pharmacy_stock" makes the Low
    // Stock tab drop this medicine live (it now has a pending order),
    // "pharmacy_purchase_orders" makes the new PO appear in the Orders tab.
    broadcast(req, "pharmacy_stock");
    broadcast(req, "pharmacy_purchase_orders");
    res.json({ success: true, message: `Generated PO #${poNumber} for ${medicineName}.`, poNumber });
  } catch (err) {
    console.error("Reorder single medicine error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Mark a PO Received (stock has physically arrived — staff still adds it as
// a new batch via the normal Add Stock flow separately, this just closes the
// order) or Cancelled (never came through — the medicine goes back to
// needing attention on the Low Stock tab immediately, since it's no longer
// "Submitted" and so no longer suppresses that tab's hasPendingOrder flag).
app.patch("/api/pharmacy-purchase-orders/:id/status", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const { status } = req.body || {};
    const ALLOWED = ["Received", "Cancelled"];
    if (!ALLOWED.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${ALLOWED.join(", ")}.` });
    }
    const [result] = await pool.query(
      `UPDATE medisys_pharmacy.pharmacy_purchase_orders SET status = ? WHERE id = ? AND hospital_id = ?`,
      [status, req.params.id, hospitalId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Purchase order not found." });
    }
    broadcast(req, "pharmacy_stock");
    broadcast(req, "pharmacy_purchase_orders");
    res.json({ success: true, message: `Purchase order marked ${status}.` });
  } catch (err) {
    console.error("Update purchase order status error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Wards & beds ----------

app.get("/api/wards", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [wards] = await pool.query(`SELECT id, name FROM wards WHERE hospital_id = ? ORDER BY name`, [
      hospitalId,
    ]);
    const [beds] = await pool.query(
      `SELECT id, ward_id, bed_number, status FROM beds WHERE hospital_id = ? ORDER BY bed_number`,
      [hospitalId]
    );
    const wardsWithBeds = wards.map((w) => ({ ...w, beds: beds.filter((b) => b.ward_id === w.id) }));
    res.json({ success: true, wards: wardsWithBeds });
  } catch (err) {
    console.error("Get wards error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/wards", requireRole("nurse", "hospital_admin"), async (req, res) => {
  const { name, bedCount } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: "Ward name is required." });
  }
  const count = Number(bedCount);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ success: false, message: "Enter a valid number of beds (1-200)." });
  }
  try {
    const { hospitalId, userId } = req.session.user;
    const [result] = await pool.query(
      `INSERT INTO wards (hospital_id, name, created_by) VALUES (?, ?, ?)`,
      [hospitalId, name.trim(), userId]
    );
    const wardId = result.insertId;
    const bedValues = [];
    for (let i = 1; i <= count; i++) {
      bedValues.push([hospitalId, wardId, `B-${String(i).padStart(2, "0")}`]);
    }
    await pool.query(`INSERT INTO beds (hospital_id, ward_id, bed_number) VALUES ?`, [bedValues]);
    broadcast(req, "wards_beds");
    res.json({ success: true, id: wardId, bedsCreated: count });
  } catch (err) {
    console.error("Create ward error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Add more auto-numbered beds to an existing ward — continues the sequence from
// however many beds it already has, no manual bed-number entry.
app.post("/api/wards/:wardId/beds", requireRole("nurse", "hospital_admin"), async (req, res) => {
  const count = Number(req.body && req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ success: false, message: "Enter a valid number of beds (1-200)." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [wardRows] = await pool.query(`SELECT id FROM wards WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.wardId,
      hospitalId,
    ]);
    if (wardRows.length === 0) {
      return res.status(404).json({ success: false, message: "Ward not found." });
    }
    const [[{ existing }]] = await pool.query(`SELECT COUNT(*) AS existing FROM beds WHERE ward_id = ?`, [
      req.params.wardId,
    ]);
    const bedValues = [];
    for (let i = 1; i <= count; i++) {
      bedValues.push([hospitalId, req.params.wardId, `B-${String(existing + i).padStart(2, "0")}`]);
    }
    await pool.query(`INSERT INTO beds (hospital_id, ward_id, bed_number) VALUES ?`, [bedValues]);
    broadcast(req, "wards_beds");
    res.json({ success: true, bedsCreated: count });
  } catch (err) {
    console.error("Create bed error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/wards/:wardId", requireRole("nurse", "hospital_admin"), async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [wardRows] = await pool.query(`SELECT id, name FROM wards WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.wardId,
      hospitalId,
    ]);
    if (wardRows.length === 0) {
      return res.status(404).json({ success: false, message: "Ward not found." });
    }
    const [[{ occupied }]] = await pool.query(
      `SELECT COUNT(*) AS occupied FROM beds WHERE ward_id = ? AND status != 'available'`,
      [req.params.wardId]
    );
    if (occupied > 0) {
      return res.status(409).json({
        success: false,
        message: `${wardRows[0].name} has ${occupied} occupied bed(s) — discharge or reassign those patients before deleting the ward.`,
      });
    }
    await pool.query(`DELETE FROM beds WHERE ward_id = ? AND hospital_id = ?`, [req.params.wardId, hospitalId]);
    await pool.query(`DELETE FROM wards WHERE id = ? AND hospital_id = ?`, [req.params.wardId, hospitalId]);
    broadcast(req, "wards_beds");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete ward error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/beds/available", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT b.id, b.bed_number, w.id AS ward_id, w.name AS ward_name
       FROM beds b JOIN wards w ON w.id = b.ward_id
       WHERE b.hospital_id = ? AND b.status = 'available' ORDER BY w.name, b.bed_number`,
      [hospitalId]
    );
    res.json({ success: true, beds: rows });
  } catch (err) {
    console.error("Get available beds error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Nurse shift roster (ward_based assignment mode) ----------

app.get("/api/nurse-roster", requireRole("hospital_admin"), async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT r.id, r.nurse_user_id, u.full_name AS nurse_name, r.ward_id, w.name AS ward_name,
              r.shift, r.day_of_week
       FROM nurse_shift_roster r
       LEFT JOIN users u ON u.user_id = r.nurse_user_id
       LEFT JOIN wards w ON w.id = r.ward_id
       WHERE r.hospital_id = ?
       ORDER BY r.day_of_week, r.shift, w.name`,
      [hospitalId]
    );
    res.json({ success: true, roster: rows });
  } catch (err) {
    console.error("List nurse roster error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/nurse-roster", requireRole("hospital_admin"), async (req, res) => {
  const { nurseUserId, wardId, shift, dayOfWeek } = req.body || {};
  if (!nurseUserId || !wardId || !shift || dayOfWeek === undefined || dayOfWeek === null) {
    return res.status(400).json({
      success: false,
      message: "Nurse, ward, shift, and day are required.",
    });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO nurse_shift_roster (hospital_id, nurse_user_id, ward_id, shift, day_of_week)
       VALUES (?, ?, ?, ?, ?)`,
      [req.session.user.hospitalId, nurseUserId, wardId, shift, dayOfWeek]
    );
    broadcast(req, "nurse_roster");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Create nurse roster entry error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/nurse-roster/:id", requireRole("hospital_admin"), async (req, res) => {
  try {
    await pool.query(`DELETE FROM nurse_shift_roster WHERE id = ? AND hospital_id = ?`, [
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "nurse_roster");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete nurse roster entry error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Doctor-nurse teams (doctor_team assignment mode) ----------

app.get("/api/doctor-nurse-teams", requireRole("hospital_admin"), async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT t.id, t.doctor_user_id, d.full_name AS doctor_name, t.nurse_user_id, n.full_name AS nurse_name
       FROM doctor_nurse_teams t
       LEFT JOIN users d ON d.user_id = t.doctor_user_id
       LEFT JOIN users n ON n.user_id = t.nurse_user_id
       WHERE t.hospital_id = ?
       ORDER BY d.full_name, n.full_name`,
      [hospitalId]
    );
    res.json({ success: true, teams: rows });
  } catch (err) {
    console.error("List doctor-nurse teams error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/doctor-nurse-teams", requireRole("hospital_admin"), async (req, res) => {
  const { doctorUserId, nurseUserId } = req.body || {};
  if (!doctorUserId || !nurseUserId) {
    return res.status(400).json({ success: false, message: "Doctor and nurse are required." });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO doctor_nurse_teams (hospital_id, doctor_user_id, nurse_user_id) VALUES (?, ?, ?)`,
      [req.session.user.hospitalId, doctorUserId, nurseUserId]
    );
    broadcast(req, "nurse_roster");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Create doctor-nurse team error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/doctor-nurse-teams/:id", requireRole("hospital_admin"), async (req, res) => {
  try {
    await pool.query(`DELETE FROM doctor_nurse_teams WHERE id = ? AND hospital_id = ?`, [
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "nurse_roster");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete doctor-nurse team error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- IPD admissions ----------

app.post("/api/ipd/admissions", requireReceptionistOrAdmin, async (req, res) => {
  const { patientUhid, admittingDoctorUserId, consentObtained, idProofNote } = req.body || {};
  if (!patientUhid) {
    return res.status(400).json({ success: false, message: "Patient is required." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [existing] = await pool.query(
      `SELECT id FROM ipd_admissions WHERE hospital_id = ? AND patient_uhid = ? AND status IN ('requested', 'admitted') LIMIT 1`,
      [hospitalId, patientUhid]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "This patient already has an active or pending admission.",
      });
    }

    const [result] = await pool.query(
      `INSERT INTO ipd_admissions
        (hospital_id, patient_uhid, admitting_doctor_user_id, consent_obtained, id_proof_note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        hospitalId,
        patientUhid,
        admittingDoctorUserId || null,
        !!consentObtained,
        idProofNote || null,
        req.session.user.userId,
      ]
    );
    broadcast(req, "ipd_admissions");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Create admission error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/ipd/admissions", requireTenantUser, async (req, res) => {
  const { status } = req.query;
  // Nurses are scoped to their own admitted patients — but a "requested" admission has
  // no nurse assigned yet by definition (that only happens once a bed is allocated), so
  // that scoping must NOT apply there or Bed Allocation would show every nurse an empty
  // list of pending requests. scope=all lets a nurse deliberately see every admitted
  // patient in the hospital (e.g. an "All Patients" ward overview), not just their own.
  // Other roles may pass assignedNurseId for oversight.
  const assignedNurseId =
    req.session.user.role === "nurse" && status !== "requested" && req.query.scope !== "all"
      ? req.session.user.userId
      : req.query.assignedNurseId;
  try {
    const { hospitalId } = req.session.user;
    let query = `SELECT a.id, a.patient_uhid, a.admitting_doctor_user_id, a.ward_id, a.bed_id, a.status,
                        a.assigned_nurse_id, a.created_at, a.admitted_at, a.discharged_at, p.full_name AS patient_name,
                        u.full_name AS doctor_name, w.name AS ward_name, b.bed_number
                 FROM ipd_admissions a
                 LEFT JOIN patients p ON p.uhid = a.patient_uhid
                 LEFT JOIN users u ON u.user_id = a.admitting_doctor_user_id
                 LEFT JOIN wards w ON w.id = a.ward_id
                 LEFT JOIN beds b ON b.id = a.bed_id
                 WHERE a.hospital_id = ?`;
    const params = [hospitalId];
    if (status) {
      query += " AND a.status = ?";
      params.push(status);
    }
    if (assignedNurseId) {
      query += " AND a.assigned_nurse_id = ?";
      params.push(assignedNurseId);
    }
    query += " ORDER BY a.created_at DESC";

    const [rows] = await pool.query(query, params);
    res.json({ success: true, admissions: rows });
  } catch (err) {
    console.error("List admissions error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/ipd/admissions/:id", requireTenantUser, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT a.*, p.full_name AS patient_name, u.full_name AS doctor_name,
              w.name AS ward_name, b.bed_number
       FROM ipd_admissions a
       LEFT JOIN patients p ON p.uhid = a.patient_uhid
       LEFT JOIN users u ON u.user_id = a.admitting_doctor_user_id
       LEFT JOIN wards w ON w.id = a.ward_id
       LEFT JOIN beds b ON b.id = a.bed_id
       WHERE a.id = ? AND a.hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Admission not found." });
    }

    const [orders] = await pool.query(
      `SELECT id, order_type, description, ordered_by, created_at
       FROM doctor_orders WHERE hospital_id = ? AND ipd_admission_id = ? ORDER BY created_at DESC`,
      [hospitalId, req.params.id]
    );
    const [mar] = await pool.query(
      `SELECT id, medicine_name, dose, administered_by, administered_at, notes
       FROM medication_administration WHERE hospital_id = ? AND ipd_admission_id = ? ORDER BY administered_at DESC`,
      [hospitalId, req.params.id]
    );
    const [notes] = await pool.query(
      `SELECT id, note_type, message, flagged_by, created_at
       FROM ipd_notes WHERE hospital_id = ? AND ipd_admission_id = ? ORDER BY created_at DESC`,
      [hospitalId, req.params.id]
    );
    const [vitals] = await pool.query(
      `SELECT id, bp, temperature, weight, spo2, recorded_by, recorded_at
       FROM vitals WHERE hospital_id = ? AND ipd_admission_id = ? ORDER BY recorded_at DESC`,
      [hospitalId, req.params.id]
    );

    res.json({ success: true, admission: rows[0], orders, mar, notes, vitals });
  } catch (err) {
    console.error("Get admission error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/ipd/admissions/:id/allocate-bed", requireRole("nurse", "hospital_admin"), async (req, res) => {
  const { bedId } = req.body || {};
  if (!bedId) {
    return res.status(400).json({ success: false, message: "Bed is required." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [bedRows] = await pool.query(
      `SELECT ward_id, status FROM beds WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [bedId, hospitalId]
    );
    if (bedRows.length === 0) {
      return res.status(404).json({ success: false, message: "Bed not found." });
    }
    if (bedRows[0].status !== "available") {
      return res.status(409).json({ success: false, message: "That bed is no longer available." });
    }

    await pool.query(
      `UPDATE ipd_admissions SET ward_id = ?, bed_id = ?, status = 'admitted', admitted_at = NOW() WHERE id = ? AND hospital_id = ?`,
      [bedRows[0].ward_id, bedId, req.params.id, hospitalId]
    );
    await pool.query(`UPDATE beds SET status = 'occupied' WHERE id = ? AND hospital_id = ?`, [
      bedId,
      hospitalId,
    ]);

    const nurseAssignment = await assignNurseForAdmission(pool, hospitalId, req.params.id);

    broadcast(req, "ipd_admissions");
    broadcast(req, "wards_beds");
    res.json({ success: true, nurseAssignment });
  } catch (err) {
    console.error("Allocate bed error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// Discharge — reverses allocate-bed: frees the bed back to 'available' and marks
// the admission done, so it drops off every ward/patient list and stops accruing
// IPD bed charges (Billing Desk's reconciliation only counts status = 'admitted').
app.post("/api/ipd/admissions/:id/discharge", requireRole("nurse", "hospital_admin"), async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const [rows] = await pool.query(
      `SELECT id, bed_id, status FROM ipd_admissions WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Admission not found." });
    }
    if (rows[0].status !== "admitted") {
      return res.status(409).json({ success: false, message: "Only currently admitted patients can be discharged." });
    }

    await pool.query(
      `UPDATE ipd_admissions SET status = 'discharged', discharged_at = NOW(), discharged_by = ?
       WHERE id = ? AND hospital_id = ?`,
      [userId, req.params.id, hospitalId]
    );
    if (rows[0].bed_id) {
      await pool.query(`UPDATE beds SET status = 'available' WHERE id = ? AND hospital_id = ?`, [
        rows[0].bed_id,
        hospitalId,
      ]);
    }

    broadcast(req, "ipd_admissions");
    broadcast(req, "wards_beds");
    res.json({ success: true });
  } catch (err) {
    console.error("Discharge admission error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Doctor orders ----------

app.post("/api/ipd/admissions/:id/orders", requireRole("doctor"), async (req, res) => {
  const { orderType, description } = req.body || {};
  if (!["test", "medicine", "procedure", "nursing_instruction"].includes(orderType) || !description) {
    return res.status(400).json({
      success: false,
      message: "A valid order type and description are required.",
    });
  }
  try {
    await pool.query(
      `INSERT INTO doctor_orders (hospital_id, ipd_admission_id, order_type, description, ordered_by)
       VALUES (?, ?, ?, ?, ?)`,
      [req.session.user.hospitalId, req.params.id, orderType, description, req.session.user.userId]
    );
    broadcast(req, "ipd_admissions");
    res.json({ success: true });
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Medication administration (MAR) ----------

app.post("/api/ipd/admissions/:id/mar", requireRole("nurse"), async (req, res) => {
  const { medicineName, dose, notes, doctorOrderId } = req.body || {};
  if (!medicineName) {
    return res.status(400).json({ success: false, message: "Medicine name is required." });
  }
  try {
    await pool.query(
      `INSERT INTO medication_administration
        (hospital_id, ipd_admission_id, doctor_order_id, medicine_name, dose, administered_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.hospitalId,
        req.params.id,
        doctorOrderId || null,
        medicineName,
        dose || null,
        req.session.user.userId,
        notes || null,
      ]
    );
    broadcast(req, "ipd_admissions");
    res.json({ success: true });
  } catch (err) {
    console.error("Log MAR error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- IPD notes / complication feed ----------

app.post("/api/ipd/admissions/:id/notes", requireRole("doctor", "nurse"), async (req, res) => {
  const { noteType, message } = req.body || {};
  if (!message) {
    return res.status(400).json({ success: false, message: "Note message is required." });
  }
  const finalNoteType = noteType || (req.session.user.role === "doctor" ? "doctor_round" : "general");
  try {
    await pool.query(
      `INSERT INTO ipd_notes (hospital_id, ipd_admission_id, note_type, message, flagged_by)
       VALUES (?, ?, ?, ?, ?)`,
      [req.session.user.hospitalId, req.params.id, finalNoteType, message, req.session.user.userId]
    );
    broadcast(req, "ipd_admissions");
    res.json({ success: true });
  } catch (err) {
    console.error("Create note error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Vitals ----------

app.post("/api/vitals", requireRole("nurse", "hospital_admin"), async (req, res) => {
  const { patientUhid, opdVisitId, ipdAdmissionId, bp, temperature, weight, spo2 } = req.body || {};
  if (!patientUhid || (!opdVisitId && !ipdAdmissionId)) {
    return res.status(400).json({
      success: false,
      message: "Patient and either an OPD visit or IPD admission are required.",
    });
  }
  try {
    await pool.query(
      `INSERT INTO vitals
        (hospital_id, patient_uhid, opd_visit_id, ipd_admission_id, bp, temperature, weight, spo2, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.session.user.hospitalId,
        patientUhid,
        opdVisitId || null,
        ipdAdmissionId || null,
        bp || null,
        temperature || null,
        weight || null,
        spo2 || null,
        req.session.user.userId,
      ]
    );
    broadcast(req, "vitals");
    res.json({ success: true });
  } catch (err) {
    console.error("Log vitals error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/vitals", requireTenantUser, async (req, res) => {
  const { opdVisitId, ipdAdmissionId } = req.query;
  try {
    const { hospitalId } = req.session.user;
    let query = `SELECT id, bp, temperature, weight, spo2, recorded_by, recorded_at FROM vitals WHERE hospital_id = ? AND `;
    const params = [hospitalId];

    if (opdVisitId) {
      query += "opd_visit_id = ?";
      params.push(opdVisitId);
    } else if (ipdAdmissionId) {
      query += "ipd_admission_id = ?";
      params.push(ipdAdmissionId);
    } else {
      return res.status(400).json({ success: false, message: "opdVisitId or ipdAdmissionId is required." });
    }
    query += " ORDER BY recorded_at DESC";

    const [rows] = await pool.query(query, params);
    res.json({ success: true, vitals: rows });
  } catch (err) {
    console.error("Get vitals error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.post("/api/hospitals", requireSuperadmin, async (req, res) => {
  const {
    name,
    licenseNumber,
    pan,
    hfrId,
    address,
    city,
    state,
    pincode,
    bedCount,
    opdVolume,
    adminName,
    adminEmail,
    adminUserId: customAdminUserId,
    adminPassword: customAdminPassword,
    modules,
    dpdpConsent,
  } = req.body || {};

  if (!name || !adminEmail || !dpdpConsent) {
    return res.status(400).json({
      success: false,
      message: "Facility name, client admin email, and DPDP consent are required.",
    });
  }

  if (customAdminUserId && !/^[A-Za-z0-9_-]+$/.test(customAdminUserId)) {
    return res.status(400).json({
      success: false,
      message: "Admin User ID can only contain letters, numbers, hyphens, and underscores.",
    });
  }

  if (customAdminPassword && customAdminPassword.length < 6) {
    return res.status(400).json({
      success: false,
      message: "Admin password must be at least 6 characters.",
    });
  }

  try {
    const [existing] = await pool.query(
      `SELECT id FROM hospitals
       WHERE LOWER(name) = LOWER(?) AND LOWER(COALESCE(city, '')) = LOWER(COALESCE(?, ''))
       LIMIT 1`,
      [name, city || ""]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A hospital named "${name}" is already registered in ${city || "the same location"}. Use a different name or location.`,
      });
    }

    if (customAdminUserId) {
      const [takenRows] = await pool.query("SELECT user_id FROM user_directory WHERE user_id = ?", [
        customAdminUserId,
      ]);
      if (takenRows.length > 0) {
        return res.status(409).json({
          success: false,
          message: `Admin User ID "${customAdminUserId}" is already in use. Please choose a different one.`,
        });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO hospitals
        (name, license_number, pan, hfr_id, address, city, state, pincode, bed_count, opd_volume,
         admin_name, admin_email, modules, dpdp_consent, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        name,
        licenseNumber || null,
        pan || null,
        hfrId || null,
        address || null,
        city || null,
        state || null,
        pincode || null,
        bedCount || null,
        opdVolume || null,
        adminName || null,
        adminEmail,
        JSON.stringify(modules || []),
        !!dpdpConsent,
        req.session.user.userId,
      ]
    );

    const hospitalId = result.insertId;

    let shortCode = buildShortCode(name);
    let suffix = 1;
    while (true) {
      const [codeRows] = await pool.query("SELECT id FROM hospitals WHERE short_code = ?", [shortCode]);
      if (codeRows.length === 0) break;
      suffix += 1;
      shortCode = `${buildShortCode(name)}${suffix}`;
    }

    const adminUserId = customAdminUserId || generateStaffUserId(ROLE_PREFIXES.hospital_admin, shortCode);
    const adminPassword = customAdminPassword || generateTempPassword();
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    await pool.query(
      `INSERT INTO users (hospital_id, user_id, password_hash, full_name, role)
       VALUES (?, ?, ?, ?, 'hospital_admin')`,
      [hospitalId, adminUserId, passwordHash, adminName || null]
    );

    await pool.query("INSERT INTO user_directory (user_id, hospital_id) VALUES (?, ?)", [
      adminUserId,
      hospitalId,
    ]);

    await pool.query("UPDATE hospitals SET short_code = ?, admin_user_id = ? WHERE id = ?", [
      shortCode,
      adminUserId,
      hospitalId,
    ]);

    await seedTestCatalog(pool, hospitalId);
    await seedBillingTariff(pool, hospitalId);

    console.log(`[hospital] "${name}" registered (hospital_id ${hospitalId}). Admin login: ${adminUserId}`);

    broadcastGlobal("hospitals", { action: "create", hospitalId });
    res.json({
      success: true,
      hospitalId,
      shortCode,
      admin: { userId: adminUserId, password: adminPassword },
    });
  } catch (err) {
    console.error("Create hospital error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.delete("/api/hospitals/:id", requireSuperadmin, async (req, res) => {
  try {
    const hospitalId = req.params.id;
    const [rows] = await pool.query("SELECT name FROM hospitals WHERE id = ? LIMIT 1", [hospitalId]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Hospital not found." });
    }

    // Every hospital-scoped table, deleted by hospital_id now that all tenants share one database.
    const scopedTables = [
      "bill_payments",
      "bill_items",
      "bills",
      "patient_charges",
      "billing_tariff",
      "blood_billing",
      "blood_requests",
      "blood_inventory_units",
      "blood_patient_donations",
      "blood_donors",
      "doctor_nurse_teams",
      "nurse_shift_roster",
      "medication_administration",
      "doctor_orders",
      "ipd_notes",
      "vitals",
      "lab_orders",
      "consultations",
      "ipd_admissions",
      "opd_visits",
      "beds",
      "wards",
      "doctor_schedules",
      "doctor_calendar_availability",
      "test_catalog",
      "patients",
      "users",
      "departments",
    ];
    for (const table of scopedTables) {
      await pool.query(`DELETE FROM \`${table}\` WHERE hospital_id = ?`, [hospitalId]);
    }

    await pool.query("DELETE FROM user_directory WHERE hospital_id = ?", [hospitalId]);
    await pool.query("DELETE FROM hospitals WHERE id = ?", [hospitalId]);

    broadcastGlobal("hospitals", { action: "delete", hospitalId });
    res.json({ success: true });
  } catch (err) {
    console.error("Delete hospital error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Blood Bank ----------

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const BLOOD_RATES = {
  "Whole Blood": 1200,
  "Packed RBC": 1500,
  "Fresh Frozen Plasma": 800,
  Platelets: 2000,
  Cryoprecipitate: 1000,
};

function bloodExpiryFor(component, collectedAt) {
  const days = component === "Platelets" ? 5 : 35;
  return new Date(collectedAt.getTime() + days * 86400000);
}

function requireBloodBankStaff(req, res, next) {
  const role = req.session.user && req.session.user.role;
  if (role === "blood_bank_staff" || role === "hospital_admin") return next();
  return res.status(401).json({ success: false, message: "Blood bank staff session required." });
}

// Standard donor screening thresholds — mirrors the client-side pre-check so a request
// can't be forced through even if the browser check is bypassed.
function checkDonorEligibility({ age, weight, hb, systolic, diastolic, pulse, temperature, lastDonationDate, flags }) {
  const reasons = [];
  if (age !== null && (age < 18 || age > 65)) reasons.push(`Age ${age} is outside the 18–65 donation range`);
  if (weight < 45) reasons.push(`Weight ${weight}kg is below the 45kg minimum`);
  if (hb < 12.5) reasons.push(`Haemoglobin ${hb} g/dL is below the 12.5 g/dL minimum`);
  if (systolic < 100 || systolic > 180) reasons.push(`Systolic BP ${systolic} is outside the safe range (100–180)`);
  if (diastolic < 60 || diastolic > 100) reasons.push(`Diastolic BP ${diastolic} is outside the safe range (60–100)`);
  if (pulse < 50 || pulse > 100) reasons.push(`Pulse ${pulse} bpm is outside the normal range (50–100)`);
  if (temperature > 37.5) reasons.push(`Temperature ${temperature}°C indicates fever`);
  if (lastDonationDate) {
    const daysSince = (Date.now() - new Date(lastDonationDate).getTime()) / 86400000;
    if (daysSince < 90) reasons.push(`Last donation was ${Math.floor(daysSince)} day(s) ago — 90-day gap required`);
  }
  const FLAG_LABELS = {
    fever: "Currently has fever / recent infection",
    surgeryRecent: "Surgery or major dental work in the last 6 months",
    tattoo: "Tattoo or piercing in the last 12 months",
    pregnancy: "Currently pregnant or breastfeeding",
    medication: "On blood-thinners or other disqualifying medication",
    chronicIllness: "Diagnosed chronic illness affecting donation",
  };
  Object.keys(flags || {}).forEach((k) => {
    if (flags[k]) reasons.push(FLAG_LABELS[k] || k);
  });
  return { eligible: reasons.length === 0, reasons };
}

// Blood bank staff can't call the admin-only /api/hospital/staff — this gives them
// just enough (their own team's names/IDs) to populate the "assign to" dropdown.
app.get("/api/bloodbank/staff", requireBloodBankStaff, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT user_id, full_name FROM users WHERE hospital_id = ? AND role = 'blood_bank_staff' ORDER BY full_name ASC`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, staff: rows });
  } catch (err) {
    console.error("List blood bank staff error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/bloodbank/requests", requireBloodBankStaff, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM blood_requests WHERE hospital_id = ? ORDER BY created_at DESC`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, requests: rows });
  } catch (err) {
    console.error("List blood requests error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/requests", requireBloodBankStaff, async (req, res) => {
  const { patientUhid, patientName, age, sex, bloodGroup, component, unitsRequired, priority, wardLocation, refPhysician } =
    req.body || {};
  if (!patientName || !bloodGroup || !component || !unitsRequired) {
    return res.status(400).json({ success: false, message: "Patient name, blood group, component, and units are required." });
  }
  try {
    const { hospitalId, userId } = req.session.user;
    const requestCode = "BB-" + (4000 + Math.floor(Math.random() * 900));
    const [result] = await pool.query(
      `INSERT INTO blood_requests
        (hospital_id, request_code, patient_uhid, patient_name, age, sex, blood_group, component, units_required,
         priority, ward_location, ref_physician, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?)`,
      [
        hospitalId,
        requestCode,
        patientUhid || null,
        patientName,
        age || null,
        sex || null,
        bloodGroup,
        component,
        unitsRequired,
        priority || "Routine",
        wardLocation || null,
        refPhysician || null,
        userId,
      ]
    );
    broadcast(req, "bloodbank_requests", { action: "create" });
    res.json({ success: true, id: result.insertId, requestCode });
  } catch (err) {
    console.error("Create blood request error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.patch("/api/bloodbank/requests/:id/assign", requireBloodBankStaff, async (req, res) => {
  const { staffId } = req.body || {};
  try {
    const { hospitalId } = req.session.user;
    const assignedId = staffId && staffId !== "Unassigned" ? staffId : null;
    const [[reqRow]] = await pool.query(
      `SELECT status FROM blood_requests WHERE id = ? AND hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (!reqRow) return res.status(404).json({ success: false, message: "Request not found." });

    const nextStatus = assignedId && reqRow.status === "requested" ? "crossmatch" : reqRow.status;
    await pool.query(`UPDATE blood_requests SET assigned_staff_id = ?, status = ? WHERE id = ? AND hospital_id = ?`, [
      assignedId,
      nextStatus,
      req.params.id,
      hospitalId,
    ]);
    broadcast(req, "bloodbank_requests");
    res.json({ success: true });
  } catch (err) {
    console.error("Assign blood request error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.patch("/api/bloodbank/requests/:id/crossmatch", requireBloodBankStaff, async (req, res) => {
  const { field, value } = req.body || {};
  const columns = { sample: "crossmatch_sample", abo: "crossmatch_abo", screen: "crossmatch_screen" };
  if (!columns[field]) return res.status(400).json({ success: false, message: "Invalid crossmatch field." });
  try {
    await pool.query(`UPDATE blood_requests SET ${columns[field]} = ? WHERE id = ? AND hospital_id = ?`, [
      !!value,
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "bloodbank_requests");
    res.json({ success: true });
  } catch (err) {
    console.error("Update crossmatch error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.patch("/api/bloodbank/requests/:id/notes", requireBloodBankStaff, async (req, res) => {
  const { notes } = req.body || {};
  try {
    await pool.query(`UPDATE blood_requests SET notes = ? WHERE id = ? AND hospital_id = ?`, [
      notes || "",
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "bloodbank_requests");
    res.json({ success: true });
  } catch (err) {
    console.error("Save blood request notes error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/requests/:id/issue", requireBloodBankStaff, async (req, res) => {
  try {
    const { hospitalId, userId } = req.session.user;
    const [[r]] = await pool.query(`SELECT * FROM blood_requests WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.id,
      hospitalId,
    ]);
    if (!r) return res.status(404).json({ success: false, message: "Request not found." });
    if (!(r.crossmatch_sample && r.crossmatch_abo && r.crossmatch_screen)) {
      return res.status(400).json({ success: false, message: "Complete the crossmatch checklist before issuing." });
    }
    if (r.status === "issued") {
      return res.status(409).json({ success: false, message: "This request has already been issued." });
    }

    const [units] = await pool.query(
      `SELECT id, unit_code FROM blood_inventory_units
       WHERE hospital_id = ? AND blood_group = ? AND component = ? AND status = 'available'
       ORDER BY expiry_at ASC LIMIT ?`,
      [hospitalId, r.blood_group, r.component, r.units_required]
    );
    if (units.length < r.units_required) {
      return res.status(409).json({
        success: false,
        message: `Only ${units.length} unit(s) of ${r.blood_group} ${r.component} in stock — cannot issue ${r.units_required}.`,
      });
    }

    const unitIds = units.map((u) => u.id);
    await pool.query(`UPDATE blood_inventory_units SET status = 'issued', issued_to_request_id = ? WHERE id IN (?)`, [
      req.params.id,
      unitIds,
    ]);

    const issuedNote = `Issued ${r.units_required} unit(s): ${units.map((u) => u.unit_code).join(", ")}`;
    await pool.query(
      `UPDATE blood_requests SET status = 'issued', issued_at = NOW(), notes = CONCAT(IF(notes IS NULL OR notes = '', '', CONCAT(notes, '\n')), ?) WHERE id = ? AND hospital_id = ?`,
      [issuedNote, req.params.id, hospitalId]
    );

    const amount = (BLOOD_RATES[r.component] || 1000) * r.units_required;
    await pool.query(
      `INSERT INTO blood_billing (hospital_id, request_id, patient_uhid, patient_name, component, units, amount, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [hospitalId, req.params.id, r.patient_uhid, r.patient_name, r.component, r.units_required, amount, userId]
    );

    broadcast(req, "bloodbank_requests");
    broadcast(req, "bloodbank_inventory");
    broadcast(req, "bloodbank_billing");
    res.json({ success: true, unitsIssued: units.map((u) => u.unit_code), amount });
  } catch (err) {
    console.error("Issue blood units error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/requests/:id/reject", requireBloodBankStaff, async (req, res) => {
  try {
    await pool.query(`UPDATE blood_requests SET status = 'rejected' WHERE id = ? AND hospital_id = ?`, [
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "bloodbank_requests");
    res.json({ success: true });
  } catch (err) {
    console.error("Reject blood request error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/bloodbank/inventory", requireBloodBankStaff, async (req, res) => {
  try {
    const [units] = await pool.query(
      `SELECT id, unit_code, blood_group, component, collected_at, expiry_at, status
       FROM blood_inventory_units WHERE hospital_id = ? AND status = 'available' ORDER BY expiry_at ASC`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, units });
  } catch (err) {
    console.error("Get blood inventory error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/bloodbank/donors", requireBloodBankStaff, async (req, res) => {
  try {
    const [donors] = await pool.query(`SELECT * FROM blood_donors WHERE hospital_id = ? ORDER BY full_name ASC`, [
      req.session.user.hospitalId,
    ]);
    res.json({ success: true, donors });
  } catch (err) {
    console.error("List blood donors error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/donors", requireBloodBankStaff, async (req, res) => {
  const { name, bloodGroup, phone, lastDonationDate } = req.body || {};
  if (!name || !bloodGroup) {
    return res.status(400).json({ success: false, message: "Donor name and blood group are required." });
  }
  try {
    const { hospitalId, userId } = req.session.user;
    const [result] = await pool.query(
      `INSERT INTO blood_donors (hospital_id, full_name, blood_group, phone, last_donation_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [hospitalId, name, bloodGroup, phone || null, lastDonationDate || null, userId]
    );
    broadcast(req, "bloodbank_donors");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Add blood donor error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/donations", requireBloodBankStaff, async (req, res) => {
  const { donorId, component, units } = req.body || {};
  const unitCount = parseInt(units, 10) || 1;
  if (!donorId || !component) {
    return res.status(400).json({ success: false, message: "Donor and component are required." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [[donor]] = await pool.query(`SELECT * FROM blood_donors WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      donorId,
      hospitalId,
    ]);
    if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

    const now = new Date();
    const expiry = bloodExpiryFor(component, now);
    const rows = [];
    for (let i = 0; i < unitCount; i++) {
      const unitCode = "BU-" + (1000 + Math.floor(Math.random() * 9000));
      rows.push([hospitalId, unitCode, donor.blood_group, component, donorId, now, expiry, "available"]);
    }
    await pool.query(
      `INSERT INTO blood_inventory_units (hospital_id, unit_code, blood_group, component, donor_id, collected_at, expiry_at, status) VALUES ?`,
      [rows]
    );

    await pool.query(
      `UPDATE blood_donors SET last_donation_date = CURDATE(), total_donations = total_donations + ? WHERE id = ?`,
      [unitCount, donorId]
    );

    broadcast(req, "bloodbank_inventory");
    broadcast(req, "bloodbank_donors");
    res.json({ success: true, unitsAdded: unitCount });
  } catch (err) {
    console.error("Record blood donation error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/bloodbank/patient-donations", requireBloodBankStaff, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM blood_patient_donations WHERE hospital_id = ? ORDER BY created_at DESC LIMIT 30`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, donations: rows });
  } catch (err) {
    console.error("List patient donations error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/patient-donations/check-eligibility", requireBloodBankStaff, async (req, res) => {
  const { patientUhid, weight, hb, systolic, diastolic, pulse, temperature, flags } = req.body || {};
  try {
    const { hospitalId } = req.session.user;
    let age = null;
    let lastDonationDate = null;
    if (patientUhid) {
      const [[patient]] = await pool.query(`SELECT dob FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`, [
        patientUhid,
        hospitalId,
      ]);
      if (patient && patient.dob) {
        age = Math.floor((Date.now() - new Date(patient.dob).getTime()) / (365.25 * 86400000));
      }
      const [[lastDonation]] = await pool.query(
        `SELECT created_at FROM blood_patient_donations WHERE patient_uhid = ? AND hospital_id = ? ORDER BY created_at DESC LIMIT 1`,
        [patientUhid, hospitalId]
      );
      if (lastDonation) lastDonationDate = lastDonation.created_at;
    }

    const result = checkDonorEligibility({
      age,
      weight: parseFloat(weight) || 0,
      hb: parseFloat(hb) || 0,
      systolic: parseInt(systolic, 10) || 0,
      diastolic: parseInt(diastolic, 10) || 0,
      pulse: parseInt(pulse, 10) || 0,
      temperature: parseFloat(temperature) || 0,
      lastDonationDate,
      flags,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Check donor eligibility error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/patient-donations", requireBloodBankStaff, async (req, res) => {
  const {
    patientUhid,
    donorName,
    bloodGroup,
    component,
    units,
    weight,
    hb,
    systolic,
    diastolic,
    pulse,
    temperature,
    flags,
    consent,
  } = req.body || {};

  if (!patientUhid || !donorName || !bloodGroup || !component || !consent) {
    return res.status(400).json({
      success: false,
      message: "Patient, blood group, component, and consent confirmation are required.",
    });
  }

  try {
    const { hospitalId, userId } = req.session.user;

    let age = null;
    const [[patient]] = await pool.query(`SELECT dob FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`, [
      patientUhid,
      hospitalId,
    ]);
    if (patient && patient.dob) {
      age = Math.floor((Date.now() - new Date(patient.dob).getTime()) / (365.25 * 86400000));
    }
    const [[lastDonation]] = await pool.query(
      `SELECT created_at FROM blood_patient_donations WHERE patient_uhid = ? AND hospital_id = ? ORDER BY created_at DESC LIMIT 1`,
      [patientUhid, hospitalId]
    );

    const eligibility = checkDonorEligibility({
      age,
      weight: parseFloat(weight) || 0,
      hb: parseFloat(hb) || 0,
      systolic: parseInt(systolic, 10) || 0,
      diastolic: parseInt(diastolic, 10) || 0,
      pulse: parseInt(pulse, 10) || 0,
      temperature: parseFloat(temperature) || 0,
      lastDonationDate: lastDonation ? lastDonation.created_at : null,
      flags,
    });

    if (!eligibility.eligible) {
      return res.status(400).json({
        success: false,
        message: "Patient does not meet donation eligibility criteria.",
        reasons: eligibility.reasons,
      });
    }

    const unitCount = parseInt(units, 10) || 1;
    await pool.query(
      `INSERT INTO blood_patient_donations
        (hospital_id, patient_uhid, donor_name, blood_group, component, units, weight, hb, systolic, diastolic,
         pulse, temperature, flags, eligible, ineligible_reasons, consent, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NULL, TRUE, ?)`,
      [
        hospitalId,
        patientUhid,
        donorName,
        bloodGroup,
        component,
        unitCount,
        weight || null,
        hb || null,
        systolic || null,
        diastolic || null,
        pulse || null,
        temperature || null,
        JSON.stringify(flags || {}),
        userId,
      ]
    );

    // Screening-confirmed blood group is a reliable source — persist it to the patient record.
    await pool.query(`UPDATE patients SET blood_group = ? WHERE uhid = ? AND hospital_id = ?`, [
      bloodGroup,
      patientUhid,
      hospitalId,
    ]);

    const now = new Date();
    const expiry = bloodExpiryFor(component, now);
    const rows = [];
    for (let i = 0; i < unitCount; i++) {
      const unitCode = "BU-" + (1000 + Math.floor(Math.random() * 9000));
      rows.push([hospitalId, unitCode, bloodGroup, component, null, now, expiry, "available"]);
    }
    await pool.query(
      `INSERT INTO blood_inventory_units (hospital_id, unit_code, blood_group, component, donor_id, collected_at, expiry_at, status) VALUES ?`,
      [rows]
    );

    broadcast(req, "bloodbank_inventory");
    broadcast(req, "patients");
    res.json({ success: true, unitsAdded: unitCount });
  } catch (err) {
    console.error("Record patient donation error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/bloodbank/billing", requireBloodBankStaff, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM blood_billing WHERE hospital_id = ? ORDER BY created_at DESC`, [
      req.session.user.hospitalId,
    ]);
    res.json({ success: true, billing: rows });
  } catch (err) {
    console.error("List blood billing error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/bloodbank/billing/:id/pay", requireBloodBankStaff, async (req, res) => {
  const { paymentType } = req.body || {};
  try {
    await pool.query(
      `UPDATE blood_billing SET status = 'paid', payment_type = ?, paid_at = NOW() WHERE id = ? AND hospital_id = ?`,
      [paymentType || "Cash", req.params.id, req.session.user.hospitalId]
    );
    broadcast(req, "bloodbank_billing");
    res.json({ success: true });
  } catch (err) {
    console.error("Mark blood billing paid error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Real online payment for a blood bank bill — same pattern as the pharmacy
// invoice pair above.
app.post("/api/bloodbank/billing/:id/create-order", requireBloodBankStaff, async (req, res) => {
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ success: false, message: "Online payment isn't configured on this server yet." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [rows] = await pool.query(`SELECT amount, status FROM blood_billing WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.id,
      hospitalId,
    ]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: "Billing entry not found." });
    if (rows[0].status === "paid") return res.status(409).json({ success: false, message: "This bill is already paid." });

    const order = await createPaymentOrder(req, hospitalId, "blood_billing", req.params.id, rows[0].amount);
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error("Create blood billing order error:", err.message);
    res.status(500).json({ success: false, message: err.message || "Server error. Please try again." });
  }
});

app.post("/api/bloodbank/billing/:id/verify-payment", requireBloodBankStaff, async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: "Incomplete payment response." });
  }
  try {
    const { hospitalId } = req.session.user;
    const result = await verifyPaymentOrder(hospitalId, "blood_billing", req.params.id, razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

    await pool.query(`UPDATE blood_billing SET status = 'paid', payment_type = 'Razorpay', paid_at = NOW() WHERE id = ? AND hospital_id = ?`, [
      req.params.id,
      hospitalId,
    ]);
    broadcast(req, "bloodbank_billing");
    res.json({ success: true });
  } catch (err) {
    console.error("Verify blood billing payment error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- Billing Desk ----------

function requireBillingStaff(req, res, next) {
  const role = req.session.user && req.session.user.role;
  if (role === "billing_staff" || role === "hospital_admin") return next();
  return res.status(401).json({ success: false, message: "Billing staff session required." });
}

function computeBillTotals({ items, discountPct, taxPct, paidAmount }) {
  const subtotal = items.reduce((s, it) => s + (parseFloat(it.qty) || 0) * (parseFloat(it.rate) || 0), 0);
  const discountAmount = subtotal * ((parseFloat(discountPct) || 0) / 100);
  const taxAmount = (subtotal - discountAmount) * ((parseFloat(taxPct) || 0) / 100);
  const total = subtotal - discountAmount + taxAmount;
  const balance = Math.max(0, +(total - paidAmount).toFixed(2));
  let status = "Pending";
  if (paidAmount >= total && total > 0) status = "Paid";
  else if (paidAmount > 0) status = "Partial";
  return { subtotal, discountAmount, taxAmount, total, balance, status };
}

app.get("/api/billing/bills", requireBillingStaff, async (req, res) => {
  try {
    const [bills] = await pool.query(
      `SELECT b.*, u.full_name AS doctor_name FROM bills b
       LEFT JOIN users u ON u.user_id = b.doctor_user_id
       WHERE b.hospital_id = ? ORDER BY b.created_at DESC`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, bills });
  } catch (err) {
    console.error("List bills error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/billing/bills/:id", requireBillingStaff, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    const [[bill]] = await pool.query(
      `SELECT b.*, u.full_name AS doctor_name FROM bills b
       LEFT JOIN users u ON u.user_id = b.doctor_user_id
       WHERE b.id = ? AND b.hospital_id = ? LIMIT 1`,
      [req.params.id, hospitalId]
    );
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });

    const [items] = await pool.query(`SELECT * FROM bill_items WHERE bill_id = ? AND hospital_id = ?`, [
      req.params.id,
      hospitalId,
    ]);
    const [payments] = await pool.query(
      `SELECT * FROM bill_payments WHERE bill_id = ? AND hospital_id = ? ORDER BY paid_at ASC`,
      [req.params.id, hospitalId]
    );
    res.json({ success: true, bill, items, payments });
  } catch (err) {
    console.error("Get bill error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/billing/bills", requireBillingStaff, async (req, res) => {
  const {
    patientUhid, patientName, abhaId, department, doctorUserId, billDate,
    items, discountPct, taxPct, receivedAmount, paymentMode,
    isInsurance, payerName, policyNo,
  } = req.body || {};

  if (!patientName || !department || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Patient name, department, and at least one line item are required." });
  }
  for (const it of items) {
    if (!it.description) return res.status(400).json({ success: false, message: "Every line item needs a description." });
  }

  try {
    const { hospitalId, userId } = req.session.user;
    const paid = parseFloat(receivedAmount) || 0;
    const totals = computeBillTotals({ items, discountPct, taxPct, paidAmount: paid });
    const billNo = "CN/" + new Date().getFullYear() + "/" + (1000 + Math.floor(Math.random() * 8999));

    const [result] = await pool.query(
      `INSERT INTO bills
        (hospital_id, bill_no, patient_uhid, patient_name, abha_id, department, doctor_user_id, bill_date,
         subtotal, discount_pct, discount_amount, tax_pct, tax_amount, total_amount, paid_amount, balance_amount,
         status, is_insurance, payer_name, policy_no, claim_status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId, billNo, patientUhid || null, patientName, abhaId || null, department, doctorUserId || null,
        billDate || new Date().toISOString().slice(0, 10),
        totals.subtotal, discountPct || 0, totals.discountAmount, taxPct || 0, totals.taxAmount, totals.total,
        paid, totals.balance, totals.status,
        !!isInsurance, isInsurance ? payerName || null : null, isInsurance ? policyNo || null : null,
        isInsurance ? "Submitted" : null, userId,
      ]
    );
    const billId = result.insertId;

    const itemRows = items.map((it) => [
      hospitalId, billId, it.description, it.department || department,
      parseFloat(it.qty) || 1, parseFloat(it.rate) || 0, (parseFloat(it.qty) || 1) * (parseFloat(it.rate) || 0),
    ]);
    await pool.query(
      `INSERT INTO bill_items (hospital_id, bill_id, description, department, qty, rate, amount) VALUES ?`,
      [itemRows]
    );

    if (paid > 0) {
      await pool.query(
        `INSERT INTO bill_payments (hospital_id, bill_id, amount, mode, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
        [hospitalId, billId, paid, paymentMode || "Cash", "RCPT-" + (1000 + Math.floor(Math.random() * 8999)), userId]
      );
    }

    broadcast(req, "billing_bills");
    if (paid > 0) broadcast(req, "billing_payments");
    res.json({ success: true, id: billId, billNo, total: totals.total, balance: totals.balance, status: totals.status });
  } catch (err) {
    console.error("Create bill error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/billing/bills/:id/payments", requireBillingStaff, async (req, res) => {
  const { amount, mode, reference } = req.body || {};
  const amt = parseFloat(amount) || 0;
  if (amt <= 0) return res.status(400).json({ success: false, message: "Enter a valid payment amount." });

  try {
    const { hospitalId, userId } = req.session.user;
    const [[bill]] = await pool.query(`SELECT * FROM bills WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.id,
      hospitalId,
    ]);
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });
    if (bill.status === "Paid") return res.status(409).json({ success: false, message: "This bill is already fully paid." });

    const newPaid = parseFloat(bill.paid_amount) + amt;
    const newBalance = Math.max(0, +(parseFloat(bill.total_amount) - newPaid).toFixed(2));
    const newStatus = newPaid >= parseFloat(bill.total_amount) ? "Paid" : "Partial";

    await pool.query(
      `INSERT INTO bill_payments (hospital_id, bill_id, amount, mode, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [hospitalId, req.params.id, amt, mode || "Cash", reference || "RCPT-" + (1000 + Math.floor(Math.random() * 8999)), userId]
    );
    await pool.query(`UPDATE bills SET paid_amount = ?, balance_amount = ?, status = ? WHERE id = ? AND hospital_id = ?`, [
      newPaid, newBalance, newStatus, req.params.id, hospitalId,
    ]);

    broadcast(req, "billing_bills");
    broadcast(req, "billing_payments");
    res.json({ success: true, paidAmount: newPaid, balance: newBalance, status: newStatus });
  } catch (err) {
    console.error("Record bill payment error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// Real online payment for a billing desk bill — same shape as the manual
// /payments route above (supports paying less than the full balance), just
// gated on a verified Razorpay signature instead of staff self-reporting the
// amount and mode by hand.
app.post("/api/billing/bills/:id/create-order", requireBillingStaff, async (req, res) => {
  if (!razorpay.isConfigured()) {
    return res.status(503).json({ success: false, message: "Online payment isn't configured on this server yet." });
  }
  try {
    const { hospitalId } = req.session.user;
    const [[bill]] = await pool.query(`SELECT balance_amount, status FROM bills WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.id,
      hospitalId,
    ]);
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });
    if (bill.status === "Paid") return res.status(409).json({ success: false, message: "This bill is already fully paid." });

    const balance = parseFloat(bill.balance_amount);
    const requested = req.body && req.body.amount !== undefined ? Number(req.body.amount) : balance;
    if (!Number.isFinite(requested) || requested <= 0 || requested > balance + 0.01) {
      return res.status(400).json({ success: false, message: `Enter an amount between ₹0.01 and the outstanding balance (₹${balance.toFixed(2)}).` });
    }

    const order = await createPaymentOrder(req, hospitalId, "bill", req.params.id, requested);
    res.json({ success: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error("Create bill order error:", err.message);
    res.status(500).json({ success: false, message: err.message || "Server error. Please try again." });
  }
});

app.post("/api/billing/bills/:id/verify-payment", requireBillingStaff, async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ success: false, message: "Incomplete payment response." });
  }
  try {
    const { hospitalId, userId } = req.session.user;
    const result = await verifyPaymentOrder(hospitalId, "bill", req.params.id, razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message });

    const [[bill]] = await pool.query(`SELECT * FROM bills WHERE id = ? AND hospital_id = ? LIMIT 1`, [req.params.id, hospitalId]);
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });

    const amt = parseFloat(result.amount);
    const newPaid = parseFloat(bill.paid_amount) + amt;
    const newBalance = Math.max(0, +(parseFloat(bill.total_amount) - newPaid).toFixed(2));
    const newStatus = newPaid >= parseFloat(bill.total_amount) ? "Paid" : "Partial";

    await pool.query(
      `INSERT INTO bill_payments (hospital_id, bill_id, amount, mode, reference, created_by) VALUES (?, ?, ?, 'Razorpay', ?, ?)`,
      [hospitalId, req.params.id, amt, razorpayPaymentId, userId]
    );
    await pool.query(`UPDATE bills SET paid_amount = ?, balance_amount = ?, status = ? WHERE id = ? AND hospital_id = ?`, [
      newPaid,
      newBalance,
      newStatus,
      req.params.id,
      hospitalId,
    ]);

    broadcast(req, "billing_bills");
    broadcast(req, "billing_payments");
    res.json({ success: true, paidAmount: newPaid, balance: newBalance, status: newStatus });
  } catch (err) {
    console.error("Verify bill payment error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

app.get("/api/billing/payments", requireBillingStaff, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, b.bill_no, b.patient_name FROM bill_payments p
       JOIN bills b ON b.id = p.bill_id
       WHERE p.hospital_id = ? ORDER BY p.paid_at DESC`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, payments: rows });
  } catch (err) {
    console.error("List payments error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.patch("/api/billing/bills/:id/claim", requireBillingStaff, async (req, res) => {
  const { claimStatus, approvedAmount } = req.body || {};
  const valid = ["Submitted", "Approved", "Rejected", "Settled"];
  if (!valid.includes(claimStatus)) {
    return res.status(400).json({ success: false, message: "Invalid claim status." });
  }
  try {
    await pool.query(
      `UPDATE bills SET claim_status = ?, approved_amount = ? WHERE id = ? AND hospital_id = ? AND is_insurance = TRUE`,
      [claimStatus, approvedAmount === undefined || approvedAmount === null || approvedAmount === "" ? null : approvedAmount, req.params.id, req.session.user.hospitalId]
    );
    broadcast(req, "billing_bills");
    res.json({ success: true });
  } catch (err) {
    console.error("Update claim status error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/billing/tariff", requireBillingStaff, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM billing_tariff WHERE hospital_id = ? ORDER BY department, charge_head`, [
      req.session.user.hospitalId,
    ]);
    res.json({ success: true, tariff: rows });
  } catch (err) {
    console.error("List tariff error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/billing/tariff", requireBillingStaff, async (req, res) => {
  const { chargeHead, department, defaultRate } = req.body || {};
  if (!chargeHead || !department) {
    return res.status(400).json({ success: false, message: "Charge head and department are required." });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO billing_tariff (hospital_id, charge_head, department, default_rate) VALUES (?, ?, ?, ?)`,
      [req.session.user.hospitalId, chargeHead, department, parseFloat(defaultRate) || 0]
    );
    broadcast(req, "billing_tariff");
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error("Add tariff error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.put("/api/billing/tariff/:id", requireBillingStaff, async (req, res) => {
  const { chargeHead, department, defaultRate } = req.body || {};
  if (!chargeHead || !department) {
    return res.status(400).json({ success: false, message: "Charge head and department are required." });
  }
  try {
    const [result] = await pool.query(
      `UPDATE billing_tariff SET charge_head = ?, department = ?, default_rate = ? WHERE id = ? AND hospital_id = ?`,
      [chargeHead, department, parseFloat(defaultRate) || 0, req.params.id, req.session.user.hospitalId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Tariff item not found." });
    broadcast(req, "billing_tariff");
    res.json({ success: true });
  } catch (err) {
    console.error("Update tariff error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.delete("/api/billing/tariff/:id", requireBillingStaff, async (req, res) => {
  try {
    await pool.query(`DELETE FROM billing_tariff WHERE id = ? AND hospital_id = ?`, [
      req.params.id,
      req.session.user.hospitalId,
    ]);
    broadcast(req, "billing_tariff");
    res.json({ success: true });
  } catch (err) {
    console.error("Delete tariff error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- Billing Desk: live per-patient ledger ----------
// Charges are event-sourced (not typed in manually): reconcilePatientCharges() derives
// them from real registrations/visits/lab orders/admissions and INSERT IGNOREs against a
// unique (hospital_id, source_type, source_id) key, so re-running it never double-charges
// the same event — it only ever adds rows for things that happened since the last check.

async function tariffRate(hospitalId, chargeHead, fallback) {
  const [[row]] = await pool.query(
    `SELECT default_rate FROM billing_tariff WHERE hospital_id = ? AND charge_head = ? LIMIT 1`,
    [hospitalId, chargeHead]
  );
  return row ? parseFloat(row.default_rate) : fallback;
}

async function reconcilePatientCharges(hospitalId) {
  const regRate = await tariffRate(hospitalId, "Registration Fee", 100);
  await pool.query(
    `INSERT IGNORE INTO patient_charges (hospital_id, patient_uhid, source_type, source_id, description, department, rate)
     SELECT ?, uhid, 'registration', id, 'Registration Fee', 'OPD', ?
     FROM patients WHERE hospital_id = ? AND uhid IS NOT NULL`,
    [hospitalId, regRate, hospitalId]
  );

  const consultRate = await tariffRate(hospitalId, "Consultation Fee", 600);
  await pool.query(
    `INSERT IGNORE INTO patient_charges (hospital_id, patient_uhid, source_type, source_id, description, department, rate)
     SELECT hospital_id, patient_uhid, 'opd_visit', id, 'Consultation Fee', 'OPD', ?
     FROM opd_visits WHERE hospital_id = ?`,
    [consultRate, hospitalId]
  );

  await pool.query(
    `INSERT IGNORE INTO patient_charges (hospital_id, patient_uhid, source_type, source_id, description, department, rate)
     SELECT lo.hospital_id, lo.patient_uhid, 'lab_order', lo.id, tc.name, tc.department, tc.price
     FROM lab_orders lo JOIN test_catalog tc ON tc.id = lo.test_id
     WHERE lo.hospital_id = ?`,
    [hospitalId]
  );

  const icuRate = await tariffRate(hospitalId, "Bed Charges (per day) — ICU", 6500);
  const genRate = await tariffRate(hospitalId, "Bed Charges (per day) — General Ward", 1800);
  const [admissions] = await pool.query(
    `SELECT a.id, a.patient_uhid, w.name AS ward_name, b.bed_number
     FROM ipd_admissions a
     LEFT JOIN wards w ON w.id = a.ward_id
     LEFT JOIN beds b ON b.id = a.bed_id
     WHERE a.hospital_id = ? AND a.bed_id IS NOT NULL`,
    [hospitalId]
  );
  for (const a of admissions) {
    const isIcu = (a.ward_name || "").toLowerCase().includes("icu");
    const rate = isIcu ? icuRate : genRate;
    await pool.query(
      `INSERT IGNORE INTO patient_charges (hospital_id, patient_uhid, source_type, source_id, description, department, rate)
       VALUES (?, ?, 'ipd_admission', ?, ?, 'IPD', ?)`,
      [hospitalId, a.patient_uhid, a.id, `Bed Charges — ${a.ward_name || "Ward"} (Bed ${a.bed_number || "—"})`, rate]
    );
  }
}

app.get("/api/billing/patients", requireBillingStaff, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    await reconcilePatientCharges(hospitalId);

    const [patients] = await pool.query(
      `SELECT uhid, full_name, phone, category, created_at FROM patients WHERE hospital_id = ? ORDER BY created_at DESC`,
      [hospitalId]
    );
    const [visits] = await pool.query(
      `SELECT patient_uhid, status, visit_date, created_at FROM opd_visits WHERE hospital_id = ?`,
      [hospitalId]
    );
    const [admissions] = await pool.query(
      `SELECT a.patient_uhid, w.name AS ward_name, b.bed_number
       FROM ipd_admissions a LEFT JOIN wards w ON w.id = a.ward_id LEFT JOIN beds b ON b.id = a.bed_id
       WHERE a.hospital_id = ? AND a.status = 'admitted'`,
      [hospitalId]
    );
    const [unbilledCharges] = await pool.query(
      `SELECT patient_uhid, SUM(rate) AS total FROM patient_charges WHERE hospital_id = ? AND bill_id IS NULL GROUP BY patient_uhid`,
      [hospitalId]
    );
    const [pharmacyUnbilled] = await pool.query(
      `SELECT patient_uhid, SUM(amount) AS total FROM medisys_pharmacy.pharmacy_orders
       WHERE hospital_id = ? AND status = 'dispensed' AND invoice_id IS NULL GROUP BY patient_uhid`,
      [hospitalId]
    );
    const [pharmacyInvoicePending] = await pool.query(
      `SELECT patient_uhid, SUM(total_amount) AS total FROM medisys_pharmacy.pharmacy_invoices
       WHERE hospital_id = ? AND payment_status != 'Paid' GROUP BY patient_uhid`,
      [hospitalId]
    );

    const byUhid = (rows) => Object.fromEntries(rows.map((r) => [r.patient_uhid, parseFloat(r.total) || 0]));
    const chargeMap = byUhid(unbilledCharges);
    const pharmUnbilledMap = byUhid(pharmacyUnbilled);
    const pharmInvoiceMap = byUhid(pharmacyInvoicePending);

    const result = patients.map((p) => {
      const admission = admissions.find((a) => a.patient_uhid === p.uhid);
      const patientVisits = visits.filter((v) => v.patient_uhid === p.uhid).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const latestVisit = patientVisits[0] || null;
      const pharmacyOutstanding = (pharmUnbilledMap[p.uhid] || 0) + (pharmInvoiceMap[p.uhid] || 0);
      const billingDeskOutstanding = chargeMap[p.uhid] || 0;
      return {
        uhid: p.uhid,
        fullName: p.full_name,
        phone: p.phone,
        category: p.category,
        registeredAt: p.created_at,
        isAdmitted: !!admission,
        wardName: admission ? admission.ward_name : null,
        bedNumber: admission ? admission.bed_number : null,
        visitCount: patientVisits.length,
        latestVisitStatus: latestVisit ? latestVisit.status : null,
        latestVisitDate: latestVisit ? latestVisit.visit_date : null,
        billingDeskOutstanding,
        pharmacyOutstanding,
        totalOutstanding: billingDeskOutstanding + pharmacyOutstanding,
      };
    });

    res.json({ success: true, patients: result });
  } catch (err) {
    console.error("List billing patients error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.get("/api/billing/patients/:uhid/ledger", requireBillingStaff, async (req, res) => {
  try {
    const { hospitalId } = req.session.user;
    await reconcilePatientCharges(hospitalId);
    const uhid = req.params.uhid;

    const [[patient]] = await pool.query(`SELECT * FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`, [uhid, hospitalId]);
    if (!patient) return res.status(404).json({ success: false, message: "Patient not found." });

    const [charges] = await pool.query(
      `SELECT pc.*, b.status AS bill_status, b.bill_no
       FROM patient_charges pc LEFT JOIN bills b ON b.id = pc.bill_id
       WHERE pc.hospital_id = ? AND pc.patient_uhid = ? ORDER BY pc.created_at ASC`,
      [hospitalId, uhid]
    );

    const [pharmacyOrders] = await pool.query(
      `SELECT po.*, pi.payment_status AS invoice_status, pi.invoice_number
       FROM medisys_pharmacy.pharmacy_orders po
       LEFT JOIN medisys_pharmacy.pharmacy_invoices pi ON pi.id = po.invoice_id
       WHERE po.hospital_id = ? AND po.patient_uhid = ? ORDER BY po.created_at ASC`,
      [hospitalId, uhid]
    );

    const [admission] = await pool.query(
      `SELECT a.*, w.name AS ward_name, b.bed_number
       FROM ipd_admissions a LEFT JOIN wards w ON w.id = a.ward_id LEFT JOIN beds b ON b.id = a.bed_id
       WHERE a.hospital_id = ? AND a.patient_uhid = ? AND a.status = 'admitted' LIMIT 1`,
      [hospitalId, uhid]
    );

    res.json({ success: true, patient, charges, pharmacyOrders, admission: admission[0] || null });
  } catch (err) {
    console.error("Get patient ledger error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

app.post("/api/billing/patients/:uhid/collect", requireBillingStaff, async (req, res) => {
  const { chargeIds, paymentMode } = req.body || {};
  if (!Array.isArray(chargeIds) || chargeIds.length === 0) {
    return res.status(400).json({ success: false, message: "Select at least one charge to collect." });
  }
  try {
    const { hospitalId, userId } = req.session.user;
    const uhid = req.params.uhid;

    const [charges] = await pool.query(
      `SELECT * FROM patient_charges WHERE id IN (?) AND hospital_id = ? AND patient_uhid = ? AND bill_id IS NULL`,
      [chargeIds, hospitalId, uhid]
    );
    if (charges.length === 0) {
      return res.status(409).json({ success: false, message: "Those charges are no longer outstanding — they may already be collected." });
    }

    const [[patient]] = await pool.query(`SELECT full_name FROM patients WHERE uhid = ? AND hospital_id = ? LIMIT 1`, [uhid, hospitalId]);
    const total = charges.reduce((s, c) => s + parseFloat(c.rate), 0);
    const billNo = "CN/" + new Date().getFullYear() + "/" + (1000 + Math.floor(Math.random() * 8999));

    const [result] = await pool.query(
      `INSERT INTO bills
        (hospital_id, bill_no, patient_uhid, patient_name, department, bill_date,
         subtotal, discount_pct, discount_amount, tax_pct, tax_amount, total_amount, paid_amount, balance_amount, status, created_by)
       VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 0, 0, 0, 0, ?, ?, 0, 'Paid', ?)`,
      [hospitalId, billNo, uhid, patient ? patient.full_name : uhid, charges[0].department, total, total, total, userId]
    );
    const billId = result.insertId;

    const itemRows = charges.map((c) => [hospitalId, billId, c.description, c.department, 1, c.rate, c.rate]);
    await pool.query(`INSERT INTO bill_items (hospital_id, bill_id, description, department, qty, rate, amount) VALUES ?`, [itemRows]);
    await pool.query(`INSERT INTO bill_payments (hospital_id, bill_id, amount, mode, reference, created_by) VALUES (?, ?, ?, ?, ?, ?)`, [
      hospitalId, billId, total, paymentMode || "Cash", "RCPT-" + (1000 + Math.floor(Math.random() * 8999)), userId,
    ]);
    await pool.query(`UPDATE patient_charges SET bill_id = ? WHERE id IN (?)`, [billId, charges.map((c) => c.id)]);

    broadcast(req, "billing_bills");
    broadcast(req, "billing_payments");
    broadcast(req, "billing_patients");
    res.json({ success: true, billId, billNo, total });
  } catch (err) {
    console.error("Collect patient charges error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
  const connection = await pool.getConnection();
  try {
    await ensureSchema(connection);

    const [hospitals] = await connection.query("SELECT id, admin_user_id FROM hospitals");
    for (const hospital of hospitals) {
      await seedTestCatalog(connection, hospital.id);
      await seedBillingTariff(connection, hospital.id);
    }

    await connection.query(
      `INSERT IGNORE INTO user_directory (user_id, hospital_id)
       SELECT admin_user_id, id FROM hospitals WHERE admin_user_id IS NOT NULL`
    );
  } finally {
    connection.release();
  }

  // socket.io needs a raw http.Server (not the bare one app.listen() creates
  // internally) so it can hook the 'upgrade' event for the WebSocket handshake.
  const http = require("http");
  const httpServer = http.createServer(app);
  initRealtime(httpServer, sessionMiddleware);

  httpServer.listen(PORT, () => {
    console.log(`MEDISYS server running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err.message);
  process.exit(1);
});
