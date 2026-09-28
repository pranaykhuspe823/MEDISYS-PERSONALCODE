// Permission-string RBAC layer — first consumer is the voice patient-recall
// feature (POST /api/voice/query, requirePermission('patient:read:clinical')),
// built as shared infra other routes can adopt over time, not a voice-only
// helper. It sits alongside the existing role-name gates in server.js
// (requireRole, requireTenantUser) rather than replacing them everywhere at
// once — those still work as before; requirePermission is the finer-grained
// option for routes that want it.
const { getHospitalPool } = require("../dbRouter");

// role -> permissions it holds. Deliberately starts minimal (only what the
// voice patient-recall feature needs) rather than pre-declaring a full
// permission matrix for every role/route up front — extend this as each new
// route adopts requirePermission(), with a comment at the call site
// explaining what that permission actually gates.
const PERMISSIONS = {
  doctor: ["patient:read:clinical", "patient:read:demographics"],
};

function hasPermission(role, permission) {
  return Boolean(role && PERMISSIONS[role] && PERMISSIONS[role].includes(permission));
}

// Same shape/behavior as server.js's requireRole(...roles): resolves
// req.db to the caller's hospital pool on success. Difference is the check
// itself — a named permission (checked against PERMISSIONS above) instead
// of a raw role-name allowlist, so "what can a doctor do" lives in one place
// even as more permissions get added.
function requirePermission(permission) {
  return async (req, res, next) => {
    const user = req.session.user;
    if (!user || !user.hospitalId) {
      return res.status(401).json({ success: false, message: "Session required." });
    }
    if (!hasPermission(user.role, permission)) {
      return res.status(403).json({ success: false, message: "Insufficient permissions for this action." });
    }
    try {
      req.db = await getHospitalPool(user.hospitalId);
      return next();
    } catch (err) {
      console.error("Hospital pool lookup error:", err.message);
      return res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  };
}

module.exports = { requirePermission, hasPermission, PERMISSIONS };
