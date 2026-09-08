// CSV/XLSX data import pipeline — hospital admin only. Mounted at /api/import
// in server.js (`app.use("/api/import", require("./importRoutes"))`) plus one
// sibling route server.js defines directly (GET /api/hospitals/:id/custom-fields,
// since that's also read by the login-time /api/me-adjacent screens, not just
// this pipeline).
//
// Flow: upload -> stage every row untouched (import_staging_rows) -> fuzzy-match
// headers against schemaRegistry.js with Fuse.js -> admin confirms/edits the
// mapping (or a saved mapping from a prior upload of the same source_name is
// reused automatically) -> commit applies it inside one DB transaction, with
// Ajv validating each row first. Anything that doesn't match a real column
// becomes a hospital-scoped custom field (hospital_custom_fields) and its
// value goes into that row's extra_fields JSON column — never dropped, unless
// an admin explicitly marks a field "ignored" at the mapping step.
const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const Papa = require("papaparse");
const XLSX = require("xlsx");
const Fuse = require("fuse.js");
const Ajv = require("ajv");
const masterPool = require("./db");
const { getHospitalPool } = require("./dbRouter");
const bcrypt = require("bcrypt");
const { getEntity, listEntities, MULTI_ENTITY_TABLE_NAME_MAP, MULTI_ENTITY_TIERS, MULTI_ENTITY_AUTO_SKIP_TABLES } = require("./schemaRegistry");
const { applyTransform, looksLikeDate, looksLikeNumber, looksLikeBoolean } = require("./importTransforms");
const { generateUhid, generateTempPassword, generateStaffUserId } = require("./credentials");
const { ROLE_PREFIXES, ROLE_LABELS, DESIGNATION_PREFIXES } = require("./roles");
const { detectRoleColumn, detectBestRoleColumnForRows, classifyRow, CLASSIFIABLE_ENTITIES } = require("./roleClassifier");

// A batch behaves like "auto" (bucketed, per-entity mapping+commit calls,
// reclassify-eligible) whether it was sorted by the role-column classifier
// ("auto") or by an exact table_name column ("multi") — see
// detectMultiEntityBatch below. Centralized here so every route that special-
// cases "auto" doesn't have to separately remember to also check "multi".
function isBucketedBatch(targetEntity) {
  return targetEntity === "auto" || targetEntity === "multi";
}

const router = express.Router();
const ajv = new Ajv({ allErrors: true, strict: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function requireHospitalAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "hospital_admin") {
    return res.status(401).json({ success: false, message: "Hospital admin session required." });
  }
  try {
    req.db = await getHospitalPool(req.session.user.hospitalId);
    return next();
  } catch (err) {
    console.error("Hospital pool lookup error:", err.message);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
}

// GET /field-usage/:entity below is a cross-hospital view (by design — its
// whole purpose is spotting a custom field common across many hospitals, to
// decide if it should graduate into schemaRegistry.js), so it's a platform-
// owner concern, not a hospital admin one — same superadmin-only bar as
// GET /api/hospitals in server.js, not requireHospitalAdmin like everything
// else in this file.
function requireSuperadmin(req, res, next) {
  if (req.session.user && req.session.user.role === "superadmin") return next();
  return res.status(401).json({ success: false, message: "Superadmin session required." });
}

// ---------- File parsing ----------

function parseUploadedFile(buffer, originalName) {
  const ext = (originalName.split(".").pop() || "").toLowerCase();
  if (ext === "csv" || ext === "txt") {
    const result = Papa.parse(buffer.toString("utf8"), {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    return { rows: result.data, headers: result.meta.fields || [] };
  }
  // xlsx/xls — first sheet only; a multi-sheet workbook is out of scope for v1.
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }).map((row) => {
    const trimmed = {};
    Object.keys(row).forEach((k) => (trimmed[k.trim()] = row[k]));
    return trimmed;
  });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { rows, headers };
}

// ---------- Fuzzy header matching (Fuse.js) ----------

function buildFuseIndex(entityDef) {
  const items = entityDef.fields.map((f) => ({
    key: f.key,
    label: f.label,
    haystack: [f.key, f.label, ...(f.aliases || [])].join(" "),
    isIdLike: !!f.ref || /_id$/i.test(f.key) || f.key === "id",
  }));
  return new Fuse(items, { keys: ["haystack"], includeScore: true, threshold: 0.45, ignoreLocation: true });
}

// Returns one of "matched" (high confidence), "suggested" (plausible, wants
// admin eyes), or "unmatched" (no real-column guess at all — this is the
// default-safe bucket that becomes a hospital custom field).
function matchHeader(fuseIndex, header) {
  const results = fuseIndex.search(header.trim());
  if (results.length === 0) return { matchType: "unmatched", targetField: null, targetLabel: null, score: null };
  // A header that's an exact (case-insensitive) match for a field's own KEY
  // or LABEL always wins outright, regardless of what Fuse scored it — real
  // bug found 2026-09-02: Fuse scores a query against an entity's WHOLE
  // aliases blob, not a plain substring check, so a header that's a literal
  // exact match for one field (e.g. "phone" for patients.phone) can still
  // score WORSE than a longer, unrelated field whose alias list happens to
  // also contain that same word among several others (patients
  // .emergency_contact_phone's aliases include "emergency phone" — "phone"
  // scored 0.087 against THAT whole haystack vs 0.124 against phone's own,
  // shorter one — an inversion that silently put a patient's actual phone
  // number into their emergency-contact field instead).
  const h = header.trim().toLowerCase();
  const exactMatch = results.find((r) => r.item.key.toLowerCase() === h || r.item.label.toLowerCase() === h);
  if (exactMatch) return { matchType: "matched", targetField: exactMatch.item.key, targetLabel: exactMatch.item.label, score: 0 };

  // An "_id"-suffixed header is a reference/identifier — never a plausible
  // match for a plain descriptive/quantity field whose own key doesn't ALSO
  // look like an id (a real `ref` field, or a key ending in "_id"/literally
  // "id"). Real bug found 2026-09-03: "donor_id" fuzzy-matched
  // blood_patient_donations' "donor_name" (textually similar, semantically
  // wrong — a row reference is not a person's name), and "unit_id" matched
  // "units" (a reference is not a quantity) — both would have silently
  // written a meaningless number into the wrong kind of field. Filtered out
  // before picking the best remaining candidate, since raw text similarity
  // doesn't imply "the same kind of data" — an unmatched "_id" column still
  // isn't lost, it becomes a custom field like anything else unmatched.
  const isIdHeader = /_id$/i.test(h) || h === "id";
  let candidates = isIdHeader ? results.filter((r) => r.item.isIdLike) : results;
  // Real bug found 2026-09-03: "assigned_unit_id" (which BLOOD UNIT was
  // issued) was the only isIdLike candidate for blood_requests, so it always
  // won by elimination and got auto-mapped to "assigned_staff_id" (which
  // STAFF member is handling the request) — a real but completely
  // unrelated FK column, silently writing a blood-unit reference into a
  // staff column. Being the sole isIdLike candidate isn't evidence of a
  // real semantic match, so id-suffixed headers additionally need every
  // meaningful word of the header (minus the trailing "_id") to actually
  // appear somewhere in the candidate's key/label/aliases — "unit" isn't
  // anywhere in assigned_staff_id's "assigned_staff_id Assigned Staff
  // assigned staff assigned to", so it's correctly rejected down to
  // unmatched (a custom field) instead of forced onto the wrong column.
  if (isIdHeader && candidates.length > 0) {
    const stemTokens = h.replace(/_id$/, "").split(/[_\s]+/).filter(Boolean);
    const withWordOverlap = candidates.filter((r) => {
      const hay = r.item.haystack.toLowerCase();
      return stemTokens.every((t) => hay.includes(t));
    });
    if (withWordOverlap.length > 0) candidates = withWordOverlap;
    else candidates = [];
  }
  if (candidates.length === 0) return { matchType: "unmatched", targetField: null, targetLabel: null, score: null };

  const best = candidates[0];
  const matchType = best.score <= 0.15 ? "matched" : "suggested";
  return { matchType, targetField: best.item.key, targetLabel: best.item.label, score: best.score };
}

function inferFieldType(sampleValues) {
  const nonEmpty = sampleValues.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonEmpty.length === 0) return "string";
  if (nonEmpty.every(looksLikeBoolean)) return "boolean";
  if (nonEmpty.every(looksLikeNumber)) return "number";
  if (nonEmpty.every(looksLikeDate)) return "date";
  return "string";
}

// Where a field's value ends up at commit time. Explicit on a field when it
// matters ("column" for the three real `users` columns on a staff entity,
// "department" for the doctor-only department lookup); everything else
// defaults by entity: patients/hospitals fields are all real table columns,
// while a staff entity's role-specific fields (specialization, shift, ...)
// have nowhere to live but the shared `details` JSON blob.
function fieldStorage(entityDef, fieldDef) {
  return fieldDef.storage || (entityDef.table === "users" ? "details" : "column");
}

// ---------- Ajv validation ----------
//
// Only "column"-storage fields are validated — those are the ones with a
// real DB constraint (NOT NULL, a fixed VARCHAR width) that can actually
// fail. A "details"-storage field (e.g. a doctor's specialization) has
// nowhere to violate a constraint — it's freeform JSON — so requiring it
// here would just be validation theater.
const ajvSchemaCache = {};
function getAjvValidator(entityName, entityDef) {
  if (ajvSchemaCache[entityName]) return ajvSchemaCache[entityName];
  const properties = {};
  const required = [];
  entityDef.fields.forEach((f) => {
    if (fieldStorage(entityDef, f) !== "column") return;
    if (f.type === "number") properties[f.key] = { type: ["number", "null"] };
    else if (f.type === "boolean") properties[f.key] = { type: ["boolean", "null"] };
    else if (f.required) properties[f.key] = { type: "string", minLength: 1 };
    else properties[f.key] = { type: ["string", "null"] };
    // A closed set of valid values (e.g. patient_charges.source_type) fails
    // staging-time validation with a clear per-row error — same mechanism as
    // "missing required field" — instead of silently writing a value nothing
    // downstream can resolve or join against. Only used with `required`
    // fields so far, so no non-required/null case to also allow here.
    if (f.enum) properties[f.key].enum = f.enum;
    if (f.required) required.push(f.key);
  });
  const validate = ajv.compile({ type: "object", properties, required, additionalProperties: true });
  ajvSchemaCache[entityName] = validate;
  return validate;
}

// Builds the field-mapping report for ONE entity against a set of rows: for
// every header, either reuse a mapping saved from a prior upload with the
// same source_name (so a recurring feed doesn't ask twice), or fuzzy-match
// it against the entity's schema with Fuse.js. Shared by the plain
// single-entity upload, each auto-detected bucket, and POST /:batchId/reclassify.
//
// Real bug found and fixed 2026-09-02: each header was fuzzy-matched to a
// target field completely independently, with nothing stopping TWO different
// headers from both landing on the same target field (e.g. a wide multi-table
// export had "full_name", "name", AND "department_name" all fuzzy-match onto
// the patients "full_name" column). At commit time, whichever header sorted
// last silently overwrote the others — for one real import this put
// department names into patients' full_name field, and (far worse) blanked
// out the real name on ~10,000 rows entirely, failing them on "full_name
// required". Now the best-scoring header wins each target field and every
// other contender for that field is downgraded to an unmatched/extra_field
// suggestion instead of silently colliding.
async function buildFieldReport(db, hospitalId, sourceName, targetEntity, entityDef, headers, rows) {
  const [savedMappings] = await db.query(
    `SELECT source_field, target_field, target_type, transform_fn FROM import_field_mappings
     WHERE hospital_id = ? AND source_name = ? AND target_entity = ?`,
    [hospitalId, sourceName, targetEntity]
  );
  const savedByField = new Map(savedMappings.map((m) => [m.source_field, m]));

  const fuseIndex = buildFuseIndex(entityDef);
  const claimedBySaved = new Set(savedMappings.map((m) => m.target_field).filter(Boolean));

  // Pass 1: propose a match for every header that doesn't already have a
  // saved (explicitly-confirmed) mapping — saved mappings always win their
  // target field outright, no contest.
  const proposals = headers.map((header) => {
    const saved = savedByField.get(header);
    if (saved) return { header, saved };
    return { header, match: matchHeader(fuseIndex, header) };
  });

  // Pass 2: among the fresh (non-saved) proposals, group by target field and
  // keep only the best one per field — everyone else who fuzzy-matched the
  // same field loses and falls back to unmatched. "Best" is: an exact
  // header==field-key match always wins outright, THEN lowest Fuse score —
  // verified against a real collision where "full_name" and "name" scored
  // identically for the patients "full_name" field, but only "full_name"
  // actually held the data (the "name" column was blank on every real
  // patient row, populated for other record types in the same wide file
  // instead). A plain score comparison alone would have picked whichever
  // header happened to sort first in the CSV — the exact-match check is
  // what makes this deterministic and correct regardless of column order.
  const winnerByField = new Map(); // targetField -> { header, score, exact }
  proposals.forEach(({ header, saved, match }) => {
    if (saved || !match || match.matchType === "unmatched" || claimedBySaved.has(match.targetField)) return;
    const exact = header.trim().toLowerCase() === String(match.targetField).toLowerCase();
    const current = winnerByField.get(match.targetField);
    const isBetter = !current || (exact && !current.exact) || (exact === current.exact && match.score < current.score);
    if (isBetter) winnerByField.set(match.targetField, { header, score: match.score, exact });
  });

  const fields = proposals.map(({ header, saved, match }) => {
    const samples = rows.slice(0, 5).map((r) => r[header]);
    if (saved) {
      return {
        sourceHeader: header,
        matchType: "saved",
        targetField: saved.target_field,
        targetLabel: saved.target_field ? (entityDef.fields.find((f) => f.key === saved.target_field)?.label || saved.target_field) : null,
        targetType: saved.target_type,
        sampleValues: samples,
      };
    }
    const wonField = match.matchType !== "unmatched" && winnerByField.get(match.targetField)?.header === header;
    if (match.matchType === "unmatched" || !wonField) {
      return { sourceHeader: header, matchType: "unmatched", targetField: null, targetLabel: null, targetType: "extra_field", sampleValues: samples };
    }
    return {
      sourceHeader: header,
      matchType: match.matchType,
      targetField: match.targetField,
      targetLabel: match.targetLabel,
      targetType: "column",
      sampleValues: samples,
    };
  });

  const allSavedFromHistory = headers.length > 0 && headers.every((h) => savedByField.has(h));
  return {
    fields,
    allSavedFromHistory,
    knownFields: entityDef.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required })),
  };
}

