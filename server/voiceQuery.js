// Logic for POST /api/voice/query (hands-free patient recall) — kept out of
// server.js so that file's route handler stays a thin orchestration of these
// steps. See voice-recall-stt/README.md for the STT service this calls into.
const Fuse = require("fuse.js");

// Mirrors server.js's private todayLocalDateStr() — kept as an independent
// copy rather than exported/required from server.js to avoid a circular
// require (server.js requires this module).
function todayLocalDateStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Deliberately a separate service/URL from VOICE_SERVICE_URL (language/
// service.py, Sarvam AI — used only by the unrelated voice-*prescription*
// dictation feature). Patient-recall uses a free, self-hosted alternative
// instead — see voice-recall-stt/service.py (faster-whisper, local CPU
// inference, no API key, no per-request cost).
const VOICE_RECALL_STT_URL = process.env.VOICE_RECALL_STT_URL || "http://127.0.0.1:8600";
// Downstream matching/RBAC/audit/briefing logic needs a transcript to work
// with even when that local service isn't running (e.g. it hasn't been
// started this session, or the Whisper model is still downloading on first
// run) — override for testing via server/.env.
const MOCK_TRANSCRIPT = process.env.VOICE_QUERY_MOCK_TRANSCRIPT || "Ramesh Kumar, chest pain since yesterday";

// ---------- Step 1: speech-to-text ----------
//
// Calls the local voice-recall-stt service (see its README) rather than a
// paid cloud STT API — free by construction, not just "free while a trial
// credit lasts."
//
// Two genuinely different failure modes here, handled differently on
// purpose — conflating them previously caused a real bug (see git history:
// every real doctor request silently came back as a fixed demo patient,
// "Ashish", with no visible error):
//   - The service is UNREACHABLE (not started, wrong URL, connection
//     refused) — falls back to the mock transcript, logged clearly, so
//     voice-recall keeps working end-to-end for development without it
//     running at all. This is the only case that's allowed to substitute
//     the mock.
//   - The service IS reachable and responds, but the clip had no
//     recognizable speech in it (too short, mic muted, silence) or the
//     service itself errored transcribing it — this must NOT fall back to
//     the mock. Silently returning a canned demo transcript here would mean
//     returning a real, but WRONG, patient's clinical data as if it were a
//     genuine match — worse than a visible failure. It returns an empty
//     transcript instead, which parseNameAndComplaint()/the route handler
//     already turn into an honest "I didn't catch a name" response.
async function transcribeAudio(buffer, mimetype) {
  let upstream;
  try {
    const form = new FormData();
    form.append("audio", new Blob([buffer], { type: mimetype || "audio/wav" }), "recall-query.wav");
    upstream = await fetch(`${VOICE_RECALL_STT_URL}/transcribe`, { method: "POST", body: form });
  } catch (err) {
    console.warn("Voice-recall STT: local Whisper service unreachable —", err.message);
    return { transcript: MOCK_TRANSCRIPT, detectedLanguage: null, source: "mock" };
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok || !data) {
    console.warn("Voice-recall STT: local Whisper service returned", upstream.status, data && (data.error || data.detail));
    return { transcript: "", detectedLanguage: null, source: "whisper_error" };
  }
  if (!data.transcript) {
    console.warn("Voice-recall STT: Whisper heard no speech in this clip (too short, muted mic, or silence).");
    return { transcript: "", detectedLanguage: data.detectedLanguage, source: "whisper_empty" };
  }
  return { transcript: data.transcript.trim(), detectedLanguage: data.detectedLanguage, source: "whisper" };
}

// ---------- Step 2: extract name + (optional) chief complaint ----------
//
// Still a simple heuristic, not proper NLU (that's an explicit later
// phase) — but doctors mostly just want to say something natural like
// "give me Ramesh Kumar's details" with no complaint at all, not force
// every lookup through the original "name, complaint" comma format. Tried
// in order, most-specific first:
//   1. "<name>, <complaint>"                  — comma present, original format
//   2. "<trigger verb> <name>['s] <details noun>"  — "give me X's details",
//      "show me X's history", "pull up X record"
//   3. "<trigger verb> <name>"                — noun dropped, e.g. "tell me about X"
//   4. "<name>['s] <details noun>"            — trigger verb dropped, e.g. "X's details"
//   5. whole utterance treated as the name, complaint left blank
const TRIGGER_VERBS = "(?:give me|show me|get me|pull up|bring up|fetch me|fetch|tell me about|look up|find)";
// Includes "detains?" — real testing caught Whisper hearing "details" as
// "detains" (genuinely close phonetically) on a real clip; matchPatient()
// below also has a generic last-word-stripped retry as a second line of
// defense for whatever the NEXT near-miss turns out to be, rather than
// trying to enumerate every possible mishearing here.
const DETAILS_NOUN = "(?:details?|detains?|history|records?|info(?:rmation)?|summary|profile|data)";

function parseNameAndComplaint(transcript) {
  const text = String(transcript || "").trim();
  if (!text) return { name: null, complaint: null };

  const commaIndex = text.indexOf(",");
  if (commaIndex !== -1) {
    const name = text.slice(0, commaIndex).trim();
    const complaint = text.slice(commaIndex + 1).trim();
    return { name: name || null, complaint: complaint || null };
  }

  let m = text.match(new RegExp(`^(?:please\\s+)?${TRIGGER_VERBS}\\s+(.+?)(?:'s)?\\s+${DETAILS_NOUN}(?:\\s+please)?[.?]?$`, "i"));
  if (m) return { name: m[1].trim() || null, complaint: null };

  m = text.match(new RegExp(`^(?:please\\s+)?${TRIGGER_VERBS}\\s+(.+?)(?:\\s+please)?[.?]?$`, "i"));
  if (m) return { name: m[1].trim() || null, complaint: null };

  m = text.match(new RegExp(`^(.+?)(?:'s)?\\s+${DETAILS_NOUN}(?:\\s+please)?[.?]?$`, "i"));
  if (m) return { name: m[1].trim() || null, complaint: null };

  // Nothing recognizable — treat the whole utterance as the name and leave
  // complaint blank rather than guessing.
  return { name: text, complaint: null };
}

// ---------- Step 3: patient lookup ----------
//
// Fuzzy-ranks candidate rows against the spoken name with Fuse.js (already a
// server dependency, used the same way for header-matching in
// server/importRoutes.js). Returns every match within a small score band of
// the best hit — a genuine two-different-people case surfaces as ambiguous
// instead of only ever returning the single top-scored guess.
function fuzzyMatchByName(candidates, spokenName) {
  if (!spokenName || !candidates.length) return [];
  const fuse = new Fuse(candidates, { keys: ["full_name"], threshold: 0.4, includeScore: true });
  const results = fuse.search(spokenName);
  if (!results.length) return [];
  const bestScore = results[0].score;
  return results.filter((r) => r.score <= bestScore + 0.15).map((r) => r.item);
}

async function findTodaysQueueMatches(db, hospitalId, doctorUserId, name) {
  const [rows] = await db.query(
    `SELECT v.id AS visit_id, v.token_number, v.slot_time, v.status,
            p.uhid, p.full_name, p.dob, p.gender, p.phone
     FROM opd_visits v
     JOIN patients p ON p.uhid = v.patient_uhid
     WHERE v.hospital_id = ? AND v.visit_date = ? AND v.doctor_user_id = ?`,
    [hospitalId, todayLocalDateStr(), doctorUserId]
  );
  return fuzzyMatchByName(rows, name);
}

// Same LIKE search GET /api/patients/search already uses, narrowed further
// with the same Fuse ranking as above for ambiguity detection.
async function findFullSearchMatches(db, hospitalId, name) {
  const [rows] = await db.query(
    `SELECT uhid, full_name, dob, gender, phone FROM patients WHERE hospital_id = ? AND full_name LIKE ? LIMIT 50`,
    [hospitalId, `%${name}%`]
  );
  return fuzzyMatchByName(rows, name);
}

// Returns one of:
//   { status: 'resolved', patient, source }
//   { status: 'ambiguous', matches, source }
//   { status: 'not_found' }
async function matchPatientOnce(db, hospitalId, doctorUserId, name) {
  const todaysMatches = await findTodaysQueueMatches(db, hospitalId, doctorUserId, name);
  if (todaysMatches.length === 1) return { status: "resolved", patient: todaysMatches[0], source: "todays_queue" };
  if (todaysMatches.length > 1) return { status: "ambiguous", matches: todaysMatches, source: "todays_queue" };

  const searchMatches = await findFullSearchMatches(db, hospitalId, name);
  if (searchMatches.length === 1) return { status: "resolved", patient: searchMatches[0], source: "full_search" };
  if (searchMatches.length > 1) return { status: "ambiguous", matches: searchMatches, source: "full_search" };

  return { status: "not_found" };
}

async function matchPatient(db, hospitalId, doctorUserId, name) {
  const result = await matchPatientOnce(db, hospitalId, doctorUserId, name);
  if (result.status !== "not_found") return result;

  // A trailing word left over from parseNameAndComplaint() not recognizing
  // some trigger-phrase noun (e.g. Whisper mishearing "details" as
  // "detains" on a real clip in testing — close enough phonetically that
  // more will slip through no matter how many variants get added there)
  // corrupts BOTH the full-search SQL LIKE query and the fuzzy match, since
  // "Ashish detains" is a substring of nobody's real name. Rather than
  // trying to enumerate every possible mishearing at the parsing step,
  // retry once here with the last word dropped before giving up entirely.
  // Safe either way: if the shortened name still matches nobody, or now
  // matches several people, the caller still gets an honest
  // not_found/ambiguous outcome — this can never turn a real "no such
  // patient" into a silently wrong match.
  const words = name.trim().split(/\s+/);
  if (words.length > 1) {
    const shortened = words.slice(0, -1).join(" ");
    const retryResult = await matchPatientOnce(db, hospitalId, doctorUserId, shortened);
    if (retryResult.status !== "not_found") return retryResult;
  }
  return result;
}

// ---------- Steps 6-7: history retrieval + prioritized spoken summary ----------
//
// allergies: patients.allergies (added in server/schema.js for this feature).
// medications: reuses medisys_pharmacy.pharmacy_orders (the existing
// prescribe-and-dispense pipeline) as the source of "current medications" —
// there is no separate OPD medications table, and this cross-database query
// pattern is already used throughout server.js. "Current" here means
// prescribed in the last 90 days; there's no is_current flag to query
// instead.
// recent visits: consultations, most recent 2.
// critical labs: lab_orders.is_critical (added in server/schema.js) — will
// read empty until something actually sets that flag; no pathology UI for
// it exists yet (out of scope of this feature).
async function getPatientBriefing(db, hospitalId, uhid) {
  const [[patient]] = await db.query(
    `SELECT uhid, full_name, dob, gender, allergies FROM patients WHERE hospital_id = ? AND uhid = ?`,
    [hospitalId, uhid]
  );

  const [recentVisits] = await db.query(
    `SELECT c.symptoms, c.notes, c.diagnosis, c.decision, c.created_at, u.full_name AS doctor_name
     FROM consultations c
     LEFT JOIN users u ON u.user_id = c.doctor_user_id
     WHERE c.hospital_id = ? AND c.patient_uhid = ?
     ORDER BY c.created_at DESC LIMIT 2`,
    [hospitalId, uhid]
  );

  const [medications] = await db.query(
    `SELECT medicine_name, dosage, duration, status, created_at
     FROM medisys_pharmacy.pharmacy_orders
     WHERE hospital_id = ? AND patient_uhid = ? AND created_at >= (NOW() - INTERVAL 90 DAY)
     ORDER BY created_at DESC LIMIT 10`,
    [hospitalId, uhid]
  );

  const [criticalLabs] = await db.query(
    `SELECT lo.critical_value_note, lo.completed_at, tc.name AS test_name
     FROM lab_orders lo
     LEFT JOIN test_catalog tc ON tc.id = lo.test_id
     WHERE lo.hospital_id = ? AND lo.patient_uhid = ? AND lo.is_critical = 1
     ORDER BY lo.completed_at DESC LIMIT 5`,
    [hospitalId, uhid]
  );

  return { patient, recentVisits, medications, criticalLabs };
}

function formatVisitDate(d) {
  if (!d) return "an earlier date";
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// Priority order per the Phase 1 spec: allergies/critical alerts first, then
// complaint-relevant history, then medications, then recent visits.
function buildSpokenSummary({ patient, recentVisits, medications, criticalLabs }, complaint) {
  const parts = [];

  parts.push(patient.allergies ? `Allergy alert: ${patient.allergies}.` : "No known allergies on file.");

  if (criticalLabs.length) {
    const labText = criticalLabs
      .map((l) => `${l.test_name || "a lab result"}${l.critical_value_note ? ` — ${l.critical_value_note}` : ""}`)
      .join("; ");
    parts.push(`Critical lab flag: ${labText}.`);
  }

  if (complaint) {
    const complaintLower = complaint.toLowerCase();
    const relevantVisit = recentVisits.find(
      (v) => (v.symptoms || "").toLowerCase().includes(complaintLower) || (v.diagnosis || "").toLowerCase().includes(complaintLower)
    );
    if (relevantVisit) {
      parts.push(
        `Relevant to today's complaint of ${complaint}: seen on ${formatVisitDate(relevantVisit.created_at)} for ${
          relevantVisit.diagnosis || relevantVisit.symptoms
        }.`
      );
    }
  }

  if (medications.length) {
    const medText = medications.slice(0, 3).map((m) => `${m.medicine_name}${m.dosage ? ` ${m.dosage}` : ""}`).join(", ");
    parts.push(`Current medications: ${medText}.`);
  } else {
    parts.push("No medications on record in the last 90 days.");
  }

  if (recentVisits.length) {
    const visitText = recentVisits
      .map((v) => `${formatVisitDate(v.created_at)}, ${v.diagnosis || v.symptoms || "consultation"}`)
      .join("; then ");
    parts.push(`Recent visits: ${visitText}.`);
  } else {
    parts.push("No prior visits on record.");
  }

  return parts.join(" ");
}

function buildAmbiguousSummary(matches, name) {
  const descriptions = matches
    .slice(0, 4)
    .map((m) => {
      const lastSeen = m.visit_id ? "seen today" : "not on today's list";
      const dobPart = m.dob ? `, born ${new Date(m.dob).getFullYear()}` : "";
      return `one${dobPart}, ${lastSeen}`;
    })
    .join("; ");
  return `Found ${matches.length} patients matching ${name || "that name"} — ${descriptions}. Which one did you mean?`;
}

module.exports = {
  transcribeAudio,
  parseNameAndComplaint,
  matchPatient,
  getPatientBriefing,
  buildSpokenSummary,
  buildAmbiguousSummary,
};
