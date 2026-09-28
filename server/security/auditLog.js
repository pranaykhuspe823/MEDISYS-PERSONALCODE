// Shared access-audit writer — first adopted by the voice patient-recall
// feature (POST /api/voice/query) but not voice-specific: any route can
// call logAccess(req.db, {...}) to record who touched what. See
// server/schema.js for the audit_log table and server/security/rbac.js for
// the permission gate this typically sits right after.
const { encryptField } = require("./encryption");

// Deliberately fails open: a DB error writing the audit row must not block
// the clinical response the doctor is waiting on (patient data was already
// legitimately accessed under a passed RBAC check by this point) — but it's
// logged loudly server-side so a persistent audit-logging failure doesn't go
// unnoticed. If this system later needs fail-CLOSED behavior (deny access
// when the access can't be recorded), that's a deliberate policy change to
// make here, not the default for a Phase 1 build.
async function logAccess(
  db,
  { hospitalId, actorUserId, actorRole, action, resourceType, resourceId = null, outcome = "success", metadata = null, transcript = null, ipAddress = null }
) {
  try {
    let transcriptEncrypted = null;
    try {
      transcriptEncrypted = transcript ? encryptField(transcript) : null;
    } catch (encErr) {
      // Missing/invalid ENCRYPTION_KEY shouldn't be silently swallowed — but
      // it also shouldn't stop the (non-sensitive) rest of the audit row
      // from being written.
      console.error("Audit log: transcript encryption failed —", encErr.message);
    }
    await db.query(
      `INSERT INTO audit_log
         (hospital_id, actor_user_id, actor_role, action, resource_type, resource_id, outcome, metadata, transcript_encrypted, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId,
        actorUserId,
        actorRole,
        action,
        resourceType,
        resourceId,
        outcome,
        metadata ? JSON.stringify(metadata) : null,
        transcriptEncrypted,
        ipAddress,
      ]
    );
  } catch (err) {
    console.error("Audit log write failed:", err.message);
  }
}

module.exports = { logAccess };