// ---------- Whole-file entity fit scoring (single-entity auto-detection) ----------
//
// Distinct from roleClassifier.js's PER-ROW category-value classification —
// this looks at the file's HEADER SET as a whole and asks "does this file
// look like table X?", for every entity in schemaRegistry.js, not just
// Patient/Staff. Exists because a single-table file with no table_name
// column (see detectMultiEntityBatch below) and no per-row category column
// that's actually ABOUT PEOPLE — e.g. billing_tariff.csv, whose only
// column that happens to match a ROLE_COLUMN_ALIASES name is "category",
// full of department labels like "OPD"/"Lab"/"Pharmacy" — used to fall
// straight into roleClassifier.js's patient/staff sorter, which has no
// concept of a billing tariff and would fuzzy-misread those department
// labels as staff role names (verified against a real import: 71 billing
// rows got sorted into fake Patient/Pharmacist/Pathologist/Blood-Bank-Staff
// buckets, then failed for having no "Full Name" column — there never was
// one, because the file was never about people). Tried BEFORE the
// patient/staff classifier for exactly that reason.
function scoreEntityFit(entityDef, headers) {
  const requiredFields = entityDef.fields.filter((f) => f.required);
  // Nothing to score against (e.g. "hospitals", whose fields are all
  // optional — a hospital admin always has exactly one facility record
  // regardless of what a file contains) — never a candidate for this.
  if (requiredFields.length === 0) return null;

  const fuseIndex = buildFuseIndex(entityDef);
  const requiredKeys = new Set(requiredFields.map((f) => f.key));
  const matchedRequiredKeys = new Set();
  const matchedHeaders = []; // every header that confidently matched ANY field, not just required ones — for the admin-facing "why" message
  for (const header of headers) {
    const m = matchHeader(fuseIndex, header);
    // "matched" (score <= 0.15) or "suggested" (<= 0.45) both count here —
    // deliberately looser than the strict "matched" bar the mapping table
    // itself uses to auto-fill a dropdown with no admin review. Fuse scores
    // a query against an entity's WHOLE aliases blob, not a plain substring
    // check, so even a header that's an exact alias in the list (e.g.
    // "service_name" literally in billing_tariff.charge_head's aliases)
    // often lands in "suggested" territory once mixed in among the field's
    // other aliases — verified against a real file where the strict bar
    // left charge_head unmatched at 0.168, just over the 0.15 cutoff, and
    // undercounted an otherwise obvious fit. Any real Fuse hit at all is
    // "confident enough to count as evidence for the fit score" — the
    // threshold+margin checks below are what actually decide whether the
    // score adds up to a safe auto-selection, not this per-field bar.
    if (m.matchType !== "unmatched") {
      matchedHeaders.push(header);
      if (requiredKeys.has(m.targetField)) matchedRequiredKeys.add(m.targetField);
    }
  }
  return {
    score: matchedRequiredKeys.size / requiredFields.length,
    matchedRequiredCount: matchedRequiredKeys.size,
    totalRequired: requiredFields.length,
    matchedHeaders,
  };
}

// At least this fraction of an entity's required fields must have a
// confident header match before it's even considered a candidate...
const ENTITY_FIT_THRESHOLD = 0.75;
// ...AND it must beat the next-best entity by at least this much, or it's
// treated as ambiguous rather than guessed at. This is what keeps a genuine
// mixed patients+staff file safe: every staffRole entity shares the same two
// required fields (full_name, email), so they always tie with each other at
// the same score on a file that has both columns, and patients (needing only
// full_name) ties with all of them too whenever full_name is present —
// exactly the "too close to call" case this margin is built to catch,
// correctly falling through to the classifier below instead of guessing.
const ENTITY_FIT_MARGIN = 0.2;

// Scores every registered entity against this header set and returns them
// sorted best-first (score > 0 only) — the full ranked list, with no
// threshold/ambiguity decision applied yet. Shared by detectSingleEntityByFit
// (which DOES apply that decision) and the "couldn't confidently tell what
// this file is" error response, which shows the admin the top few near-misses
// instead of a bare "no idea" message.
function scoreAllEntities(headers) {
  const scored = [];
  for (const key of listEntities()) {
    const def = getEntity(key);
    const fit = scoreEntityFit(def, headers);
    if (fit && fit.score > 0) scored.push({ key, def, ...fit });
  }
  // Primary: ratio of required fields matched. Tie-break: the ABSOLUTE count
  // of required fields matched — an entity with 2-of-2 required fields
  // confidently matched is stronger, more specific evidence than one with
  // just 1-of-1, even though both ratios are 100%. Verified against a real
  // ambiguous case: a beds.csv (hospital_id, ward_id, bed_number, status)
  // where "wards" only requires `name`, and a stray "ward_id" header
  // coincidentally suggest-matched it at 100%, while "beds" genuinely needing
  // BOTH ward_id AND bed_number — and getting both, at a much tighter match —
  // is the obviously better answer; ranking by ratio alone left them tied.
  scored.sort((a, b) => b.score - a.score || b.matchedRequiredCount - a.matchedRequiredCount);
  return scored;
}

// Looks at EVERY registered entity and finds the single best fit for this
// file's whole header set, if there is one clearly best fit — otherwise null.
function detectSingleEntityByFit(headers) {
  const scored = scoreAllEntities(headers);
  const best = scored[0];
  if (!best || best.score < ENTITY_FIT_THRESHOLD) return null;
  const runnerUp = scored[1];
  if (!runnerUp) return best;
  const scoreGap = best.score - runnerUp.score;
  if (scoreGap >= ENTITY_FIT_MARGIN) return best;
  // The ratio alone doesn't clear the margin — only resolve this as "not
  // ambiguous after all" if the winner has STRICTLY more required-field
  // evidence in absolute terms (the beds-vs-wards case above). Deliberately
  // NOT a further tie-break on total matched headers (including optional
  // fields) beyond required-field count — that signal is too weak to safely
  // resolve a tie and risks a confident WRONG guess. Verified against a
  // second real case: a bills.csv whose only real signal is a "uhid" column,
  // which trivially ties EVERY entity that requires nothing but
  // patient_uhid (ipd_admissions, vitals, opd_visits, and more) at 100%/
  // 1-of-1 each; one of them happening to also weakly match some unrelated
  // OPTIONAL column doesn't make it the right answer, and guessing here
  // would be actively worse than asking — this file's actual best fit for
  // "bills" itself only scored 25%, nowhere near confident.
  if (best.matchedRequiredCount > runnerUp.matchedRequiredCount) return best;
  return null;
}

// Shared by a manually-picked single entity (the bottom of POST /upload) and
// an auto-detected one (detectSingleEntityByFit, above) — staging, field-
// mapping, and the batch status update are identical either way; only WHY
// this targetEntity was chosen differs, and that's surfaced by the caller.
async function stageSingleEntityBatch(db, hospitalId, batchId, sourceName, targetEntity, entityDef, parsed) {
  const stagingValues = parsed.rows.map((row, i) => [batchId, i + 1, JSON.stringify(row), "pending"]);
  await db.query(`INSERT INTO import_staging_rows (batch_id, row_num, raw_data, status) VALUES ?`, [stagingValues]);

  const report = await buildFieldReport(db, hospitalId, sourceName, targetEntity, entityDef, parsed.headers, parsed.rows);
  await db.query(`UPDATE import_batches SET status = ? WHERE id = ?`, [report.allSavedFromHistory ? "ready" : "mapping", batchId]);

  return {
    status: report.allSavedFromHistory ? "ready" : "mapping",
    fields: report.fields,
    sampleRows: parsed.rows.slice(0, 5),
    knownFields: report.knownFields,
    // "hospitals" is a singleton — see the comment at the original call site
    // below for why more than one row targeting it is almost always a
    // mistake. Kept here even though detectSingleEntityByFit can never
    // auto-pick "hospitals" (it has no required fields to score), since a
    // manual pick still reaches this same function.
    singleRowEntityWarning: targetEntity === "hospitals" && parsed.rows.length > 1,
  };
}

// ---------- Multi-entity single-file import (a "table_name" column spanning
// every MEDISYS table, e.g. a full-database-export style CSV) ----------
//
// Detected inside the existing "auto" upload flow, before the role-column
// classifier ever runs — see the isAuto branch in POST /upload below. Kept
// entirely separate from roleClassifier.js's fuzzy matching: table_name is
// the one reliable signal this kind of file carries, so it's matched exactly,
// never fuzzily (see detectMultiEntityBatch's own comment for why).

const TABLE_NAME_COLUMN_ALIASES = ["table_name", "table", "source_table", "entity", "entity_name", "record_type", "dataset", "source_table_name"];

function detectTableNameColumn(headers) {
  if (!headers) return null;
  return headers.find((h) => TABLE_NAME_COLUMN_ALIASES.includes(h.trim().toLowerCase())) || null;
}

// Exact (case-insensitive) match only, per the feature spec — a coincidental
// fuzzy match here would risk hijacking an ordinary single-entity file that
// happens to have a similarly-named column. Requires at least 2 DISTINCT
// RECOGNIZED table names to be present — that's the real signal this is a
// multi-table export, and a single matching value alone is indistinguishable
// from a normal file that happens to have a column with this name (e.g. a
// plain patient list with a "record_type" column that just says "patient" on
// every row — which wouldn't even exact-match the "patients" table name
// anyway). Deliberately NOT "every distinct value must resolve" — real bug
// found 2026-09-02: a genuine full-database-export style file has ~44 real
// tables, but MULTI_ENTITY_TABLE_NAME_MAP only curates ~31 of them (plenty
// of real ones — nurse_shift_roster, user_directory, disease_alerts,
// telemedicine_payments, payment_orders, doctor_calendar_availability — were
// simply never added). Requiring EVERY value to match meant a single row of
// a table this registry doesn't model yet (or a typo) rejected the WHOLE
// file, silently falling back to the old category classifier being forced
// onto an unrelated wide column set — the exact failure mode this feature
// was built to prevent, just one step removed. Whatever doesn't match a
// known entity still lands in the existing "Unclassified" bucket per row
// (see classifyMultiEntityRows/stageMultiEntityBatch), same safety net an
// unrecognized role/category value already gets on the plain auto-detect
// path — never silently dropped, just surfaced for the admin to resolve.
function detectMultiEntityBatch(headers, rows) {
  const column = detectTableNameColumn(headers);
  if (!column) return null;
  const distinctValues = new Set();
  for (const row of rows) {
    const raw = row[column];
    const value = raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
    if (value) distinctValues.add(value);
  }
  const matchedValues = [...distinctValues].filter(
    (v) => v === "users" || MULTI_ENTITY_TABLE_NAME_MAP[v] || MULTI_ENTITY_AUTO_SKIP_TABLES.has(v)
  );
  if (matchedValues.length < 2) return null;
  return { tableNameColumn: column };
}

// Sentinel entity value for a row whose table_name is in
// MULTI_ENTITY_AUTO_SKIP_TABLES (schemaRegistry.js) — recognized, but
// deliberately never staged as a real bucket or counted as "unclassified".
// Never a real entity key (getEntity() returns null for it, same as any
// other unknown key), so it can't accidentally collide with a real table.
const AUTO_SKIP_MARKER = "__auto_skip__";

