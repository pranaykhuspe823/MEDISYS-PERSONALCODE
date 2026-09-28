async function ensureSchema(connection, { seedDefaults = true } = {}) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS hospitals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      license_number VARCHAR(100),
      pan VARCHAR(20),
      hfr_id VARCHAR(50),
      address VARCHAR(255),
      city VARCHAR(100),
      state VARCHAR(100),
      pincode VARCHAR(12),
      bed_count INT,
      opd_volume INT,
      admin_name VARCHAR(150),
      admin_email VARCHAR(150) NOT NULL,
      modules JSON,
      dpdp_consent BOOLEAN NOT NULL DEFAULT FALSE,
      status ENUM('pending_activation','active') NOT NULL DEFAULT 'pending_activation',
      invite_token VARCHAR(64),
      invite_sent_at TIMESTAMP NULL,
      short_code VARCHAR(10),
      admin_user_id VARCHAR(50),
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(150),
      role VARCHAR(50) NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS user_directory (
      user_id VARCHAR(50) PRIMARY KEY,
      hospital_id INT NOT NULL,
      account_type VARCHAR(20) NOT NULL DEFAULT 'staff',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn(connection, "hospitals", "short_code", "VARCHAR(10)");
  await ensureColumn(connection, "hospitals", "admin_user_id", "VARCHAR(50)");
  await ensureColumn(
    connection,
    "hospitals",
    "nurse_assignment_mode",
    "ENUM('ward_based','doctor_team') NOT NULL DEFAULT 'ward_based'"
  );
  // CSV/XLSX import (see server/importRoutes.js) — values for any uploaded
  // column that doesn't match a real schema column land here, keyed by their
  // original file header, instead of ever being dropped.
  await ensureColumn(connection, "hospitals", "extra_fields", "JSON NULL");
  // Filename only (not a full path) — the actual file lives in
  // server/uploads/hospital-logos/, served by GET /api/hospital/:id/logo.
  // NULL means "no custom logo" — every portal page falls back to the
  // default CORE5 MEDISYS logo automatically (see portal-ui.js).
  await ensureColumn(connection, "hospitals", "logo_path", "VARCHAR(255) NULL");
  // Custom footer/header display name shown in place of "CORE5 MEDISYS" for
  // this hospital only. NULL means "use the default CORE5 MEDISYS branding"
  // (see portal-ui.js). The "Powered by CORE5 MEDISYS" attribution line
  // stays fixed regardless — this only ever renames the big brand text.
  await ensureColumn(connection, "hospitals", "brand_name", "VARCHAR(80) NULL");
  await ensureColumn(connection, "users", "email", "VARCHAR(150)");
  await ensureColumn(connection, "users", "phone", "VARCHAR(20)");
  await ensureColumn(connection, "users", "details", "JSON");
  await ensureColumn(connection, "users", "department_id", "INT NULL");
  await ensureColumn(connection, "users", "hospital_id", "INT NULL");
  // Same "which import batch created this row" tracking as patients.imported_from_batch,
  // so the Data Import page's Delete/Undo can also remove staff it created — see
  // server/importRoutes.js DELETE /api/import/:batchId.
  await ensureColumn(connection, "users", "imported_from_batch", "INT NULL");

  await connection.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS patients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      uhid VARCHAR(30) UNIQUE,
      password_hash VARCHAR(255),
      full_name VARCHAR(150) NOT NULL,
      dob DATE,
      gender VARCHAR(10),
      phone VARCHAR(20),
      address VARCHAR(255),
      emergency_contact_name VARCHAR(150),
      emergency_contact_phone VARCHAR(20),
      abha_id VARCHAR(50),
      category VARCHAR(20),
      registered_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn(connection, "patients", "blood_group", "VARCHAR(4) NULL");
  await ensureColumn(connection, "patients", "abha_address", "VARCHAR(100) NULL");
  await ensureColumn(connection, "patients", "abha_verified", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn(connection, "patients", "abha_link_status", "VARCHAR(20) NULL");
  // Which ABHA lookup method (if any) actually succeeded at registration —
  // 'manual' (no ABHA verification used), 'mobile_otp', 'aadhaar_otp',
  // 'fingerprint' (any one of these three from staff/patient-checkin.html,
  // which only ever completes one method), or 'all_three' (from
  // staff/registration.html, which requires all three in sequence before
  // registration is allowed at all). Set from the hidden
  // #abhaVerificationMethod field, defaulting to 'manual'; see the OPD
  // registrations dashboard (staff/opd-registrations.html) for where this
  // is surfaced.
  await ensureColumn(connection, "patients", "abha_verification_method", "VARCHAR(20) NOT NULL DEFAULT 'manual'");
  // Same import-overflow column as hospitals.extra_fields above.
  await ensureColumn(connection, "patients", "extra_fields", "JSON NULL");
  // Free-text known-allergy list (e.g. "Penicillin, Sulfa drugs"), read aloud
  // first — before anything else — by the voice patient-recall briefing (see
  // server/voiceQuery.js buildSpokenSummary). NULL/empty means "not recorded",
  // which the briefing says explicitly rather than silently omitting, since a
  // doctor hearing nothing must not read that as "confirmed no allergies."
  await ensureColumn(connection, "patients", "allergies", "TEXT NULL");

  // ---------- CSV/XLSX data import (hospital admin only — see server/importRoutes.js) ----------

  // One row per uploaded file. Nothing here ever touches a real table directly —
  // every row is staged first (import_staging_rows) and only applied to
  // patients/hospitals on a deliberate POST /api/import/:batchId/commit.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      batch_uid VARCHAR(40) NOT NULL UNIQUE,
      hospital_id INT NOT NULL,
      source_name VARCHAR(150) NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      target_entity VARCHAR(30) NOT NULL,
      uploaded_by VARCHAR(50) NOT NULL,
      status ENUM('uploaded','mapping','ready','committing','committed','failed') NOT NULL DEFAULT 'uploaded',
      total_rows INT NOT NULL DEFAULT 0,
      committed_rows INT NOT NULL DEFAULT 0,
      failed_rows INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      committed_at TIMESTAMP NULL
    )
  `);

  // Every row from the uploaded file, completely unmodified, before any
  // mapping/matching/transform is applied — raw_data is the row exactly as
  // parsed (PapaParse/SheetJS), header text as keys. status tracks what
  // happened to THIS row specifically once the batch is committed, since one
  // batch can partially succeed (a handful of rows can fail Ajv validation
  // while the rest commit fine).
  await connection.query(`
    CREATE TABLE IF NOT EXISTS import_staging_rows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      batch_id INT NOT NULL,
      row_num INT NOT NULL,
      raw_data JSON NOT NULL,
      status ENUM('pending','mapped','error','committed','skipped') NOT NULL DEFAULT 'pending',
      error_message VARCHAR(500) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // A hospital-scoped custom field, auto-registered the moment a commit
  // encounters a file column that doesn't match anything in
  // server/schemaRegistry.js for that entity — see requireOrCreateCustomField
  // in server/importRoutes.js. Unique per (hospital_id, entity, field_key) so
  // re-uploading a file with the same unmatched header reuses the same
  // custom field instead of creating a duplicate registration each time.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS hospital_custom_fields (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      entity VARCHAR(30) NOT NULL,
      field_key VARCHAR(150) NOT NULL,
      field_label VARCHAR(150) NOT NULL,
      field_type ENUM('string','number','date','boolean') NOT NULL DEFAULT 'string',
      auto_created BOOLEAN NOT NULL DEFAULT TRUE,
      created_from_batch INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_hospital_entity_field (hospital_id, entity, field_key)
    )
  `);

  // What an admin confirmed (or edited) at the mapping step, keyed by
  // source_name (see import_batches.source_name — a stable label for "this
  // kind of file from this hospital", e.g. "Apollo EMR Export") so the next
  // upload of the same kind of file reuses the same mapping automatically
  // instead of asking again. target_type distinguishes a real column from a
  // deliberately-ignored field (see the "never silently drop data" rule in
  // POST /api/import/:batchId/mapping — 'ignored' is only ever set by an
  // explicit admin action, never a default).
  await connection.query(`
    CREATE TABLE IF NOT EXISTS import_field_mappings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      source_name VARCHAR(150) NOT NULL,
      target_entity VARCHAR(30) NOT NULL,
      source_field VARCHAR(150) NOT NULL,
      target_field VARCHAR(150) NULL,
      target_type ENUM('column','extra_field','ignored') NOT NULL DEFAULT 'extra_field',
      transform_fn VARCHAR(50) NULL,
      confirmed_by VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_hospital_source_field (hospital_id, source_name, target_entity, source_field)
    )
  `);

  // Lets an admin undo a bad import from the Data Import page itself instead
  // of asking for help — see DELETE /api/import/:batchId in importRoutes.js.
  // pre_commit_snapshot is only used for the "hospitals" entity (a singleton
  // row that gets UPDATEd, never inserted, so there's no row to just delete —
  // this is what the real column values + extra_fields looked like right
  // before this batch touched them, so undo can restore it exactly).
  await ensureColumn(connection, "patients", "imported_from_batch", "INT NULL");
  await ensureColumn(connection, "import_batches", "pre_commit_snapshot", "JSON NULL");
  await ensureColumn(connection, "import_batches", "reverted_at", "TIMESTAMP NULL");
  await ensureColumn(connection, "import_batches", "reverted_by", "VARCHAR(50) NULL");
  // Multi-entity single-file import (target_entity = 'multi', see
  // server/importRoutes.js): the cross-tier "CSV row N of table X" -> real
  // DB id map, accumulated as each dependency tier commits (its own request),
  // so the NEXT tier's request can resolve its foreign-key columns against
  // rows THIS batch itself created earlier in the same file.
  await ensureColumn(connection, "import_batches", "multi_entity_id_map", "JSON NULL");
  // "Auto-detect (mixed dataset)" mode (see server/roleClassifier.js): a batch
  // with target_entity = 'auto' mixes multiple destinations in one file, so
  // each STAGING ROW carries its own detected destination instead of the
  // whole batch sharing one. detection_label keeps the raw value that led to
  // that classification (e.g. "Billing Staff"), shown in the review UI so an
  // admin can sanity-check the sort before committing.
  await ensureColumn(connection, "import_staging_rows", "detected_entity", "VARCHAR(30) NULL");
  await ensureColumn(connection, "import_staging_rows", "detection_label", "VARCHAR(150) NULL");

  // ---------- Hospital admin dashboard: expenses + staff messaging ----------

  // Manually logged by the hospital admin — there's no automatic source for
  // "money spent" anywhere else in the app (unlike revenue, which is derived
  // live from bills/pharmacy_invoices/blood_billing/telemedicine_payments —
  // see GET /api/hospital/overview), so this is deliberately a real ledger
  // the admin maintains themselves rather than an inferred/estimated figure.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS hospital_expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      category VARCHAR(100) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      note VARCHAR(255) NULL,
      expense_date DATE NOT NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // One-way private messages, hospital admin -> a specific staff member (see
  // POST /api/hospital/messages). Delivered live over the same Socket.IO
  // "user:<userId>" room every other real-time feature in this app already
  // joins (see server/realtime.js) — a staff member sees it appear in their
  // own portal without refreshing, via the message bell in portal-ui.js.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS staff_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      from_user_id VARCHAR(50) NOT NULL,
      from_name VARCHAR(150) NOT NULL,
      to_user_id VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS doctor_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      day_of_week TINYINT NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      slot_minutes INT NOT NULL DEFAULT 15,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Superseded by doctor_calendar_availability below (specific calendar dates rather
  // than a recurring day-of-week pattern) — table kept around untouched so existing
  // rows aren't lost, but the app no longer reads or writes it.

  await connection.query(`
    CREATE TABLE IF NOT EXISTS doctor_calendar_availability (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      avail_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      slot_minutes INT NOT NULL DEFAULT 15,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_doctor_date_start (doctor_user_id, avail_date, start_time)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS wards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      department_id INT NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS beds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      ward_id INT NOT NULL,
      bed_number VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'available',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS opd_visits (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      token_number INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      visit_date DATE NOT NULL,
      slot_time TIME NULL,
      source VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'waiting',
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Random, unguessable Jitsi room slug for telemedicine visits (see
  // POST /api/telemedicine/verify-payment) — never the visit id or anything
  // derivable, since meet.jit.si is a public server with no access control
  // of its own; knowing the room name is the only thing that gates entry.
  await ensureColumn(connection, "opd_visits", "meeting_room", "VARCHAR(64) NULL");

  // One row per telemedicine booking attempt, created the moment the Razorpay order
  // is created and updated once the payment is verified (see POST /api/telemedicine/*
  // in server.js). The opd_visits row itself is only ever inserted after verification
  // succeeds — status stays 'created' (never became a real visit) for anything the
  // patient abandoned or that failed, so the doctor's queue never sees an unpaid booking.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS telemedicine_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      visit_date DATE NOT NULL,
      slot_time TIME NULL,
      amount DECIMAL(10,2) NOT NULL,
      razorpay_order_id VARCHAR(64) NOT NULL,
      razorpay_payment_id VARCHAR(64) NULL,
      razorpay_signature VARCHAR(128) NULL,
      status ENUM('created','paid','failed') NOT NULL DEFAULT 'created',
      opd_visit_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP NULL,
      UNIQUE KEY uniq_razorpay_order (razorpay_order_id)
    )
  `);

  // Generic Razorpay order tracking shared by every other "collect payment"
  // flow in the app (pharmacy invoices, blood bank billing, billing desk
  // bills) — telemedicine keeps its own dedicated table above since it also
  // carries booking-specific fields (doctor, slot) that don't apply here.
  // One row per order; resource_type + resource_id point back at whichever
  // domain row (pharmacy_invoices.id, blood_billing.id, bills.id) it's for.
  // The domain row is only ever marked paid after this row's status flips to
  // 'paid' via a verified signature — see createPaymentOrder/
  // verifyPaymentOrder in server.js.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      resource_type VARCHAR(30) NOT NULL,
      resource_id INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      razorpay_order_id VARCHAR(64) NOT NULL,
      razorpay_payment_id VARCHAR(64) NULL,
      razorpay_signature VARCHAR(128) NULL,
      status ENUM('created','paid','failed') NOT NULL DEFAULT 'created',
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP NULL,
      UNIQUE KEY uniq_razorpay_order (razorpay_order_id)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS vitals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      opd_visit_id INT NULL,
      ipd_admission_id INT NULL,
      bp VARCHAR(20),
      temperature VARCHAR(10),
      weight VARCHAR(10),
      spo2 VARCHAR(10),
      recorded_by VARCHAR(50),
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS consultations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      opd_visit_id INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      symptoms TEXT,
      notes TEXT,
      decision VARCHAR(20) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // A consultation can now combine multiple actions at once (prescribe + order tests +
  // admit), stored as a comma-joined list (e.g. "prescribe,order_tests,admit") — widen
  // from the original single-decision VARCHAR(20). MODIFY is idempotent, safe to re-run.
  await connection.query(`ALTER TABLE consultations MODIFY COLUMN decision VARCHAR(60) NOT NULL`);
  // Structured diagnosis (picked from a fixed notifiable-disease list, see DISEASE_WATCHLIST
  // in server.js) — separate from the free-text symptoms/notes above so case counts per
  // hospital/disease can actually be aggregated for outbreak detection.
  await ensureColumn(connection, "consultations", "diagnosis", "VARCHAR(100) NULL");

  // One row per outbreak alert actually raised (case count for some diagnosis crossed the
  // threshold at some hospital within the rolling window). Drives both the hospital admin's
  // "Outbreak Alerts" panel and the simulated SMS fan-out — see checkDiseaseOutbreak() in
  // server.js. Only aggregate counts are stored here, never other hospitals' patient lists,
  // so an alert never leaks cross-tenant patient data into a hospital admin's portal.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS disease_alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      diagnosis VARCHAR(100) NOT NULL,
      case_count INT NOT NULL,
      window_days INT NOT NULL,
      hospital_patients_notified INT NOT NULL DEFAULT 0,
      nearby_patients_notified INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS ipd_admissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      admitting_doctor_user_id VARCHAR(50),
      ward_id INT NULL,
      bed_id INT NULL,
      consent_obtained BOOLEAN NOT NULL DEFAULT FALSE,
      id_proof_note VARCHAR(150),
      admission_notes TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'requested',
      opd_visit_id INT NULL,
      assigned_nurse_id VARCHAR(50) NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      admitted_at TIMESTAMP NULL
    )
  `);
  await ensureColumn(connection, "ipd_admissions", "discharged_at", "TIMESTAMP NULL");
  await ensureColumn(connection, "ipd_admissions", "discharged_by", "VARCHAR(50) NULL");

  await connection.query(`
    CREATE TABLE IF NOT EXISTS doctor_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      ipd_admission_id INT NOT NULL,
      order_type VARCHAR(20) NOT NULL,
      description TEXT NOT NULL,
      ordered_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS medication_administration (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      ipd_admission_id INT NOT NULL,
      doctor_order_id INT NULL,
      medicine_name VARCHAR(150) NOT NULL,
      dose VARCHAR(50),
      administered_by VARCHAR(50),
      administered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes VARCHAR(255)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS ipd_notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      ipd_admission_id INT NOT NULL,
      note_type VARCHAR(20) NOT NULL,
      message TEXT NOT NULL,
      flagged_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS test_catalog (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      category VARCHAR(30) NOT NULL,
      department VARCHAR(50),
      sample_type VARCHAR(50),
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      turnaround_hours INT NOT NULL DEFAULT 24,
      is_panel BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS lab_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      opd_visit_id INT NULL,
      ipd_admission_id INT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      test_id INT NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      assigned_to VARCHAR(50) NULL,
      result_notes TEXT NULL,
      result_file_path VARCHAR(255) NULL,
      result_file_name VARCHAR(255) NULL,
      completed_by VARCHAR(50) NULL,
      completed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // priority / verification fields, added after the initial release — kept as an additive
  // migration (ensureColumn) rather than in the CREATE above so existing installs pick them up.
  await ensureColumn(
    connection,
    "lab_orders",
    "priority",
    "ENUM('routine','urgent','stat') NOT NULL DEFAULT 'routine'"
  );
  await ensureColumn(connection, "lab_orders", "verified_by", "VARCHAR(50) NULL");
  await ensureColumn(connection, "lab_orders", "verified_at", "TIMESTAMP NULL");
  // Nothing sets these yet — no pathology-side UI exists to flag a result as
  // critical. Added now so the voice patient-recall briefing (server/voiceQuery.js)
  // has a real field to read; until pathology gets a "mark critical" control,
  // this just stays FALSE for every row and the briefing correctly reports no
  // critical values flagged. Setting one today means a manual UPDATE.
  await ensureColumn(connection, "lab_orders", "is_critical", "BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn(connection, "lab_orders", "critical_value_note", "VARCHAR(255) NULL");

  // Multiple images per study (radiology). A study can have 0..N uploaded images;
  // legacy single-file result (result_file_path/name) is still used by the pathology flow.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS lab_order_images (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      lab_order_id INT NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      uploaded_by VARCHAR(50) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // General-purpose access audit trail — see server/security/auditLog.js
  // (logAccess) and server/security/rbac.js (requirePermission), first
  // adopted by the voice patient-recall feature (POST /api/voice/query) but
  // written as shared infra any route can call, not a voice-only table.
  // transcript_encrypted (when present) is AES-256-GCM ciphertext of
  // whatever raw voice/text input triggered the access, via
  // server/security/encryption.js — encrypted at rest since a transcript can
  // itself contain PII (a spoken patient name), decrypted only by a future
  // admin-side review tool (not built yet). metadata is plain JSON: only
  // non-sensitive structured facts (match source, permission checked, result
  // counts) belong there.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      actor_user_id VARCHAR(50) NOT NULL,
      actor_role VARCHAR(20) NOT NULL,
      action VARCHAR(50) NOT NULL,
      resource_type VARCHAR(30) NOT NULL,
      resource_id VARCHAR(50) NULL,
      outcome VARCHAR(20) NOT NULL DEFAULT 'success',
      metadata JSON NULL,
      transcript_encrypted TEXT NULL,
      ip_address VARCHAR(45) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`CREATE DATABASE IF NOT EXISTS medisys_pharmacy`);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS medisys_pharmacy.pharmacy_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      opd_visit_id INT NULL,
      ipd_admission_id INT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      medicine_name VARCHAR(150) NOT NULL,
      dosage VARCHAR(100) NOT NULL,
      duration VARCHAR(50) NOT NULL,
      urgency ENUM('routine', 'urgent') NOT NULL DEFAULT 'routine',
      status VARCHAR(20) NOT NULL DEFAULT 'pending_pharmacy',
      dispensed_by VARCHAR(50) NULL,
      dispensed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      amount DECIMAL(10,2) NULL,
      payment_mode VARCHAR(20) NULL
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS medisys_pharmacy.pharmacy_stock (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      medicine_name VARCHAR(150) NOT NULL,
      category VARCHAR(50) NOT NULL,
      batch_number VARCHAR(50) NOT NULL,
      expiry_date DATE NOT NULL,
      stock_quantity INT NOT NULL DEFAULT 0,
      min_stock_level INT NOT NULL DEFAULT 10,
      unit_price DECIMAL(10,2),
      added_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS medisys_pharmacy.pharmacy_purchase_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      po_number VARCHAR(50) NOT NULL UNIQUE,
      supplier_name VARCHAR(150) NOT NULL,
      items_summary VARCHAR(255) NOT NULL,
      total_items INT NOT NULL DEFAULT 1,
      status VARCHAR(30) NOT NULL DEFAULT 'Submitted',
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS medisys_pharmacy.pharmacy_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      invoice_number VARCHAR(50) NOT NULL UNIQUE,
      order_id INT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      patient_name VARCHAR(150) NOT NULL,
      payment_type VARCHAR(30) NOT NULL DEFAULT 'Cash',
      item_count INT NOT NULL DEFAULT 1,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      payment_status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP NULL
    )
  `);

  // Links a dispensed medicine to the one combined invoice it was billed under —
  // lets an invoice cover every medicine from a visit instead of one invoice each.
  await ensureColumnInSchema(connection, "medisys_pharmacy", "pharmacy_orders", "invoice_id", "INT NULL");
  // Before Meal / After Meal / With Meal / Empty Stomach — set by the prescribing
  // doctor, shown to pharmacy staff dispensing it and to the patient in their portal.
  await ensureColumnInSchema(connection, "medisys_pharmacy", "pharmacy_orders", "food_instruction", "VARCHAR(20) NULL");

  // Who this batch was bought from — shown as "last supplier" on the low-stock
  // reorder list. Optional; older rows predating this column stay NULL.
  await ensureColumnInSchema(connection, "medisys_pharmacy", "pharmacy_stock", "supplier_name", "VARCHAR(150) NULL");
  // The quantity this batch started with when received, preserved separately
  // from stock_quantity (which dispensing/edits mutate downward) so the
  // "10% of the last-received batch" default reorder threshold stays accurate
  // even after the batch has been partly dispensed. Rows from before this
  // column existed fall back to their current stock_quantity as a reasonable
  // approximation (see the low-stock endpoint in server.js).
  await ensureColumnInSchema(connection, "medisys_pharmacy", "pharmacy_stock", "received_quantity", "INT NULL");

  // Per-medicine (not per-batch) low-stock reorder threshold — set manually by
  // pharmacist/admin from the Medicine Stock tab, or left unset to fall back to
  // "10% of the last-received batch" (computed live, see GET
  // /api/pharmacy-stock/low-stock). Keyed by medicine_name rather than a
  // medicine ID because pharmacy_stock has no separate medicines table —
  // every batch just repeats the medicine's name as a string.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS medisys_pharmacy.medicine_thresholds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      medicine_name VARCHAR(150) NOT NULL,
      reorder_threshold DECIMAL(10,2) NULL,
      reorder_threshold_type VARCHAR(20) NOT NULL DEFAULT 'percentage',
      updated_by VARCHAR(50) NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hospital_medicine (hospital_id, medicine_name)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS nurse_shift_roster (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      nurse_user_id VARCHAR(50) NOT NULL,
      ward_id INT NOT NULL,
      shift VARCHAR(20) NOT NULL,
      day_of_week TINYINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS doctor_nurse_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      doctor_user_id VARCHAR(50) NOT NULL,
      nurse_user_id VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ---------- Blood Bank ----------
  await connection.query(`
    CREATE TABLE IF NOT EXISTS blood_donors (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      patient_uhid VARCHAR(30) NULL,
      blood_group VARCHAR(4) NOT NULL,
      phone VARCHAR(20),
      last_donation_date DATE NULL,
      total_donations INT NOT NULL DEFAULT 0,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS blood_inventory_units (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      unit_code VARCHAR(30) NOT NULL,
      blood_group VARCHAR(4) NOT NULL,
      component VARCHAR(30) NOT NULL,
      donor_id INT NULL,
      collected_at TIMESTAMP NOT NULL,
      expiry_at TIMESTAMP NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'available',
      issued_to_request_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS blood_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      request_code VARCHAR(30) NOT NULL,
      patient_uhid VARCHAR(30) NULL,
      patient_name VARCHAR(150) NOT NULL,
      age INT NULL,
      sex VARCHAR(4) NULL,
      blood_group VARCHAR(4) NOT NULL,
      component VARCHAR(30) NOT NULL,
      units_required INT NOT NULL DEFAULT 1,
      priority VARCHAR(20) NOT NULL DEFAULT 'Routine',
      ward_location VARCHAR(150),
      ref_physician VARCHAR(150),
      status VARCHAR(20) NOT NULL DEFAULT 'requested',
      assigned_staff_id VARCHAR(50) NULL,
      crossmatch_sample BOOLEAN NOT NULL DEFAULT FALSE,
      crossmatch_abo BOOLEAN NOT NULL DEFAULT FALSE,
      crossmatch_screen BOOLEAN NOT NULL DEFAULT FALSE,
      notes TEXT,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      issued_at TIMESTAMP NULL
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS blood_patient_donations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      donor_name VARCHAR(150) NOT NULL,
      blood_group VARCHAR(4) NOT NULL,
      component VARCHAR(30) NOT NULL,
      units INT NOT NULL DEFAULT 1,
      weight DECIMAL(5,1),
      hb DECIMAL(4,1),
      systolic INT,
      diastolic INT,
      pulse INT,
      temperature DECIMAL(4,1),
      flags JSON,
      eligible BOOLEAN NOT NULL,
      ineligible_reasons TEXT,
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      recorded_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS blood_billing (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      request_id INT NOT NULL,
      patient_uhid VARCHAR(30) NULL,
      patient_name VARCHAR(150) NOT NULL,
      component VARCHAR(30) NOT NULL,
      units INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      payment_type VARCHAR(30) NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP NULL
    )
  `);

  // ---------- Billing Desk (OPD/IPD/Pathology/Radiology/Pharmacy consolidated billing) ----------
  await connection.query(`
    CREATE TABLE IF NOT EXISTS bills (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      bill_no VARCHAR(30) NOT NULL,
      patient_uhid VARCHAR(30) NULL,
      patient_name VARCHAR(150) NOT NULL,
      abha_id VARCHAR(50),
      department VARCHAR(30) NOT NULL,
      doctor_user_id VARCHAR(50) NULL,
      bill_date DATE NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
      discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      tax_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
      tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      balance_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      is_insurance BOOLEAN NOT NULL DEFAULT FALSE,
      payer_name VARCHAR(150) NULL,
      policy_no VARCHAR(100) NULL,
      claim_status VARCHAR(20) NULL,
      approved_amount DECIMAL(10,2) NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS bill_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      bill_id INT NOT NULL,
      description VARCHAR(200) NOT NULL,
      department VARCHAR(30),
      qty DECIMAL(10,2) NOT NULL DEFAULT 1,
      rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      bill_id INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      mode VARCHAR(30) NOT NULL,
      reference VARCHAR(50),
      paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_by VARCHAR(50)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS billing_tariff (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      charge_head VARCHAR(150) NOT NULL,
      department VARCHAR(30) NOT NULL,
      default_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Event-sourced charges: one row per real thing that should be billed (registration,
  // an OPD visit, a lab order, a bed admission). source_type + source_id point back at
  // the row that generated the charge, so re-reconciling never double-charges the same
  // event. bill_id stays NULL until a billing-desk staffer actually collects payment for
  // it — at that point it's grouped into a normal `bills` row like any manual bill.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS patient_charges (
      id INT AUTO_INCREMENT PRIMARY KEY,
      hospital_id INT NOT NULL,
      patient_uhid VARCHAR(30) NOT NULL,
      source_type VARCHAR(20) NOT NULL,
      source_id INT NOT NULL,
      description VARCHAR(200) NOT NULL,
      department VARCHAR(30) NOT NULL,
      rate DECIMAL(10,2) NOT NULL DEFAULT 0,
      bill_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_patient_charge_source (hospital_id, source_type, source_id)
    )
  `);

  // Same import-overflow column as hospitals.extra_fields/patients.extra_fields
  // above, retrofitted onto every table added for the multi-entity
  // single-file import feature (server/schemaRegistry.js `kind: "generic"`
  // entities) so a header commitGenericRow can't match a real column has
  // somewhere to land instead of being silently discarded — see
  // commitGenericRow in server/importRoutes.js. Run down here, after every
  // CREATE TABLE above (including the cross-database pharmacy ones), since
  // ensureColumn/ensureColumnInSchema ALTER a table that must already exist.
  const GENERIC_IMPORT_TABLES = [
    "departments", "wards", "test_catalog", "billing_tariff", "blood_donors", "beds",
    "doctor_schedules", "doctor_calendar_availability", "nurse_shift_roster", "doctor_nurse_teams",
    "opd_visits", "blood_inventory_units", "consultations",
    "ipd_admissions", "lab_orders", "blood_patient_donations", "blood_requests",
    "ipd_notes", "doctor_orders", "medication_administration", "lab_order_images",
    "bills", "blood_billing", "bill_items", "bill_payments", "patient_charges", "vitals",
  ];
  for (const table of GENERIC_IMPORT_TABLES) {
    await ensureColumn(connection, table, "extra_fields", "JSON NULL");
  }
  await ensureColumnInSchema(connection, "medisys_pharmacy", "pharmacy_stock", "extra_fields", "JSON NULL");
  await ensureColumnInSchema(connection, "medisys_pharmacy", "pharmacy_orders", "extra_fields", "JSON NULL");

  // Per-hospital database isolation: `hospitals` is only ever meaningfully
  // populated in the master database now (see server/dbRouter.js) — this
  // column records which physical database a hospital's own data lives in,
  // so getHospitalPool() can look it up before connecting.
  await ensureColumn(connection, "hospitals", "db_name", "VARCHAR(128) NULL");

  // Real bug found 2026-09-07: this ran unconditionally, so calling
  // ensureSchema against a brand-new, genuinely-empty per-hospital database
  // (onboarding a new hospital, or provisioning one during the per-hospital
  // DB migration) would trip seedDefaultUsers' "no hospitals exist yet"
  // guard EVERY time — silently seeding a fake demo hospital + demo staff
  // into every real hospital's own dedicated database, every server
  // restart. seedDefaults now defaults to true (unchanged behavior for
  // seed.js's fresh-install bootstrap, the only caller that still wants
  // it) but the multi-database startup/provisioning paths explicitly pass
  // false — real hospitals' own databases and the master router database
  // never get demo data auto-seeded into them.
  if (seedDefaults) {
    await seedDefaultUsers(connection);
  }
}

async function ensureColumn(connection, table, column, definition) {
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (columns.length === 0) {
    await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

// Same idea as ensureColumn, but for a table in a different database (e.g. the
// cross-database medisys_pharmacy tables), where DATABASE() would check the wrong schema.
async function ensureColumnInSchema(connection, schema, table, column, definition) {
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND COLUMN_NAME = ?`,
    [schema, table, column]
  );
  if (columns.length === 0) {
    await connection.query(`ALTER TABLE \`${schema}\`.\`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function dropColumnIfExists(connection, table, column) {
  const [columns] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (columns.length > 0) {
    await connection.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
  }
}

async function seedTestCatalog(connection, hospitalId) {
  const [[{ cnt }]] = await connection.query(
    "SELECT COUNT(*) AS cnt FROM test_catalog WHERE hospital_id = ?",
    [hospitalId]
  );
  if (cnt > 0) return;

  const tests = [
    ["CBC (Complete Blood Count)", "Hematology", "Pathology", "Blood", 300, 6],
    ["ESR", "Hematology", "Pathology", "Blood", 150, 6],
    ["Hemoglobin (Hb)", "Hematology", "Pathology", "Blood", 100, 4],
    ["Peripheral Smear", "Hematology", "Pathology", "Blood", 250, 12],
    ["LFT (Liver Function Test)", "Biochemistry", "Pathology", "Blood", 600, 12],
    ["KFT (Kidney Function Test)", "Biochemistry", "Pathology", "Blood", 600, 12],
    ["Blood Sugar (Fasting)", "Biochemistry", "Pathology", "Blood", 100, 4],
    ["Blood Sugar (PP)", "Biochemistry", "Pathology", "Blood", 100, 4],
    ["Lipid Profile", "Biochemistry", "Pathology", "Blood", 700, 12],
    ["Electrolytes (Na/K/Cl)", "Biochemistry", "Pathology", "Blood", 400, 6],
    ["Urine Culture & Sensitivity", "Microbiology", "Pathology", "Urine", 500, 48],
    ["Blood Culture & Sensitivity", "Microbiology", "Pathology", "Blood", 800, 72],
    ["Sputum Culture & Sensitivity", "Microbiology", "Pathology", "Sputum", 500, 48],
    ["Wound Swab Culture", "Microbiology", "Pathology", "Swab", 500, 48],
    ["Biopsy - Histopathology", "Histopathology", "Pathology", "Tissue", 1500, 96],
    ["FNAC (Fine Needle Aspiration Cytology)", "Histopathology", "Pathology", "Tissue", 1200, 72],
    ["HIV (ELISA)", "Serology", "Pathology", "Blood", 400, 24],
    ["HBsAg", "Serology", "Pathology", "Blood", 350, 24],
    ["HCV", "Serology", "Pathology", "Blood", 400, 24],
    ["VDRL", "Serology", "Pathology", "Blood", 200, 12],
    ["Widal Test", "Serology", "Pathology", "Blood", 200, 12],
    ["Dengue NS1/IgM/IgG", "Serology", "Pathology", "Blood", 600, 12],
    ["Malaria Antigen Test", "Serology", "Pathology", "Blood", 300, 4],
    ["Chest X-Ray", "Radiology", "Radiology", "N/A", 400, 4],
    ["Ultrasound Abdomen", "Radiology", "Radiology", "N/A", 1000, 6],
    ["CT Scan (Plain)", "Radiology", "Radiology", "N/A", 3500, 24],
    ["MRI (Plain)", "Radiology", "Radiology", "N/A", 6000, 24],
    ["ECG", "Radiology", "Radiology", "N/A", 250, 1],
  ];

  await connection.query(
    `INSERT INTO test_catalog (hospital_id, name, category, department, sample_type, price, turnaround_hours) VALUES ?`,
    [tests.map((t) => [hospitalId, ...t])]
  );
}

async function seedBillingTariff(connection, hospitalId) {
  const [[{ cnt }]] = await connection.query(
    "SELECT COUNT(*) AS cnt FROM billing_tariff WHERE hospital_id = ?",
    [hospitalId]
  );
  if (cnt > 0) return;

  const tariff = [
    ["Consultation Fee", "OPD", 600],
    ["Registration Fee", "OPD", 100],
    ["Pathology — Test Panel", "Pathology", 450],
    ["Radiology — Imaging", "Radiology", 1200],
    ["Bed Charges (per day) — General Ward", "IPD", 1800],
    ["Bed Charges (per day) — ICU", "IPD", 6500],
    ["Nursing Charges", "IPD", 300],
    ["Pharmacy — Medicines", "Pharmacy", 0],
  ];

  await connection.query(`INSERT INTO billing_tariff (hospital_id, charge_head, department, default_rate) VALUES ?`, [
    tariff.map((t) => [hospitalId, ...t]),
  ]);
}

const bcrypt = require("bcrypt");

async function seedDefaultUsers(connection) {
  try {
    const hashCore5 = await bcrypt.hash("Core5@2022", 10);
    const hashPhar = await bcrypt.hash("CAyjNATuMc", 10);
    const hash = await bcrypt.hash("admin123", 10);
    const passHash = await bcrypt.hash("password123", 10);

    // 1. Seed superadmins
    const superadmins = [
      ["superadmin", hash, "Super Admin"],
      ["C5-202226", hashCore5, "Core5 Super Admin"]
    ];

    for (const [sId, sHash, sName] of superadmins) {
      const [[{ cntSuper }]] = await connection.query(
        "SELECT COUNT(*) AS cntSuper FROM users WHERE user_id = ?",
        [sId]
      );
      if (cntSuper === 0) {
        await connection.query(
          "INSERT INTO users (user_id, password_hash, full_name, role) VALUES (?, ?, ?, ?)",
          [sId, sHash, sName, "superadmin"]
        );
      }
    }

    // 2-5. Demo hospital + its staff/patients — bootstrap only on a genuinely empty
    // install (no hospitals at all yet). The old guard checked only `id = 1`, so on any
    // database that already had a real hospital under a different id (e.g. imported from
    // a dump with id=10), it silently created a *second* duplicate "City Hospital
    // Ghatkopar" AND — worse — the unconditional password-reset UPDATEs below ran every
    // single server start, resetting real accounts (AD-CHG-64701, OPD-CHG-70518,
    // DR-CHG-49545, NR-CHG-88859, PH-44433, C5-202226, and patients PAT-CHG-0002/3/4) back
    // to these hardcoded demo passwords whenever a real hospital happened to reuse the
    // same user IDs, as ours does. Gating the whole block on "no hospitals exist yet"
    // makes this pure first-run bootstrap and leaves real data alone from then on.
    const [[{ cntAnyHospital }]] = await connection.query("SELECT COUNT(*) AS cntAnyHospital FROM hospitals");
    if (cntAnyHospital === 0) {
      // 2. Seed Default Hospital
      await connection.query(
        `INSERT INTO hospitals (id, name, license_number, city, state, bed_count, status, admin_name, admin_email, short_code, admin_user_id)
         VALUES (1, 'City Hospital Ghatkopar', 'LIC-1001', 'Mumbai', 'Maharashtra', 100, 'active', 'Rashmi', 'admin@cityhospital.com', 'CHG', 'AD-CHG-64701')`
      );

      // 3. Seed Hospital Admin & Staff Users
      const defaultUsers = [
        ["AD-CHG-64701", hashCore5, "Rashmi (Hospital Admin)", "hospital_admin", 1, "staff"],
        ["OPD-CHG-70518", hashCore5, "Jhon Jacob (OPD)", "receptionist", 1, "staff"],
        ["DR-CHG-49545", hashCore5, "Shubham (Doctor)", "doctor", 1, "staff"],
        ["NR-CHG-88859", hashCore5, "Dipti (Nurse)", "nurse", 1, "staff"],
        ["PH-44433", hashPhar, "Pharmacist", "pharmacist", 1, "staff"],
        ["CH-ADM-001", hash, "Hospital Admin", "hospital_admin", 1, "staff"],
        ["DR-001", passHash, "Dr. Sharma", "doctor", 1, "staff"],
        ["PH-001", passHash, "Pharmacist Verma", "pharmacist", 1, "staff"],
        ["REC-001", passHash, "Front Desk Receptionist", "receptionist", 1, "staff"],
        ["NUR-001", passHash, "Nurse Sister Mary", "nurse", 1, "staff"],
      ];

      for (const [uId, uHash, fName, uRole, hId, accType] of defaultUsers) {
        const [[{ cntU }]] = await connection.query("SELECT COUNT(*) AS cntU FROM users WHERE user_id = ?", [uId]);
        if (cntU === 0) {
          await connection.query(
            "INSERT INTO users (user_id, password_hash, full_name, role, hospital_id) VALUES (?, ?, ?, ?, ?)",
            [uId, uHash, fName, uRole, hId]
          );
        }
        const [[{ cntDir }]] = await connection.query("SELECT COUNT(*) AS cntDir FROM user_directory WHERE user_id = ?", [uId]);
        if (cntDir === 0) {
          await connection.query(
            "INSERT INTO user_directory (user_id, hospital_id, account_type) VALUES (?, ?, ?)",
            [uId, hId, accType]
          );
        }
      }

      // 4. Seed Patients
      const patients = [
        ["PAT-CHG-0002", "ASHISH", hashCore5, 1],
        ["PAT-CHG-0003", "Vikram", hashCore5, 1],
        ["PAT-CHG-0004", "NITISH", hashCore5, 1],
      ];

      for (const [uhid, pName, pHash, hId] of patients) {
        const [[{ cntP }]] = await connection.query("SELECT COUNT(*) AS cntP FROM patients WHERE uhid = ?", [uhid]);
        if (cntP === 0) {
          await connection.query(
            "INSERT INTO patients (uhid, full_name, password_hash, hospital_id) VALUES (?, ?, ?, ?)",
            [uhid, pName, pHash, hId]
          );
        }
        const [[{ cntDirP }]] = await connection.query("SELECT COUNT(*) AS cntDirP FROM user_directory WHERE user_id = ?", [uhid]);
        if (cntDirP === 0) {
          await connection.query(
            "INSERT INTO user_directory (user_id, hospital_id, account_type) VALUES (?, ?, 'patient')",
            [uhid, hId]
          );
        }
      }

      // 5. Sync hospital_id between users, patients, and user_directory, and normalize
      // the demo accounts' passwords we just created above.
      await connection.query('UPDATE users u JOIN user_directory d ON u.user_id = d.user_id SET u.hospital_id = d.hospital_id');
      await connection.query('UPDATE patients p JOIN user_directory d ON p.uhid = d.user_id SET p.hospital_id = d.hospital_id');
      await connection.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashPhar, 'PH-44433']);
      await connection.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashCore5, 'AD-CHG-64701']);
      await connection.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashCore5, 'OPD-CHG-70518']);
      await connection.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashCore5, 'DR-CHG-49545']);
      await connection.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashCore5, 'NR-CHG-88859']);
      await connection.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hashCore5, 'C5-202226']);
      await connection.query('UPDATE patients SET password_hash = ? WHERE uhid IN (?, ?, ?)', [hashCore5, 'PAT-CHG-0002', 'PAT-CHG-0003', 'PAT-CHG-0004']);
    }

  } catch (err) {
    console.error("Error seeding default users:", err.message);
  }
}

module.exports = { ensureSchema, seedTestCatalog, seedBillingTariff };