// Sorts every row by its own table_name value into the registry entity key it
// commits as. table_name="users" is special-cased through the EXISTING
// role-column classifier (server/roleClassifier.js) rather than
// MULTI_ENTITY_TABLE_NAME_MAP, since "users" isn't one entity — which of the
// 7 staff roles a users row is depends on that row's own role/designation
// column, exactly like a normal auto-detect mixed-staff file.
function classifyMultiEntityRows(rows, tableNameColumn, headers) {
  // Scoped to just the "users" rows (see detectBestRoleColumnForRows's own
  // comment) — a data-driven pick among plausible role-column-NAME
  // candidates, tried against the actual row values, instead of a single
  // name-only guess for the whole file that a wide multi-table export can
  // easily fool (role/category/type/designation are all real
  // ROLE_COLUMN_ALIASES, and a wide file very plausibly has several of them
  // belonging to entirely different tables).
  const usersRows = rows.filter((row) => {
    const raw = row[tableNameColumn];
    return raw !== null && raw !== undefined && String(raw).trim().toLowerCase() === "users";
  });
  const roleColumn = usersRows.length > 0 ? detectBestRoleColumnForRows(usersRows, headers) : null;
  return rows.map((row, i) => {
    const rawTable = row[tableNameColumn];
    const tableValue = rawTable === null || rawTable === undefined ? "" : String(rawTable).trim().toLowerCase();
    if (!tableValue) return { rowNum: i + 1, row, entity: null, label: "" };
    if (MULTI_ENTITY_AUTO_SKIP_TABLES.has(tableValue)) {
      return { rowNum: i + 1, row, entity: AUTO_SKIP_MARKER, label: String(rawTable) };
    }
    if (tableValue === "users") {
      const roleResult = roleColumn ? classifyRow(row[roleColumn]) : { entity: null, rawLabel: "" };
      return { rowNum: i + 1, row, entity: roleResult.entity, label: roleResult.rawLabel || "users" };
    }
    const entity = MULTI_ENTITY_TABLE_NAME_MAP[tableValue] || null;
    return { rowNum: i + 1, row, entity, label: String(rawTable) };
  });
}

function labelForEntity(entityKey, def) {
  if (def.label) return def.label;
  if (def.role) return ROLE_LABELS[entityKey] || entityKey;
  if (entityKey === "patients") return "Patient records";
  return entityKey;
}

// Stages every row (same import_staging_rows shape as a normal auto-detect
// batch), then builds one bucket per entity actually present in the file, in
// DEPENDENCY-TIER order (server/schemaRegistry.js MULTI_ENTITY_TIERS) rather
// than file/upload order — this ordering is what the frontend's existing
// bucket-commit loop (wireAutoActions in hospital/data-import.js) walks
// through, so hospitals/departments commit before patients/users, which
// commit before wards/beds/opd_visits, and so on, all the way through bills
// and payments — with zero frontend changes needed, since a "multi" batch
// produces the exact same { buckets: [...] } shape an "auto" batch always has.
async function stageMultiEntityBatch(db, hospitalId, batchId, sourceName, parsed, multi) {
  await db.query(`UPDATE import_batches SET target_entity = 'multi' WHERE id = ?`, [batchId]);

  const classified = classifyMultiEntityRows(parsed.rows, multi.tableNameColumn, parsed.headers);
  const stagingValues = classified.map((c) => [
    batchId,
    c.rowNum,
    JSON.stringify(c.row),
    // Auto-skip rows are marked 'skipped' immediately, same status an
    // admin's explicit Skip action already produces — there's no decision
    // left to make for them (see MULTI_ENTITY_AUTO_SKIP_TABLES), so they
    // never sit in "Unclassified" waiting on one.
    c.entity === AUTO_SKIP_MARKER ? "skipped" : "pending",
    c.entity,
    c.label ? String(c.label).slice(0, 150) : null,
  ]);
  await db.query(
    `INSERT INTO import_staging_rows (batch_id, row_num, raw_data, status, detected_entity, detection_label) VALUES ?`,
    [stagingValues]
  );

  const presentEntities = new Set(classified.map((c) => c.entity).filter(Boolean));
  const orderedEntities = [];
  const STAFF_ONLY = CLASSIFIABLE_ENTITIES.filter((e) => e !== "patients");
  for (const tier of MULTI_ENTITY_TIERS) {
    for (const key of tier) {
      if (key === "users") {
        STAFF_ONLY.forEach((role) => {
          if (presentEntities.has(role) && !orderedEntities.includes(role)) orderedEntities.push(role);
        });
      } else if (presentEntities.has(key) && !orderedEntities.includes(key)) {
        orderedEntities.push(key);
      }
    }
  }

  const buckets = [];
  for (const entityKey of orderedEntities) {
    const rowsForEntity = classified.filter((c) => c.entity === entityKey).map((c) => c.row);
    if (rowsForEntity.length === 0) continue;
    const def = getEntity(entityKey);
    if (!def) continue;
    // Keep only this group's own relevant columns — a wide multi-table export
    // has every OTHER table's columns blank for these rows; passing those
    // through would just invite pointless custom-field registrations for
    // columns this entity never actually uses (see commitEntityRows).
    // Also drop the multi-entity FORMAT's own structural columns
    // (table_name, id) — real bug found 2026-09-02: these are never blank
    // for a row (table_name always holds this bucket's own entity name, id
    // usually holds the CSV's own row number), so they always passed the
    // "relevant" filter above and got offered up for real field mapping like
    // any other column — table_name itself fuzzy-matched onto
    // patients.emergency_contact_name in one real case. Both are already
    // consumed directly from raw_data (classifyMultiEntityRows reads
    // table_name; registerCrossTierId reads "id") independent of this
    // mapping step, so excluding them here only removes noise, never data.
    const relevantHeaders = parsed.headers
      .filter((h) => h !== multi.tableNameColumn && h.trim().toLowerCase() !== "id")
      .filter((h) => rowsForEntity.some((r) => r[h] !== null && r[h] !== undefined && String(r[h]).trim() !== ""));
    const report = await buildFieldReport(db, hospitalId, sourceName, entityKey, def, relevantHeaders, rowsForEntity);
    // table_name remains the authoritative signal for WHICH bucket a row
    // lands in — this never changes that. It's a sanity check surfaced to
    // the admin: if this bucket's own required fields barely show up among
    // its own relevant columns, that's worth a second look (e.g. a renamed
    // or truncated column) before committing, even though the row-to-bucket
    // assignment itself is exact, not a guess.
    const fit = scoreEntityFit(def, relevantHeaders);
    buckets.push({
      entity: entityKey,
      entityLabel: labelForEntity(entityKey, def),
      rowCount: rowsForEntity.length,
      status: report.allSavedFromHistory ? "ready" : "mapping",
      fields: report.fields,
      sampleRows: rowsForEntity.slice(0, 5),
      knownFields: report.knownFields,
      fitScore: fit ? fit.score : null,
      fitWarning:
        fit && fit.score < ENTITY_FIT_THRESHOLD
          ? `Only ${fit.matchedRequiredCount} of ${fit.totalRequired} required field(s) for ${labelForEntity(entityKey, def)} were confidently matched in this file's columns — double-check the mapping below before importing.`
          : null,
    });
  }

  const unclassifiedRows = classified.filter((c) => !c.entity);
  if (unclassifiedRows.length > 0) {
    buckets.push({
      entity: null,
      entityLabel: "Unclassified",
      rowCount: unclassifiedRows.length,
      status: "needs_entity",
      needsReclassification: true,
      detectionLabels: [...new Set(unclassifiedRows.map((c) => c.label).filter(Boolean))].slice(0, 10),
      sampleRows: unclassifiedRows.slice(0, 5).map((c) => c.row),
    });
  }

  const allReady = buckets.every((b) => b.status === "ready");
  await db.query(`UPDATE import_batches SET status = ? WHERE id = ?`, [allReady ? "ready" : "mapping", batchId]);

  const tableBreakdown = {};
  const autoSkipped = {};
  classified.forEach((c) => {
    if (c.entity === AUTO_SKIP_MARKER) {
      // Shown separately (autoSkipped, below) rather than folded into
      // tableBreakdown — entityLabelFor on the frontend has no label for the
      // internal AUTO_SKIP_MARKER key, and this isn't really a "kind of
      // record" breakdown entry the same way a real entity count is.
      autoSkipped[c.label] = (autoSkipped[c.label] || 0) + 1;
      return;
    }
    const key = c.entity || "unclassified";
    tableBreakdown[key] = (tableBreakdown[key] || 0) + 1;
  });

  return { status: allReady ? "ready" : "mapping", tableNameColumn: multi.tableNameColumn, tableBreakdown, autoSkipped, buckets };
}

// ---------- POST /api/import/upload ----------

router.post("/upload", requireHospitalAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });

  const targetEntity = req.body.entity;
  const isAuto = targetEntity === "auto";
  const entityDef = isAuto ? null : getEntity(targetEntity);
  if (!isAuto && !entityDef) {
    return res.status(400).json({ success: false, message: `Unknown entity. Supported: auto, ${listEntities().join(", ")}.` });
  }
  const sourceName = (req.body.sourceName || req.file.originalname).trim();

  let parsed;
  try {
    parsed = parseUploadedFile(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ success: false, message: "Could not read this file — is it a valid CSV/XLSX?" });
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ success: false, message: "The file has no data rows." });
  }

  const { hospitalId, userId } = req.session.user;
  const batchUid = crypto.randomUUID();

  // ---------- Auto-detect: figure out WHICH signal applies BEFORE ever
  // creating a batch history row ----------
  //
  // A file none of the three signals (exact table_name column, whole-file
  // entity fit, role/category column) can resolve has nothing to stage at
  // all. This used to still INSERT an "uploaded" row, immediately flip it to
  // 'failed', and return a 400 whose message was never persisted anywhere —
  // the admin's only trace of it was a permanent "Failed" row in Import
  // History with no explanation and no Delete button (canDelete only allows
  // status='committed'), a dead end. Now nothing is written to
  // import_batches until we actually know there's something to stage.
  let multi = null;
  let singleFit = null;
  let roleColumn = null;
  if (isAuto) {
    // A "table_name" (or similarly-named) column whose values exactly match
    // known table names — e.g. a full-database-export style CSV — is a much
    // more reliable signal than the other two, and covers every table in the
    // app, not just patients/staff. Checked first.
    multi = detectMultiEntityBatch(parsed.headers, parsed.rows);
    // Next best signal: does the file's WHOLE header set confidently look
    // like exactly one known table? See detectSingleEntityByFit's own
    // comment for why this runs before the patient/staff classifier.
    if (!multi) singleFit = detectSingleEntityByFit(parsed.headers);
    if (!multi && !singleFit) roleColumn = detectRoleColumn(parsed.headers);

    if (!multi && !singleFit && !roleColumn) {
      // Genuinely nothing to go on — either the closest entity-fit
      // candidates were too ambiguous to safely auto-select (shown here so
      // the admin understands why, not just "no idea"), or nothing scored
      // at all AND there's no role/category column either. Either way, the
      // fix is the same: pick the correct type from the manual dropdown and
      // re-upload — no batch was created, so there's nothing to clean up.
      const candidates = scoreAllEntities(parsed.headers).slice(0, 3);
      const candidateText = candidates
        .map((c) => `${labelForEntity(c.key, c.def)} (${Math.round(c.score * 100)}%)`)
        .join(", ");
      return res.status(422).json({
        success: false,
        needsManualEntity: true,
        message: candidates.length
          ? `Couldn't confidently tell what kind of data this file is — the closest matches were ${candidateText}, but none was a clear enough fit to auto-select. Pick the correct type from "What are you importing?" and re-upload.`
          : "Couldn't tell what kind of data this file is, and it has no column that says what kind of record each row is (e.g. \"Role\", \"Type\", \"Designation\"). Pick a specific record type from \"What are you importing?\" and re-upload.",
        candidates: candidates.map((c) => ({ entity: c.key, label: labelForEntity(c.key, c.def), score: c.score })),
      });
    }
  }

  // Hoisted so the catch below can mark this batch 'failed' if something
  // throws partway through staging it — otherwise an unexpected error left
  // the row at whatever status it last reached (usually 'uploaded'), which
  // is just as much a dead end as the old "no role column" failure was:
  // canDelete only allows status='committed', so a batch stuck at
  // 'uploaded'/'mapping' forever had no Delete button either.
  let batchId;
  try {
    const [batchResult] = await req.db.query(
      `INSERT INTO import_batches (batch_uid, hospital_id, source_name, original_filename, target_entity, uploaded_by, status, total_rows)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?)`,
      [batchUid, hospitalId, sourceName, req.file.originalname, targetEntity, userId, parsed.rows.length]
    );
    batchId = batchResult.insertId;

    // ---------- Auto-detect (mixed dataset): sort rows into buckets first ----------
    if (isAuto) {
      if (multi) {
        const multiResult = await stageMultiEntityBatch(req.db, hospitalId, batchId, sourceName, parsed, multi);
        return res.json({
          success: true,
          batchId,
          batchUid,
          targetEntity: "multi",
          sourceName,
          status: multiResult.status,
          totalRows: parsed.rows.length,
          roleColumn: multiResult.tableNameColumn,
          roleBreakdown: multiResult.tableBreakdown,
          autoSkipped: multiResult.autoSkipped,
          buckets: multiResult.buckets,
        });
      }

      if (singleFit) {
        await req.db.query(`UPDATE import_batches SET target_entity = ? WHERE id = ?`, [singleFit.key, batchId]);
        const result = await stageSingleEntityBatch(req.db, hospitalId, batchId, sourceName, singleFit.key, singleFit.def, parsed);
        return res.json({
          success: true,
          batchId,
          batchUid,
          targetEntity: singleFit.key,
          sourceName,
          totalRows: parsed.rows.length,
          autoDetected: true,
          autoDetectReason: `Detected: ${labelForEntity(singleFit.key, singleFit.def)} — matched ${singleFit.matchedHeaders.join(", ")}`,
          ...result,
        });
      }

      // roleColumn is guaranteed truthy here — the "none of the three
      // signals resolved" case already returned above before any batch row
      // was created.
      // Classify every row up front, then stage each one with its detected
      // bucket already attached — this is the "sort it out" step, and it's
      // what a real dataset of "all types of users" needs before anything
      // can be imported into the right place.
      const classified = parsed.rows.map((row, i) => {
        const result = classifyRow(row[roleColumn]);
        return { rowNum: i + 1, row, entity: result.entity, label: result.rawLabel };
      });

      const stagingValues = classified.map((c) => [batchId, c.rowNum, JSON.stringify(c.row), "pending", c.entity, c.label || null]);
      await req.db.query(
        `INSERT INTO import_staging_rows (batch_id, row_num, raw_data, status, detected_entity, detection_label) VALUES ?`,
        [stagingValues]
      );

      const roleBreakdown = {};
      CLASSIFIABLE_ENTITIES.forEach((e) => (roleBreakdown[e] = 0));
      roleBreakdown.unclassified = 0;
      classified.forEach((c) => {
        if (c.entity) roleBreakdown[c.entity]++;
        else roleBreakdown.unclassified++;
      });

      const buckets = [];
      for (const entity of CLASSIFIABLE_ENTITIES) {
        const rowsForEntity = classified.filter((c) => c.entity === entity).map((c) => c.row);
        if (rowsForEntity.length === 0) continue;
        const def = getEntity(entity);
        const report = await buildFieldReport(req.db, hospitalId, sourceName, entity, def, parsed.headers, rowsForEntity);
        buckets.push({
          entity,
          entityLabel: def.role ? ROLE_LABELS[entity] || entity : entity === "patients" ? "Patient records" : entity,
          rowCount: rowsForEntity.length,
          status: report.allSavedFromHistory ? "ready" : "mapping",
          fields: report.fields,
          sampleRows: rowsForEntity.slice(0, 5),
          knownFields: report.knownFields,
        });
      }

      const unclassifiedRows = classified.filter((c) => !c.entity);
      if (unclassifiedRows.length > 0) {
        buckets.push({
          entity: null,
          entityLabel: "Unclassified",
          rowCount: unclassifiedRows.length,
          status: "needs_entity",
          needsReclassification: true,
          detectionLabels: [...new Set(unclassifiedRows.map((c) => c.label).filter(Boolean))].slice(0, 10),
          sampleRows: unclassifiedRows.slice(0, 5).map((c) => c.row),
        });
      }

      const allReady = buckets.every((b) => b.status === "ready");
      await req.db.query(`UPDATE import_batches SET status = ? WHERE id = ?`, [allReady ? "ready" : "mapping", batchId]);

      return res.json({
        success: true,
        batchId,
        batchUid,
        targetEntity: "auto",
        sourceName,
        status: allReady ? "ready" : "mapping",
        totalRows: parsed.rows.length,
        roleColumn,
        roleBreakdown,
        buckets,
      });
    }

    // ---------- Single explicit entity (existing behavior, unchanged) ----------
    // "hospitals" gets more-than-one-row-is-probably-a-mistake handling —
    // your hospital's own one facility record: a file with more than one row
    // targeting it doesn't add more rows, it just overwrites that same
    // record once per row, so only the LAST row survives. Almost always
    // means the wrong entity was picked (this is exactly what happened with
    // a 74-row "dummy user dataset" that silently collapsed into one row) —
    // see stageSingleEntityBatch's singleRowEntityWarning.
    const result = await stageSingleEntityBatch(req.db, hospitalId, batchId, sourceName, targetEntity, entityDef, parsed);
    res.json({ success: true, batchId, batchUid, targetEntity, sourceName, totalRows: parsed.rows.length, ...result });
  } catch (err) {
    console.error("Import upload error:", err.message);
    if (batchId) {
      try {
        await req.db.query(`UPDATE import_batches SET status = 'failed' WHERE id = ?`, [batchId]);
      } catch {
        /* best-effort status update — the 500 below still reports the real failure either way */
      }
    }
    res.status(500).json({ success: false, message: "Server error while staging the file. Please try again." });
  }
});

// ---------- POST /api/import/:batchId/reclassify ----------
//
// For the "Unclassified" bucket an auto-detect upload can produce: rather
// than ever silently dropping rows the classifier wasn't confident about,
// the admin explicitly picks what they actually are, and this computes that
// bucket's field-mapping report on demand (same as a normal bucket gets at
// upload time) so it can be reviewed and confirmed the same way.
router.post("/:batchId/reclassify", requireHospitalAdmin, async (req, res) => {
  const { targetEntity, skip } = req.body || {};

  try {
    const { hospitalId } = req.session.user;
    const [[batch]] = await req.db.query(`SELECT * FROM import_batches WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.batchId,
      hospitalId,
    ]);
    if (!batch) return res.status(404).json({ success: false, message: "Import batch not found." });
    if (!isBucketedBatch(batch.target_entity)) {
      return res.status(400).json({ success: false, message: "This action only applies to an auto-detected or multi-table import." });
    }

    const [rows] = await req.db.query(
      `SELECT id, raw_data FROM import_staging_rows WHERE batch_id = ? AND detected_entity IS NULL`,
      [batch.id]
    );
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: "There are no unclassified rows left in this import." });
    }

    // Explicitly discarding the unclassified rows — still the admin's
    // deliberate choice (never a default), matching the same rule as
    // "Ignore this column" at the per-field mapping step. The raw data stays
    // in import_staging_rows either way, just marked as never going anywhere.
    if (skip) {
      await req.db.query(`UPDATE import_staging_rows SET status = 'skipped', detected_entity = 'skipped' WHERE batch_id = ? AND detected_entity IS NULL`, [
        batch.id,
      ]);
      return res.json({ success: true, skipped: true, rowCount: rows.length });
    }

    const entityDef = getEntity(targetEntity);
    if (!entityDef) {
      return res.status(400).json({ success: false, message: `Unknown entity. Supported: ${listEntities().join(", ")}.` });
    }

    await req.db.query(`UPDATE import_staging_rows SET detected_entity = ? WHERE batch_id = ? AND detected_entity IS NULL`, [
      targetEntity,
      batch.id,
    ]);

    const headers = Object.keys(rows[0].raw_data);
    const report = await buildFieldReport(req.db, hospitalId, batch.source_name, targetEntity, entityDef, headers, rows.map((r) => r.raw_data));

    res.json({
      success: true,
      entity: targetEntity,
      rowCount: rows.length,
      status: report.allSavedFromHistory ? "ready" : "mapping",
      fields: report.fields,
      sampleRows: rows.slice(0, 5).map((r) => r.raw_data),
      knownFields: report.knownFields,
    });
  } catch (err) {
    console.error("Import reclassify error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// ---------- POST /api/import/:batchId/mapping ----------

router.post("/:batchId/mapping", requireHospitalAdmin, async (req, res) => {
  const { mappings } = req.body || {};
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return res.status(400).json({ success: false, message: "No mapping provided." });
  }

  try {
    const { hospitalId, userId } = req.session.user;
    const [[batch]] = await req.db.query(`SELECT * FROM import_batches WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.batchId,
      hospitalId,
    ]);
    if (!batch) return res.status(404).json({ success: false, message: "Import batch not found." });

    // An auto-detected or multi-table batch mixes several destinations in one
    // file, so the mapping being confirmed here is scoped to ONE bucket at a
    // time — the request says which. A plain single-entity batch has only
    // ever had one possible target, so it keeps working exactly as before
    // with no body change.
    const targetEntity = isBucketedBatch(batch.target_entity) ? req.body.targetEntity : batch.target_entity;
    const entityDef = getEntity(targetEntity);
    if (!entityDef) {
      return res.status(400).json({ success: false, message: "A valid targetEntity is required for this batch." });
    }

    // Catch a mapping that can never produce a valid row BEFORE committing —
    // e.g. no column mapped to Full Name means every single patient row will
    // fail at commit (the "349 rows uploaded, 0 imported" failure mode). Far
    // better to reject here with one clear, actionable message than to let
    // the admin discover it as a wall of identical per-row errors afterward.
    const requiredFields = entityDef.fields.filter((f) => f.required);
    const mappedColumnTargets = new Set(mappings.filter((m) => m.targetType === "column" && m.targetField).map((m) => m.targetField));
    // A required field with a `deriveFrom` (see schemaRegistry.js) doesn't
    // need its OWN column mapped, as long as at least one of the field(s) it
    // can derive from is — e.g. nurse_shift_roster.day_of_week is satisfied
    // by mapping a column to shift_date instead, and lab_orders.patient_uhid
    // is satisfied by mapping EITHER opd_visit_id OR ipd_admission_id (see
    // the deriveFrom pass in commitEntityRows, which tries each in order).
    const missingRequired = requiredFields.filter((f) => {
      if (mappedColumnTargets.has(f.key)) return false;
      if (f.deriveFrom) {
        const attempts = Array.isArray(f.deriveFrom) ? f.deriveFrom : [f.deriveFrom];
        if (attempts.some((a) => mappedColumnTargets.has(a.siblingField))) return false;
      }
      return true;
    });
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Map a column to ${missingRequired.map((f) => f.label).join(", ")} before importing — every row needs it and none will import without it.`,
      });
    }

    for (const m of mappings) {
      if (!m.sourceField) continue;
      // Default is always a real mapping (column or extra_field) — 'ignored'
      // only ever comes from an explicit choice in the request body, per the
      // "never silently drop data" rule; there's no code path that defaults
      // a field to 'ignored' on its own.
      const targetType = ["column", "extra_field", "ignored"].includes(m.targetType) ? m.targetType : "extra_field";
      await req.db.query(
        `INSERT INTO import_field_mappings (hospital_id, source_name, target_entity, source_field, target_field, target_type, transform_fn, confirmed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE target_field = VALUES(target_field), target_type = VALUES(target_type),
           transform_fn = VALUES(transform_fn), confirmed_by = VALUES(confirmed_by)`,
        [hospitalId, batch.source_name, targetEntity, m.sourceField, m.targetField || null, targetType, m.transformFn || null, userId]
      );
    }

    if (!isBucketedBatch(batch.target_entity)) {
      await req.db.query(`UPDATE import_batches SET status = 'ready' WHERE id = ?`, [batch.id]);
      return res.json({ success: true });
    }

    // Auto/multi mode: only flip to "ready" once every detected bucket has a
    // confirmed mapping AND no row is still sitting unclassified — an
    // unresolved "Unclassified" group must be explicitly reclassified or
    // explicitly skipped (see POST /:batchId/reclassify) before commit is
    // allowed, so nothing gets left behind without a deliberate decision.
    const [distinctEntities] = await req.db.query(
      `SELECT DISTINCT detected_entity FROM import_staging_rows WHERE batch_id = ?`,
      [batch.id]
    );
    const stillUnclassified = distinctEntities.some((r) => r.detected_entity === null);
    let allMapped = !stillUnclassified;
    if (allMapped) {
      for (const { detected_entity } of distinctEntities) {
        if (detected_entity === null || detected_entity === "skipped") continue;
        const [[existing]] = await req.db.query(
          `SELECT id FROM import_field_mappings WHERE hospital_id = ? AND source_name = ? AND target_entity = ? LIMIT 1`,
          [hospitalId, batch.source_name, detected_entity]
        );
        if (!existing) {
          allMapped = false;
          break;
        }
      }
    }
    await req.db.query(`UPDATE import_batches SET status = ? WHERE id = ?`, [allMapped ? "ready" : "mapping", batch.id]);
    res.json({ success: true, allMapped });
  } catch (err) {
    console.error("Import mapping error:", err.message);
    res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// A 400-worthy problem (bad request state), as opposed to an unexpected
// server error — lets the route handler pick the right status code without
// commitEntityRows needing to know about Express at all.
class ImportUserError extends Error {}

// Commits every staged row for ONE entity bucket inside its own transaction —
// shared by the plain single-entity commit and each per-bucket commit an
// auto-detected import makes. Handles custom-field auto-registration, the
// overflow-redirect safety net, Ajv validation, and per-row dispatch to the
// right commit function for this entity, exactly as the single-entity path
// always has; entityName is what decides "the right function" now instead of
// it always being batch.target_entity.
function quoteIdent(name) {
  return `\`${name}\``;
}
function quoteTable(table) {
  return table.split(".").map(quoteIdent).join(".");
}

// Resolves a plain numeric-surrogate `ref` field's raw value: if this batch
// itself created the referenced row earlier in the same file, the id map has
// it (keyed by whatever the CSV used to identify that row — see
// registerCrossTierId); otherwise assume the raw value is already a real DB
// id (e.g. importing into a non-empty database that references rows that
// existed before this import ran). Never left as a non-numeric string —
// there's nothing else it could validly be at this point.
function resolveSurrogateRef(raw, refMap) {
  if (refMap && refMap.has(raw)) return refMap.get(raw);
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

// Resolves a `refKind: "business"` field (a users.user_id-shaped value, e.g.
// doctor_user_id): if this batch created that staff member earlier in the
// same file (registered under the CSV's own id column — see
// registerCrossTierId), resolve to their real generated user_id; otherwise
// assume the raw value is already a real, pre-existing user_id (the far more
// common case — referencing a doctor onboarded before this import ran) and
// pass it straight through unchanged, exactly like a plain business-key field
// (patient_uhid) already does.
function resolveBusinessRef(raw, refMap) {
  return refMap && refMap.has(raw) ? refMap.get(raw) : raw;
}

// Registers a just-committed row's real id/business-key under every CSV-local
// identifier a LATER row in the same file might use to reference it: the
// row's own 1-based position within its entity group (works even when the
// file has no explicit id column), and, if the row's raw data has an "id"
// header, that literal value too (the more common real-world case for a
// database-export-style CSV that already numbers its own rows). Both keys
// point at the same real value, so either reference style resolves correctly.
function registerCrossTierId(idMapsRuntime, mapKey, csvPositionCounter, rawData, realValue) {
  const map = idMapsRuntime[mapKey] || (idMapsRuntime[mapKey] = new Map());
  map.set(String(csvPositionCounter), realValue);
  const idHeader = Object.keys(rawData).find((h) => h.trim().toLowerCase() === "id");
  if (idHeader) {
    const rawId = rawData[idHeader];
    if (rawId !== null && rawId !== undefined && String(rawId).trim() !== "") {
      map.set(String(rawId).trim(), realValue);
    }
  }
}

// Plain INSERT for every entity added by the multi-entity single-file import
// feature (departments, wards, opd_visits, bills, ... — anything with
// `kind: "generic"` in schemaRegistry.js). Unlike commitPatientRow/
// commitStaffRow there's no bespoke business logic: build the column list
// straight from entityDef.fields, resolving any `ref`/`dynamicRef` field
// against the cross-tier id map built up as earlier tiers commit (see
// commitEntityRows), write whatever the admin's header mapping didn't
// recognize into extra_fields exactly like patients/hospitals already do
// (never silently dropped), and let the real table's own DEFAULT apply to
// anything left unset instead of ever inserting an explicit NULL into a
// NOT-NULL-with-DEFAULT column.
async function commitGenericRow(connection, hospitalId, entityDef, columnValues, extraFieldValues, idMapsRuntime) {
  const columns = ["hospital_id"];
  const params = [hospitalId];
  for (const field of entityDef.fields) {
    // A `virtual` field (e.g. nurse_shift_roster.shift_date) exists purely
    // to receive a column mapping and feed a `deriveFrom` elsewhere (see the
    // deriveFrom pass in commitEntityRows) — the real table has no such
    // column, so it's never part of the actual INSERT.
    if (field.virtual) continue;
    let value = columnValues[field.key];
    if (value === undefined || value === "") value = null;
    if (value !== null && field.dynamicRef) {
      const siblingRaw = columnValues[field.dynamicRef.siblingField];
      const refEntity = siblingRaw ? field.dynamicRef.map[String(siblingRaw).trim().toLowerCase()] : null;
      value = resolveSurrogateRef(String(value).trim(), refEntity ? idMapsRuntime[refEntity] : null);
    } else if (value !== null && field.ref) {
      const raw = String(value).trim();
      const refMap = idMapsRuntime[field.ref];
      value = field.refKind === "business" ? resolveBusinessRef(raw, refMap) : resolveSurrogateRef(raw, refMap);
    }
    if (value === null) continue;
    columns.push(field.key);
    params.push(value);
  }
  if (Object.keys(extraFieldValues || {}).length) {
    columns.push("extra_fields");
    params.push(JSON.stringify(extraFieldValues));
  }
  const placeholders = columns.map(() => "?").join(", ");
  const [result] = await connection.query(
    `INSERT INTO ${quoteTable(entityDef.table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`,
    params
  );
  return result.insertId;
}

async function commitEntityRows(db, hospitalId, userId, batch, entityName, entityDef, stagingRows) {
  const [mappingRows] = await db.query(
    `SELECT source_field, target_field, target_type, transform_fn FROM import_field_mappings
     WHERE hospital_id = ? AND source_name = ? AND target_entity = ?`,
    [hospitalId, batch.source_name, entityName]
  );
  if (mappingRows.length === 0) {
    throw new ImportUserError("No field mapping found for this batch — confirm the mapping first.");
  }
  const mappingByField = new Map(mappingRows.map((m) => [m.source_field, m]));

  // Auto-register hospital-scoped custom fields for every extra_field-mapped
  // header BEFORE touching any row, inferring type from up to 50 sample
  // values across the whole file — this is the "no admin approval step"
  // auto-creation the feature is built around.
  const extraFieldHeaders = [...mappingByField.values()].filter((m) => m.target_type === "extra_field").map((m) => m.source_field);
  const customFieldsCreated = [];
  for (const header of extraFieldHeaders) {
    const samples = stagingRows.slice(0, 50).map((r) => r.raw_data[header]);
    const fieldType = inferFieldType(samples);
    await db.query(
      `INSERT INTO hospital_custom_fields (hospital_id, entity, field_key, field_label, field_type, auto_created, created_from_batch)
       VALUES (?, ?, ?, ?, ?, TRUE, ?)
       ON DUPLICATE KEY UPDATE field_label = field_label`,
      [hospitalId, entityName, header, header, fieldType, batch.id]
    );
    customFieldsCreated.push({ fieldKey: header, fieldType });
  }

  // A mapped column whose value would overflow the real DB column's width
  // must never crash the whole row — that's the "half the batch fails" bug
  // (e.g. a long value mapped onto a VARCHAR(20) column throws "Data too
  // long for column" and takes every other valid field in that row down
  // with it). Only applies to "column"-storage fields (a "details"-storage
  // field has no fixed width to overflow — it's freeform JSON). Scan every
  // row's value for each column-mapped header up front and, if ANY row
  // would overflow, treat that header as an extra_field for this whole
  // commit instead (auto-registering a custom field for it).
  const fieldsAutoRedirected = [];
  for (const [header, mapping] of mappingByField.entries()) {
    if (mapping.target_type !== "column" || !mapping.target_field) continue;
    const fieldDef = entityDef.fields.find((f) => f.key === mapping.target_field);
    if (!fieldDef || !fieldDef.maxLength || fieldStorage(entityDef, fieldDef) !== "column") continue;
    const transformName = mapping.transform_fn || fieldDef.transform;
    const overflows = stagingRows.some((r) => {
      const raw = r.raw_data[header];
      const value = transformName ? applyTransform(transformName, raw) : raw;
      return value !== null && value !== undefined && String(value).length > fieldDef.maxLength;
    });
    if (!overflows) continue;

    mappingByField.set(header, { ...mapping, target_type: "extra_field", target_field: null });
    const samples = stagingRows.slice(0, 50).map((r) => r.raw_data[header]);
    const fieldType = inferFieldType(samples);
    await db.query(
      `INSERT INTO hospital_custom_fields (hospital_id, entity, field_key, field_label, field_type, auto_created, created_from_batch)
       VALUES (?, ?, ?, ?, ?, TRUE, ?)
       ON DUPLICATE KEY UPDATE field_label = field_label`,
      [hospitalId, entityName, header, header, fieldType, batch.id]
    );
    customFieldsCreated.push({ fieldKey: header, fieldType });
    fieldsAutoRedirected.push({ fieldKey: header, targetField: fieldDef.key, targetLabel: fieldDef.label, maxLength: fieldDef.maxLength });
  }

  // ---------- Multi-entity cross-tier id map ----------
  // Meaningful for ANY entity in a target_entity='multi' batch — not just
  // `kind: "generic"` ones: patients (real numeric patients.id, needed to
  // resolve patient_charges.source_id when source_type='registration') and
  // staff (their real generated user_id, needed for a later row's
  // doctor_user_id/assigned_nurse_id to reference a doctor/nurse created
  // earlier in the SAME file — see registerCrossTierId) both register into it
  // too now, under the fixed keys "patients" and "users" respectively. Each
  // tier commits via its own separate request (the frontend's bucket-commit
  // loop awaits one before starting the next — see wireAutoActions in
  // hospital/data-import.js), so the running map is persisted on the batch
  // row itself (import_batches.multi_entity_id_map) rather than kept in
  // memory, and rebuilt fresh from it here on every call. Keyed by BOTH the
  // row's own position within its entity group in the file (1-based) and, if
  // present, its own explicit "id" column value — covers a CSV that
  // identifies its rows by an explicit id column and one that doesn't equally.
  const isGeneric = entityDef.kind === "generic";
  const isMultiBatch = batch.target_entity === "multi";
  const idMapsRuntime = {};
  if (isMultiBatch) {
    let stored = {};
    try {
      stored = batch.multi_entity_id_map
        ? typeof batch.multi_entity_id_map === "string"
          ? JSON.parse(batch.multi_entity_id_map)
          : batch.multi_entity_id_map
        : {};
    } catch {
      stored = {};
    }
    for (const [key, obj] of Object.entries(stored || {})) {
      idMapsRuntime[key] = new Map(Object.entries(obj || {}));
    }
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`UPDATE import_batches SET status = 'committing' WHERE id = ?`, [batch.id]);

    // For "hospitals" (a singleton row that gets UPDATEd, never inserted),
    // capture exactly what the row looked like right before this batch
    // touches it, so DELETE /api/import/:batchId can restore it exactly
    // instead of just guessing which fields this batch changed.
    if (entityName === "hospitals") {
      const [[beforeRow]] = await connection.query(`SELECT * FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
      await connection.query(`UPDATE import_batches SET pre_commit_snapshot = ? WHERE id = ?`, [
        JSON.stringify(beforeRow || {}),
        batch.id,
      ]);
    }

    // Staff rows resolve a doctor's department name to a real department_id
    // once per distinct name, not once per row — auto-creating it for this
    // hospital the same way POST /api/departments does if it doesn't exist yet.
    const departmentCache = new Map();
    let hospitalShortCode = null;
    if (entityDef.table === "users") {
      const [[hospitalRow]] = await connection.query(`SELECT short_code FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
      hospitalShortCode = hospitalRow?.short_code || "HOSP";
    }

    // Patient rows resolve an "Assigned Doctor" name/email against this
    // hospital's real doctor accounts once up front, not per row — see
    // resolveDoctorLink below. Unlike a department, a doctor is never
    // auto-created here: a name that doesn't confidently match an existing
    // account is kept as a custom field instead (see commitPatientRow).
    let doctorLookup = null;
    if (entityName === "patients") {
      const [doctorRows] = await connection.query(`SELECT user_id, full_name, email FROM users WHERE hospital_id = ? AND role = 'doctor'`, [
        hospitalId,
      ]);
      const fuseIndex = new Fuse(doctorRows, { keys: ["full_name"], includeScore: true, threshold: 0.3, ignoreLocation: true });
      doctorLookup = { doctors: doctorRows, fuseIndex, cache: new Map() };
    }

    const validate = getAjvValidator(entityName, entityDef);
    let committedCount = 0;
    let failedCount = 0;
    let uhidCollisionsResolved = 0;
    let doctorLinksCreated = 0;
    let doctorLinksUnresolved = 0;
    // A handful of distinct failure reasons, surfaced back to the admin —
    // without this, "62 rows failed" gives no clue why, and the only place
    // the real reason lived was import_staging_rows.error_message, which the
    // UI never showed.
    const sampleErrors = [];
    function recordError(message) {
      if (sampleErrors.length < 5 && !sampleErrors.includes(message)) sampleErrors.push(message);
    }

    // The "hospitals" entity is a singleton per admin — every row updates the
    // same record, so real-column values from later rows win on conflict and
    // extra_fields accumulate across rows via JSON_MERGE_PATCH.
    let csvPositionCounter = 0;
    for (const stagingRow of stagingRows) {
      csvPositionCounter++;
      const rawData = stagingRow.raw_data;
      const columnValues = {};
      const detailsValues = {};
      const specialValues = {};
      const opdMetaValues = {};
      const extraFieldValues = {};

      for (const header of Object.keys(rawData)) {
        const mapping = mappingByField.get(header);
        // Ultimate safety net for a header the admin never mapped at all —
        // still never dropped, just parked in extra_fields under its own name.
        // Skipped when BLANK though: a multi-entity file's staged raw_data
        // keeps every column from the whole wide file on every row (see
        // stageMultiEntityBatch), so a row's own entity only ever confirmed a
        // mapping for its OWN relevant headers — every other table's columns
        // hit this exact branch, blank, on every single row. Keeping those
        // would flood extra_fields with dozens of empty-string entries per
        // row instead of the one real unmatched value (if any) worth keeping —
        // there's no data to lose by skipping an empty value here.
        if (!mapping) {
          const raw = rawData[header];
          if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
            extraFieldValues[header] = raw;
          }
          continue;
        }
        if (mapping.target_type === "ignored") continue;
        if (mapping.target_type === "extra_field") {
          extraFieldValues[header] = rawData[header];
          continue;
        }
        const fieldDef = entityDef.fields.find((f) => f.key === mapping.target_field);
        const transformName = mapping.transform_fn || fieldDef?.transform;
        const value = transformName ? applyTransform(transformName, rawData[header]) : rawData[header];
        const storage = fieldDef ? fieldStorage(entityDef, fieldDef) : "column";
        if (storage === "details") detailsValues[mapping.target_field] = value;
        else if (storage === "department") specialValues[mapping.target_field] = value;
        else if (storage === "doctor_link" || storage === "opd_meta") opdMetaValues[mapping.target_field] = value;
        else columnValues[mapping.target_field] = value;
      }

      // Smart auto-derivation: a field can declare `deriveFrom` naming
      // ANOTHER mapped field to compute its own value from, tried only when
      // nothing mapped to it directly. `deriveFrom` can be one attempt or an
      // array of fallback attempts tried in order (e.g. lab_orders.patient_uhid
      // can come from either its opd_visit_id or its ipd_admission_id,
      // whichever this row actually has). Two different shapes of "derive":
      //  - same-row copy/transform (e.g. nurse_shift_roster.day_of_week from
      //    a shift_date column, when a file tracks shifts by calendar date
      //    rather than a recurring weekday — real gap found 2026-09-02).
      //  - cross-table lookup (`lookupTable`/`lookupField`): resolve the
      //    sibling's own ref (e.g. opd_visit_id) to the real row THIS batch
      //    (or an earlier one) already committed, then read a column off
      //    THAT row — e.g. consultations.patient_uhid isn't in the file at
      //    all, but its opd_visit_id is, and that visit's own patient_uhid
      //    (already committed — opd_visits is an earlier tier) is exactly
      //    the value that belongs here. Real gap found 2026-09-03.
      // Run before validation so a successful derivation counts toward
      // "required field satisfied", same as a directly-mapped column would.
      for (const field of entityDef.fields) {
        if (!field.deriveFrom) continue;
        const existing = columnValues[field.key];
        if (existing !== undefined && existing !== null && existing !== "") continue;
        const attempts = Array.isArray(field.deriveFrom) ? field.deriveFrom : [field.deriveFrom];
        for (const attempt of attempts) {
          const sourceValue = columnValues[attempt.siblingField];
          if (sourceValue === undefined || sourceValue === null || sourceValue === "") continue;
          if (attempt.lookupTable) {
            const siblingFieldDef = entityDef.fields.find((sf) => sf.key === attempt.siblingField);
            const refMap = siblingFieldDef?.ref ? idMapsRuntime[siblingFieldDef.ref] : null;
            const resolvedId = resolveSurrogateRef(String(sourceValue).trim(), refMap);
            if (resolvedId === null) continue;
            try {
              const [[lookupRow]] = await connection.query(
                `SELECT ${quoteIdent(attempt.lookupField)} AS value FROM ${quoteTable(attempt.lookupTable)} WHERE id = ? AND hospital_id = ? LIMIT 1`,
                [resolvedId, hospitalId]
              );
              if (lookupRow && lookupRow.value !== null && lookupRow.value !== undefined && lookupRow.value !== "") {
                columnValues[field.key] = lookupRow.value;
                break;
              }
            } catch {
              /* try the next fallback attempt, if any — never fail the whole row over a best-effort lookup */
            }
            continue;
          }
          const derived = applyTransform(attempt.transform, sourceValue);
          if (derived !== null && derived !== undefined) {
            columnValues[field.key] = derived;
            break;
          }
        }
      }

      const isValid = validate(columnValues);
      if (!isValid) {
        const message = ajv.errorsText(validate.errors, { separator: "; " });
        await connection.query(`UPDATE import_staging_rows SET status = 'error', error_message = ? WHERE id = ?`, [
          message.slice(0, 500),
          stagingRow.id,
        ]);
        recordError(message);
        failedCount++;
        continue;
      }

      try {
        if (entityName === "patients") {
          const { uhidCollisionResolved, doctorLinkResult, insertedId } = await commitPatientRow(
            connection,
            hospitalId,
            userId,
            batch.id,
            columnValues,
            extraFieldValues,
            opdMetaValues,
            doctorLookup
          );
          if (uhidCollisionResolved) uhidCollisionsResolved++;
          if (doctorLinkResult === "created") doctorLinksCreated++;
          else if (doctorLinkResult === "unresolved") doctorLinksUnresolved++;
          if (isMultiBatch) registerCrossTierId(idMapsRuntime, "patients", csvPositionCounter, rawData, insertedId);
        } else if (entityName === "hospitals") {
          await commitHospitalRow(connection, hospitalId, columnValues, extraFieldValues);
        } else if (isGeneric) {
          const insertedId = await commitGenericRow(connection, hospitalId, entityDef, columnValues, extraFieldValues, idMapsRuntime);
          if (isMultiBatch) registerCrossTierId(idMapsRuntime, entityName, csvPositionCounter, rawData, insertedId);
        } else {
          const staffUserId = await commitStaffRow(connection, hospitalId, batch.id, entityName, hospitalShortCode, columnValues, detailsValues, specialValues, extraFieldValues, departmentCache);
          // Shared "users" key regardless of role — a doctor bucket and a
          // nurse bucket committing separately (their own requests) both feed
          // the SAME map, since a downstream row's doctor_user_id and another
          // row's assigned_nurse_id both need to search across every staff
          // role this file created, not just one.
          if (isMultiBatch) registerCrossTierId(idMapsRuntime, "users", csvPositionCounter, rawData, staffUserId);
        }
        await connection.query(`UPDATE import_staging_rows SET status = 'committed' WHERE id = ?`, [stagingRow.id]);
        committedCount++;
      } catch (rowErr) {
        await connection.query(`UPDATE import_staging_rows SET status = 'error', error_message = ? WHERE id = ?`, [
          String(rowErr.message).slice(0, 500),
          stagingRow.id,
        ]);
        recordError(String(rowErr.message));
        failedCount++;
      }
    }

    await connection.commit();

    // Persist this tier's newly-created ids for the NEXT tier's request to
    // pick up (see the id-map rebuild above) — best-effort: if this write
    // fails, later tiers just fall back to treating a raw ref value as
    // already a real DB id instead of hard-failing a commit that otherwise
    // fully succeeded.
    if (isMultiBatch) {
      try {
        const serializable = {};
        for (const [key, map] of Object.entries(idMapsRuntime)) {
          serializable[key] = Object.fromEntries(map.entries());
        }
        await db.query(`UPDATE import_batches SET multi_entity_id_map = ? WHERE id = ?`, [JSON.stringify(serializable), batch.id]);
      } catch (mapErr) {
        console.error("Failed to persist multi-entity id map:", mapErr.message);
      }
    }

    return {
      committedCount,
      failedCount,
      customFieldsCreated,
      fieldsAutoRedirected,
      sampleErrors,
      uhidCollisionsResolved,
      doctorLinksCreated,
      doctorLinksUnresolved,
    };
  } catch (err) {
    try {
      await connection.rollback();
    } catch {
      /* connection may already be gone */
    }
    throw err;
  } finally {
    connection.release();
  }
}

// ---------- POST /api/import/:batchId/commit ----------
//
// A plain single-entity batch commits everything in one call, same as
// always. An auto-detected batch commits ONE bucket per call — the client
// loops over every detected bucket and calls this once each, which is what
// lets the import screen show real, granular progress ("Importing
// doctors… 2/4") instead of one opaque wait for the whole mixed file.
router.post("/:batchId/commit", requireHospitalAdmin, async (req, res) => {
  const { hospitalId } = req.session.user;

  try {
    const [[batch]] = await req.db.query(`SELECT * FROM import_batches WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.batchId,
      hospitalId,
    ]);
    if (!batch) return res.status(404).json({ success: false, message: "Import batch not found." });
    if (batch.status === "committed") return res.status(409).json({ success: false, message: "This batch is already committed." });

    if (!isBucketedBatch(batch.target_entity)) {
      const entityDef = getEntity(batch.target_entity);
      const [stagingRows] = await req.db.query(`SELECT * FROM import_staging_rows WHERE batch_id = ? ORDER BY row_num ASC`, [batch.id]);
      const result = await commitEntityRows(req.db, hospitalId, req.session.user.userId, batch, batch.target_entity, entityDef, stagingRows);
      await req.db.query(
        `UPDATE import_batches SET status = 'committed', committed_rows = ?, failed_rows = ?, committed_at = NOW() WHERE id = ?`,
        [result.committedCount, result.failedCount, batch.id]
      );
      return res.json({
        success: true,
        committedRows: result.committedCount,
        failedRows: result.failedCount,
        customFieldsCreated: result.customFieldsCreated,
        fieldsAutoRedirected: result.fieldsAutoRedirected,
        sampleErrors: result.sampleErrors,
        uhidCollisionsResolved: result.uhidCollisionsResolved,
        doctorLinksCreated: result.doctorLinksCreated,
        doctorLinksUnresolved: result.doctorLinksUnresolved,
      });
    }

    // ---------- Auto-detect: commit ONE bucket ----------
    const targetEntity = req.body?.targetEntity;
    const entityDef = getEntity(targetEntity);
    if (!entityDef) {
      return res.status(400).json({ success: false, message: "A valid targetEntity is required for this batch." });
    }
    const [pendingUnclassified] = await req.db.query(
      `SELECT COUNT(*) AS c FROM import_staging_rows WHERE batch_id = ? AND detected_entity IS NULL`,
      [batch.id]
    );
    if (pendingUnclassified[0].c > 0) {
      return res.status(400).json({
        success: false,
        message: "Some rows are still unclassified — reclassify or skip them before importing.",
      });
    }

    const [stagingRows] = await req.db.query(
      `SELECT * FROM import_staging_rows WHERE batch_id = ? AND detected_entity = ? AND status IN ('pending','mapped') ORDER BY row_num ASC`,
      [batch.id, targetEntity]
    );
    if (stagingRows.length === 0) {
      return res.status(400).json({ success: false, message: "This group has already been imported." });
    }

    const result = await commitEntityRows(req.db, hospitalId, req.session.user.userId, batch, targetEntity, entityDef, stagingRows);

    // Running totals across every bucket committed so far this batch, not
    // just this call — an auto-detect batch is only "done" once every
    // bucket (patients, doctors, nurses, ...) has had its turn.
    const [[counts]] = await req.db.query(
      `SELECT
         SUM(status = 'committed') AS committed,
         SUM(status = 'error') AS failed,
         SUM(status IN ('pending','mapped')) AS remaining
       FROM import_staging_rows WHERE batch_id = ?`,
      [batch.id]
    );
    const batchComplete = Number(counts.remaining) === 0;
    await req.db.query(
      `UPDATE import_batches SET status = ?, committed_rows = ?, failed_rows = ?, committed_at = ? WHERE id = ?`,
      [batchComplete ? "committed" : "committing", Number(counts.committed) || 0, Number(counts.failed) || 0, batchComplete ? new Date() : null, batch.id]
    );

    res.json({
      success: true,
      entity: targetEntity,
      committedRows: result.committedCount,
      failedRows: result.failedCount,
      customFieldsCreated: result.customFieldsCreated,
      fieldsAutoRedirected: result.fieldsAutoRedirected,
      sampleErrors: result.sampleErrors,
      uhidCollisionsResolved: result.uhidCollisionsResolved,
      doctorLinksCreated: result.doctorLinksCreated,
      doctorLinksUnresolved: result.doctorLinksUnresolved,
      batchComplete,
      totalCommittedSoFar: Number(counts.committed) || 0,
      totalFailedSoFar: Number(counts.failed) || 0,
    });
  } catch (err) {
    console.error("Import commit error:", err.message);
    try {
      await req.db.query(`UPDATE import_batches SET status = 'failed' WHERE id = ?`, [req.params.batchId]);
    } catch {
      /* best-effort status update */
    }
    const status = err instanceof ImportUserError ? 400 : 500;
    const prefix = status === 500 ? "Commit failed — no rows were changed. " : "";
    res.status(status).json({ success: false, message: prefix + err.message });
  }
});

// "Dr. Ramesh Gupta" / "Dr Ramesh Gupta" / "Doctor Ramesh Gupta" are all the
// exact same doctor as "Ramesh Gupta" — a title prefix, not a name
// difference — so it's stripped before any comparison. Deliberately handled
// as its own normalization step rather than left to fuzzy edit-distance,
// since it's a specific, extremely common pattern worth matching exactly
// rather than by chance.
function normalizeDoctorName(name) {
  return String(name).trim().replace(/^(dr\.?|prof\.?|doctor)\s+/i, "").trim().toLowerCase();
}

// Matches an "Assigned Doctor" cell (a name or email) against this
// hospital's real doctor accounts — exact email, then exact name (title
// prefix ignored), then a tight fuzzy match (score <= 0.2, deliberately
// stricter than the 0.45 used for header matching, since a wrong doctor
// link is worse than a wrong column guess an admin will see in the mapping
// table). Cached per distinct value so a batch of hundreds of patients
// doesn't repeat the same search.
function resolveDoctorLink(doctorLookup, rawValue) {
  if (!doctorLookup || !rawValue) return null;
  const value = String(rawValue).trim();
  if (!value) return null;
  const cacheKey = value.toLowerCase();
  if (doctorLookup.cache.has(cacheKey)) return doctorLookup.cache.get(cacheKey);

  let match = null;
  if (value.includes("@")) {
    match = doctorLookup.doctors.find((d) => d.email && d.email.toLowerCase() === cacheKey) || null;
  }
  if (!match) {
    const normalizedValue = normalizeDoctorName(value);
    match = doctorLookup.doctors.find((d) => d.full_name && normalizeDoctorName(d.full_name) === normalizedValue) || null;
  }
  if (!match) {
    const results = doctorLookup.fuseIndex.search(normalizeDoctorName(value));
    if (results.length > 0 && results[0].score <= 0.2) match = results[0].item;
  }
  doctorLookup.cache.set(cacheKey, match);
  return match;
}

async function commitPatientRow(connection, hospitalId, userId, batchId, columnValues, extraFieldValues, opdMetaValues = {}, doctorLookup = null) {
  let uhid = columnValues.uhid || null;
  const password = generateTempPassword();
  const passwordHash = await bcrypt.hash(password, 12);
  delete columnValues.uhid; // set after insert if not provided, same as POST /api/patients

  async function insertPatient(uhidValue, extras) {
    return connection.query(
      `INSERT INTO patients (hospital_id, uhid, password_hash, full_name, dob, gender, phone, address,
         emergency_contact_name, emergency_contact_phone, abha_id, abha_address, category, blood_group,
         registered_by, extra_fields, imported_from_batch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId,
        uhidValue,
        passwordHash,
        columnValues.full_name,
        columnValues.dob || null,
        columnValues.gender || null,
        columnValues.phone || null,
        columnValues.address || null,
        columnValues.emergency_contact_name || null,
        columnValues.emergency_contact_phone || null,
        columnValues.abha_id || null,
        columnValues.abha_address || null,
        columnValues.category || null,
        columnValues.blood_group || null,
        userId,
        Object.keys(extras).length ? JSON.stringify(extras) : null,
        batchId,
      ]
    );
  }

  let result;
  let uhidCollisionResolved = false;
  try {
    [result] = await insertPatient(uhid, extraFieldValues);
  } catch (err) {
    // A file-supplied UHID (e.g. a "patient_id" column mapped onto it) can
    // collide with one already in the database — a re-import of overlapping
    // data, or values that just happen to already be in use. That must never
    // fail the whole row: keep the file's value for reference, in extra_fields
    // (never dropped), and fall back to a freshly generated, guaranteed-unique
    // UHID instead of the one the file asked for.
    if (err.code === "ER_DUP_ENTRY" && uhid && err.message.includes("uhid")) {
      uhidCollisionResolved = true;
      extraFieldValues = { ...extraFieldValues, "uhid (from file)": uhid };
      uhid = null;
      [result] = await insertPatient(null, extraFieldValues);
    } else {
      throw err;
    }
  }

  if (!uhid) {
    const [[hospitalRow]] = await connection.query(`SELECT short_code FROM hospitals WHERE id = ? LIMIT 1`, [hospitalId]);
    uhid = generateUhid(hospitalRow?.short_code || "HOSP", result.insertId);
    await connection.query(`UPDATE patients SET uhid = ? WHERE id = ?`, [uhid, result.insertId]);
  }
  const insertedId = result.insertId;

  await connection.query(`INSERT INTO user_directory (user_id, hospital_id, account_type) VALUES (?, ?, 'patient')`, [uhid, hospitalId]);

  // Links this patient to a real doctor via a genuine opd_visits record —
  // the same relationship a real OPD booking creates, which is what makes
  // this patient show up on that doctor's own "My Patients" list (see
  // GET /api/doctor/patients in server.js). status is 'completed', not
  // 'waiting' — a bulk historical import must never land in today's live
  // queue as if the patient just walked in. source: 'import' distinguishes
  // it from a real walk-in/appointment/telemedicine booking.
  let doctorLinkResult = null;
  if (opdMetaValues.assigned_doctor) {
    const rawDoctorValue = String(opdMetaValues.assigned_doctor).trim();
    const matchedDoctor = resolveDoctorLink(doctorLookup, rawDoctorValue);
    if (matchedDoctor) {
      const visitDate = opdMetaValues.visit_date || new Date().toISOString().slice(0, 10);
      const [[countRow]] = await connection.query(`SELECT COUNT(*) AS cnt FROM opd_visits WHERE hospital_id = ? AND visit_date = ?`, [
        hospitalId,
        visitDate,
      ]);
      const tokenNumber = countRow.cnt + 1;
      await connection.query(
        `INSERT INTO opd_visits (hospital_id, token_number, patient_uhid, doctor_user_id, visit_date, source, status, created_by)
         VALUES (?, ?, ?, ?, ?, 'import', 'completed', ?)`,
        [hospitalId, tokenNumber, uhid, matchedDoctor.user_id, visitDate, userId]
      );
      doctorLinkResult = "created";
    } else {
      // Couldn't confidently match a real doctor — never silently dropped,
      // kept visible on the patient's own record instead.
      await connection.query(
        `UPDATE patients SET extra_fields = JSON_MERGE_PATCH(COALESCE(extra_fields, JSON_OBJECT()), ?) WHERE id = ?`,
        [JSON.stringify({ "assigned_doctor (unresolved)": rawDoctorValue }), result.insertId]
      );
      doctorLinkResult = "unresolved";
    }
  }

  return { uhidCollisionResolved, doctorLinkResult, insertedId };
}

async function commitHospitalRow(connection, hospitalId, columnValues, extraFieldValues) {
  const setClauses = [];
  const params = [];
  Object.keys(columnValues).forEach((key) => {
    if (columnValues[key] === null || columnValues[key] === undefined) return;
    setClauses.push(`${key} = ?`);
    params.push(columnValues[key]);
  });

  if (Object.keys(extraFieldValues).length) {
    setClauses.push(`extra_fields = JSON_MERGE_PATCH(COALESCE(extra_fields, JSON_OBJECT()), ?)`);
    params.push(JSON.stringify(extraFieldValues));
  }
  if (setClauses.length === 0) return;

  params.push(hospitalId);
  await connection.query(`UPDATE hospitals SET ${setClauses.join(", ")} WHERE id = ?`, params);
}

// Mirrors POST /api/hospital/staff (the manual "Add Staff" form) exactly —
// an imported doctor/nurse/etc. ends up in the same `users` table, the same
// way, and shows up on the normal Existing Staff page with no separate
// import-only listing needed. columnValues holds full_name/email/phone (the
// three real `users` columns any staff role has); detailsValues holds every
// role-specific field (specialization, shift, ...); specialValues holds only
// a doctor's "department" name, resolved to a real department_id here
// (auto-creating the department for this hospital if it doesn't exist yet,
// same as POST /api/departments) rather than ever being stored as text.
async function commitStaffRow(connection, hospitalId, batchId, role, hospitalShortCode, columnValues, detailsValues, specialValues, extraFieldValues, departmentCache) {
  let departmentId = null;
  const departmentName = specialValues.department ? String(specialValues.department).trim() : "";
  if (role === "doctor" && departmentName) {
    const cacheKey = departmentName.toLowerCase();
    if (departmentCache.has(cacheKey)) {
      departmentId = departmentCache.get(cacheKey);
    } else {
      const [[existing]] = await connection.query(
        `SELECT id FROM departments WHERE hospital_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
        [hospitalId, departmentName]
      );
      if (existing) {
        departmentId = existing.id;
      } else {
        const [inserted] = await connection.query(`INSERT INTO departments (hospital_id, name, created_by) VALUES (?, ?, 'data-import')`, [
          hospitalId,
          departmentName,
        ]);
        departmentId = inserted.insertId;
      }
      departmentCache.set(cacheKey, departmentId);
    }
  }

  // Same three-designation special case as the manual Add Staff form: a
  // Pathology-role row's User ID prefix comes from its chosen designation
  // (Pathologist/Lab Assistant/Radiologist), not a flat per-role prefix.
  const details = { ...detailsValues, ...extraFieldValues };
  const prefix = role === "pathology_staff" ? DESIGNATION_PREFIXES[details.designation] || ROLE_PREFIXES.pathology_staff : ROLE_PREFIXES[role];

  const password = generateTempPassword();
  const passwordHash = await bcrypt.hash(password, 12);

  // A random User ID (see generateStaffUserId) can collide on a large batch;
  // retry with a freshly generated one a few times rather than losing the
  // whole row to an ER_DUP_ENTRY on user_id.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const staffUserId = generateStaffUserId(prefix, hospitalShortCode);
    try {
      await connection.query(
        `INSERT INTO users (hospital_id, user_id, password_hash, full_name, role, email, phone, details, department_id, imported_from_batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hospitalId,
          staffUserId,
          passwordHash,
          columnValues.full_name,
          role,
          columnValues.email,
          columnValues.phone || null,
          JSON.stringify(details),
          departmentId,
          batchId,
        ]
      );
      await connection.query(`INSERT INTO user_directory (user_id, hospital_id) VALUES (?, ?)`, [staffUserId, hospitalId]);
      return staffUserId;
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY" && attempt < 2) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ---------- GET /api/import/batches — history, for the hospital admin screen ----------

router.get("/batches", requireHospitalAdmin, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, batch_uid, source_name, original_filename, target_entity, status, total_rows, committed_rows, failed_rows, created_at, committed_at, reverted_at
       FROM import_batches WHERE hospital_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.session.user.hospitalId]
    );
    res.json({ success: true, batches: rows });
  } catch (err) {
    console.error("List import batches error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

// ---------- DELETE /api/import/:batchId — undo a bad import from the page itself ----------
//
// So a mismapped or garbled import doesn't need a support request to fix: the
// admin can delete everything that batch committed and re-upload with a
// corrected mapping. For "patients", that means removing exactly the rows
// this batch created (tracked via patients.imported_from_batch) plus their
// login entries — other batches' patients are never touched. For
// "hospitals" (a singleton row that only ever gets UPDATEd), there's no row
// to delete — instead the real columns + extra_fields are restored to
// exactly what they were right before this batch ran, from the snapshot
// captured at commit time (import_batches.pre_commit_snapshot).
router.delete("/:batchId", requireHospitalAdmin, async (req, res) => {
  const { hospitalId, userId } = req.session.user;
  let connection;

  try {
    const [[batch]] = await req.db.query(`SELECT * FROM import_batches WHERE id = ? AND hospital_id = ? LIMIT 1`, [
      req.params.batchId,
      hospitalId,
    ]);
    if (!batch) return res.status(404).json({ success: false, message: "Import batch not found." });

    // Nothing was ever actually written to a real table for a batch that
    // never got past commit (uploaded/mapping/ready/committing-stuck/failed)
    // — committed_rows is always 0, so there's no undo logic needed, just
    // remove the batch and whatever it staged. This is the general escape
    // hatch for a batch that failed to auto-detect, errored mid-staging, or
    // was abandoned at the mapping step: previously the rest of this route
    // (below) only knew how to undo a REAL commit, so anything short of
    // that had no Delete option at all and sat in Import History permanently.
    // Real bug found 2026-09-03: an auto-detect/multi-entity batch sits at
    // status = 'committing' (never 'committed') until EVERY bucket/tier has
    // had its turn — but each individual bucket commit already writes real
    // rows to real tables as it goes. If even one bucket is abandoned
    // (mapping error, admin gives up on just that group), the batch never
    // reaches 'committed', so this used to always take the fast "nothing was
    // ever written" path below — deleting import_staging_rows AND the
    // import_batches row itself (including multi_entity_id_map) while every
    // already-committed tier's rows stayed live in the database, now with no
    // batch record left to ever trace or clean them up through. Falling
    // through to the full per-entity undo logic instead (same logic used for
    // status === 'committed') correctly reverses whichever tiers actually
    // committed, using imported_from_batch / multi_entity_id_map exactly as
    // it already does for a fully-committed batch — it doesn't require every
    // tier to have finished.
    if (batch.status !== "committed" && !(batch.committed_rows > 0)) {
      await req.db.query(`DELETE FROM import_staging_rows WHERE batch_id = ?`, [batch.id]);
      await req.db.query(`DELETE FROM import_batches WHERE id = ?`, [batch.id]);
      return res.json({ success: true, discarded: true, deletedRows: 0 });
    }
    if (batch.reverted_at) {
      return res.status(409).json({ success: false, message: "This import was already deleted." });
    }

    connection = await req.db.getConnection();
    await connection.beginTransaction();

    if (batch.target_entity === "patients") {
      const [rows] = await connection.query(`SELECT uhid FROM patients WHERE hospital_id = ? AND imported_from_batch = ?`, [
        hospitalId,
        batch.id,
      ]);
      const uhids = rows.map((r) => r.uhid).filter(Boolean);
      // A batch committed before the imported_from_batch column existed has
      // no way to identify which patients are "its" rows — silently
      // reporting success with 0 deletions would be a lie (the garbage data
      // is still there), so refuse instead of pretending it's handled.
      if (uhids.length === 0 && batch.committed_rows > 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "This import predates row-level tracking and can't be identified for automatic deletion. Contact support for manual cleanup.",
        });
      }
      if (uhids.length) {
        // Real bug found 2026-09-03: a patient with a resolved "Assigned
        // Doctor" gets a genuine opd_visits row too (see commitPatientRow) —
        // that row was never cleaned up here, left silently orphaned
        // (referencing a patient_uhid that no longer exists) after undo.
        // Scoped to source = 'import' so this can never touch a real
        // walk-in/appointment visit, only ones this same mechanism created.
        await connection.query(`DELETE FROM opd_visits WHERE hospital_id = ? AND patient_uhid IN (?) AND source = 'import'`, [
          hospitalId,
          uhids,
        ]);
        await connection.query(`DELETE FROM user_directory WHERE hospital_id = ? AND user_id IN (?)`, [hospitalId, uhids]);
      }
      await connection.query(`DELETE FROM patients WHERE hospital_id = ? AND imported_from_batch = ?`, [hospitalId, batch.id]);

      await connection.query(`UPDATE import_batches SET reverted_at = NOW(), reverted_by = ? WHERE id = ?`, [userId, batch.id]);
      await connection.commit();
      return res.json({ success: true, deletedRows: uhids.length });
    }

    if (batch.target_entity === "hospitals") {
      // Only the most recently committed hospitals-entity batch can be
      // safely undone: it's a single shared row, so if a later import has
      // since changed the same fields, restoring this batch's "before"
      // snapshot would also erase that later, unrelated change.
      // Ordered by id, not committed_at — two batches committed within the
      // same second would tie on a TIMESTAMP column (1-second resolution),
      // but id is a strictly increasing auto-increment, so it's unambiguous.
      const [[mostRecent]] = await req.db.query(
        `SELECT id FROM import_batches WHERE hospital_id = ? AND target_entity = 'hospitals' AND status = 'committed' AND reverted_at IS NULL
         ORDER BY id DESC LIMIT 1`,
        [hospitalId]
      );
      if (!mostRecent || mostRecent.id !== batch.id) {
        await connection.rollback();
        return res.status(409).json({
          success: false,
          message: "A newer facility-data import has run since this one — only the most recent one can be undone.",
        });
      }
      if (!batch.pre_commit_snapshot) {
        await connection.rollback();
        return res.status(400).json({ success: false, message: "This import predates the undo feature and can't be automatically reverted." });
      }

      const snapshot = batch.pre_commit_snapshot;
      const entityDef = getEntity("hospitals");
      const setClauses = [];
      const params = [];
      entityDef.fields.forEach((f) => {
        setClauses.push(`${f.key} = ?`);
        params.push(snapshot[f.key] ?? null);
      });
      setClauses.push("extra_fields = ?");
      params.push(snapshot.extra_fields ? JSON.stringify(snapshot.extra_fields) : null);
      params.push(hospitalId);
      await connection.query(`UPDATE hospitals SET ${setClauses.join(", ")} WHERE id = ?`, params);

      await connection.query(`UPDATE import_batches SET reverted_at = NOW(), reverted_by = ? WHERE id = ?`, [userId, batch.id]);
      await connection.commit();
      return res.json({ success: true, restored: true });
    }

    // Auto-detect batches only ever produce patients + staff rows (never a
    // "hospitals" singleton row — see roleClassifier.js), and every row they
    // create is tracked via imported_from_batch from day one (this entity
    // value didn't exist before that column did), so there's no legacy
    // "predates tracking" case to guard against here.
    if (batch.target_entity === "auto") {
      const [patientRows] = await connection.query(`SELECT uhid FROM patients WHERE hospital_id = ? AND imported_from_batch = ?`, [
        hospitalId,
        batch.id,
      ]);
      const uhids = patientRows.map((r) => r.uhid).filter(Boolean);
      if (uhids.length) {
        // Same opd_visits cleanup as the plain "patients" undo above — a
        // resolved Assigned Doctor creates a real opd_visits row too.
        await connection.query(`DELETE FROM opd_visits WHERE hospital_id = ? AND patient_uhid IN (?) AND source = 'import'`, [
          hospitalId,
          uhids,
        ]);
        await connection.query(`DELETE FROM user_directory WHERE hospital_id = ? AND user_id IN (?)`, [hospitalId, uhids]);
      }
      await connection.query(`DELETE FROM patients WHERE hospital_id = ? AND imported_from_batch = ?`, [hospitalId, batch.id]);

      const [staffRows] = await connection.query(`SELECT user_id FROM users WHERE hospital_id = ? AND imported_from_batch = ?`, [
        hospitalId,
        batch.id,
      ]);
      const staffUserIds = staffRows.map((r) => r.user_id).filter(Boolean);
      if (staffUserIds.length) {
        await connection.query(`DELETE FROM user_directory WHERE hospital_id = ? AND user_id IN (?)`, [hospitalId, staffUserIds]);
      }
      await connection.query(`DELETE FROM users WHERE hospital_id = ? AND imported_from_batch = ?`, [hospitalId, batch.id]);

      await connection.query(`UPDATE import_batches SET reverted_at = NOW(), reverted_by = ? WHERE id = ?`, [userId, batch.id]);
      await connection.commit();
      return res.json({ success: true, deletedRows: uhids.length + staffUserIds.length, deletedPatients: uhids.length, deletedStaff: staffUserIds.length });
    }

    if (batch.target_entity === "multi") {
      // Reverse of the commit order (see MULTI_ENTITY_TIERS in
      // schemaRegistry.js): tier 7 first, tier 1 last, so a table is always
      // emptied before anything it depends on — the same reason it's the
      // commit order forwards. "users"/"patients" are tracked via the
      // existing imported_from_batch column (same mechanism the "auto"/
      // "patients" undo branches above already use); every `kind: "generic"`
      // entity is tracked via the real ids accumulated in
      // multi_entity_id_map as each tier committed (see registerCrossTierId/
      // commitEntityRows) — deduped per entity, since the same real id can be
      // registered under more than one CSV-local key (see registerCrossTierId).
      // "hospitals" (a singleton UPDATE, never an INSERT) is restored from
      // its pre_commit_snapshot afterward, same rule as the dedicated
      // hospitals-entity undo above: only if no newer import has touched it since.
      let idMap = {};
      try {
        idMap = batch.multi_entity_id_map
          ? typeof batch.multi_entity_id_map === "string"
            ? JSON.parse(batch.multi_entity_id_map)
            : batch.multi_entity_id_map
          : {};
      } catch {
        idMap = {};
      }

      const deletedByEntity = {};
      const reverseTiers = [...MULTI_ENTITY_TIERS].reverse();
      for (const tier of reverseTiers) {
        for (const entityKey of [...tier].reverse()) {
          if (entityKey === "users") {
            const [staffRows] = await connection.query(`SELECT user_id FROM users WHERE hospital_id = ? AND imported_from_batch = ?`, [
              hospitalId,
              batch.id,
            ]);
            const staffUserIds = staffRows.map((r) => r.user_id).filter(Boolean);
            if (staffUserIds.length) {
              await connection.query(`DELETE FROM user_directory WHERE hospital_id = ? AND user_id IN (?)`, [hospitalId, staffUserIds]);
              await connection.query(`DELETE FROM users WHERE hospital_id = ? AND imported_from_batch = ?`, [hospitalId, batch.id]);
            }
            deletedByEntity.users = staffUserIds.length;
            continue;
          }
          if (entityKey === "patients") {
            const [patientRows] = await connection.query(`SELECT uhid FROM patients WHERE hospital_id = ? AND imported_from_batch = ?`, [
              hospitalId,
              batch.id,
            ]);
            const uhids = patientRows.map((r) => r.uhid).filter(Boolean);
            if (uhids.length) {
              // Same opd_visits cleanup as the other two undo paths above —
              // a resolved Assigned Doctor creates a real opd_visits row
              // too, separate from anything tracked in multi_entity_id_map
              // (this comes from commitPatientRow's own doctor-link logic,
              // not the generic per-entity id map), so it needs its own
              // explicit cleanup here regardless of whether this same batch
              // also had its own opd_visits bucket.
              await connection.query(`DELETE FROM opd_visits WHERE hospital_id = ? AND patient_uhid IN (?) AND source = 'import'`, [
                hospitalId,
                uhids,
              ]);
              await connection.query(`DELETE FROM user_directory WHERE hospital_id = ? AND user_id IN (?)`, [hospitalId, uhids]);
              await connection.query(`DELETE FROM patients WHERE hospital_id = ? AND imported_from_batch = ?`, [hospitalId, batch.id]);
            }
            deletedByEntity.patients = uhids.length;
            continue;
          }
          if (entityKey === "hospitals") continue; // handled separately below, once every other tier is undone

          const def = getEntity(entityKey);
          if (!def || def.kind !== "generic") continue;
          const entityIdMap = idMap[entityKey];
          if (!entityIdMap) continue;
          const realIds = [...new Set(Object.values(entityIdMap))].filter((id) => Number.isInteger(id) || /^\d+$/.test(id));
          if (realIds.length === 0) continue;
          await connection.query(`DELETE FROM ${quoteTable(def.table)} WHERE hospital_id = ? AND id IN (?)`, [hospitalId, realIds]);
          deletedByEntity[entityKey] = realIds.length;
        }
      }

      let hospitalsRestored = false;
      if (batch.pre_commit_snapshot) {
        // Same "only the most recent can be undone" rule as the dedicated
        // hospitals-entity branch above, generalized to check across EVERY
        // batch that could have snapshotted the hospitals row (a plain
        // target_entity='hospitals' batch or a 'multi' batch with a hospitals
        // bucket), not just this one target_entity value.
        const [[mostRecent]] = await req.db.query(
          `SELECT id FROM import_batches WHERE hospital_id = ? AND pre_commit_snapshot IS NOT NULL AND status = 'committed' AND reverted_at IS NULL
           ORDER BY id DESC LIMIT 1`,
          [hospitalId]
        );
        if (mostRecent && mostRecent.id === batch.id) {
          const snapshot = batch.pre_commit_snapshot;
          const hospitalsDef = getEntity("hospitals");
          const setClauses = [];
          const params = [];
          hospitalsDef.fields.forEach((f) => {
            setClauses.push(`${f.key} = ?`);
            params.push(snapshot[f.key] ?? null);
          });
          setClauses.push("extra_fields = ?");
          params.push(snapshot.extra_fields ? JSON.stringify(snapshot.extra_fields) : null);
          params.push(hospitalId);
          await connection.query(`UPDATE hospitals SET ${setClauses.join(", ")} WHERE id = ?`, params);
          hospitalsRestored = true;
        }
      }

      // Reset every staged row this batch committed back to 'pending' (their
      // real rows no longer exist), and the batch itself back to 'ready' —
      // not "reverted", since a batch that's back to 'ready' with clean
      // staging rows is safely re-committable through the exact same
      // POST /:batchId/commit flow it used the first time, and the DELETE
      // guard above ("Only a committed import can be deleted") now correctly
      // refuses a second undo on its own, without needing a separate flag.
      await connection.query(`UPDATE import_staging_rows SET status = 'pending', error_message = NULL WHERE batch_id = ? AND status = 'committed'`, [
        batch.id,
      ]);
      await connection.query(
        `UPDATE import_batches SET status = 'ready', committed_rows = 0, failed_rows = 0, committed_at = NULL, multi_entity_id_map = NULL WHERE id = ?`,
        [batch.id]
      );
      await connection.commit();

      const totalDeleted = Object.values(deletedByEntity).reduce((sum, n) => sum + n, 0);
      return res.json({
        success: true,
        deletedRows: totalDeleted,
        deletedByEntity,
        hospitalsRestored,
        canRecommit: true,
      });
    }

    await connection.rollback();
    res.status(400).json({ success: false, message: "Unknown entity for this batch." });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch {
        /* connection may already be gone */
      }
    }
    console.error("Import delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error while deleting this import. Please try again." });
  } finally {
    if (connection) connection.release();
  }
});

// ---------- GET /api/import/field-usage/:entity ----------

router.get("/field-usage/:entity", requireSuperadmin, async (req, res) => {
  if (!getEntity(req.params.entity)) {
    return res.status(400).json({ success: false, message: `Unknown entity. Supported: ${listEntities().join(", ")}.` });
  }
  try {
    // Deliberately not hospital-scoped — the whole point is seeing which
    // extra fields are common ACROSS hospitals, to decide if one should
    // graduate into a real schemaRegistry.js column. Only key/type/hospital
    // counts are returned, never any actual patient/hospital data.
    //
    // Per-hospital database isolation (2026-09-07): hospital_custom_fields
    // now lives inside each hospital's own database, not one shared table,
    // so this can no longer be a single GROUP BY query — it fans out across
    // every hospital's own pool and merges the per-hospital field usage in
    // application code instead.
    const [hospitalRows] = await masterPool.query(`SELECT id, db_name FROM hospitals WHERE db_name IS NOT NULL`);
    const usage = new Map(); // "key|type" -> Set of hospital ids that use it
    for (const h of hospitalRows) {
      let hPool;
      try {
        hPool = await getHospitalPool(h.id);
      } catch {
        continue; // hospital has no reachable database yet — skip, not fatal
      }
      const [rows] = await hPool.query(
        `SELECT DISTINCT field_key, field_type FROM hospital_custom_fields WHERE entity = ?`,
        [req.params.entity]
      );
      for (const r of rows) {
        const mapKey = `${r.field_key}|${r.field_type}`;
        if (!usage.has(mapKey)) usage.set(mapKey, { field_key: r.field_key, field_type: r.field_type, hospitalIds: new Set() });
        usage.get(mapKey).hospitalIds.add(h.id);
      }
    }
    const rows = [...usage.values()]
      .map((u) => ({ field_key: u.field_key, field_type: u.field_type, hospital_count: u.hospitalIds.size }))
      .sort((a, b) => b.hospital_count - a.hospital_count);
    res.json({ success: true, fieldUsage: rows });
  } catch (err) {
    console.error("Field usage error:", err.message);
    res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;
