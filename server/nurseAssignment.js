const SHIFTS = ["Morning", "Evening", "Night"];

function getCurrentShift(date = new Date()) {
  const hour = date.getHours();
  if (hour >= 7 && hour < 15) return "Morning";
  if (hour >= 15 && hour < 23) return "Evening";
  return "Night";
}

// 0=Sunday..6=Saturday, matching the day_of_week convention already used by doctor_schedules.
function getCurrentDayOfWeek(date = new Date()) {
  return date.getDay();
}

function findWardNurse(roster, wardId, shift, dayOfWeek) {
  const match = roster.find(
    (r) => String(r.wardId) === String(wardId) && r.shift === shift && Number(r.dayOfWeek) === Number(dayOfWeek)
  );
  return match ? match.nurseUserId : null;
}

function findDoctorTeamNurse(teams, roster, doctorUserId, shift, dayOfWeek) {
  const teamNurseIds = teams
    .filter((t) => String(t.doctorUserId) === String(doctorUserId))
    .map((t) => t.nurseUserId);
  if (teamNurseIds.length === 0) return null;

  const onShift = roster.find(
    (r) => teamNurseIds.includes(r.nurseUserId) && r.shift === shift && Number(r.dayOfWeek) === Number(dayOfWeek)
  );
  return onShift ? onShift.nurseUserId : null;
}

// Pure decision function — no I/O. `roster` and `teams` are plain arrays already
// fetched from the DB, so this can be unit tested without a database.
function resolveNurseAssignment({ mode, wardId, doctorUserId, shift, dayOfWeek, roster = [], teams = [] }) {
  if (mode === "doctor_team" && doctorUserId) {
    const teamNurseId = findDoctorTeamNurse(teams, roster, doctorUserId, shift, dayOfWeek);
    if (teamNurseId) {
      return { nurseUserId: teamNurseId, source: "doctor_team", alert: false };
    }
  }

  const wardNurseId = findWardNurse(roster, wardId, shift, dayOfWeek);
  if (wardNurseId) {
    return { nurseUserId: wardNurseId, source: "ward_based", alert: false };
  }

  return { nurseUserId: null, source: "none", alert: true };
}

// DB-wiring shell around the pure function above — called the moment a bed is allocated.
// `pool` is this hospital's own dedicated database (ipd_admissions/roster/teams all
// live there); nurse_assignment_mode lives on the master `hospitals` row instead
// (see server/dbRouter.js), so that one lookup goes through masterPool directly.
async function assignNurseForAdmission(pool, hospitalId, admissionId) {
  const { masterPool } = require("./dbRouter");
  const [[hospitalRow]] = await masterPool.query("SELECT nurse_assignment_mode FROM hospitals WHERE id = ? LIMIT 1", [
    hospitalId,
  ]);
  const mode = hospitalRow?.nurse_assignment_mode || "ward_based";

  const [[admissionRow]] = await pool.query(
    `SELECT ward_id, admitting_doctor_user_id FROM ipd_admissions WHERE id = ? AND hospital_id = ? LIMIT 1`,
    [admissionId, hospitalId]
  );
  if (!admissionRow) return null;

  const [rosterRows] = await pool.query(
    `SELECT nurse_user_id AS nurseUserId, ward_id AS wardId, shift, day_of_week AS dayOfWeek
     FROM nurse_shift_roster WHERE hospital_id = ?`,
    [hospitalId]
  );
  const [teamRows] = await pool.query(
    `SELECT doctor_user_id AS doctorUserId, nurse_user_id AS nurseUserId FROM doctor_nurse_teams WHERE hospital_id = ?`,
    [hospitalId]
  );

  const result = resolveNurseAssignment({
    mode,
    wardId: admissionRow.ward_id,
    doctorUserId: admissionRow.admitting_doctor_user_id,
    shift: getCurrentShift(),
    dayOfWeek: getCurrentDayOfWeek(),
    roster: rosterRows,
    teams: teamRows,
  });

  await pool.query(`UPDATE ipd_admissions SET assigned_nurse_id = ? WHERE id = ? AND hospital_id = ?`, [
    result.nurseUserId,
    admissionId,
    hospitalId,
  ]);

  if (result.alert) {
    console.error(
      `[nurse-assignment] No nurse available for admission #${admissionId} in hospital ${hospitalId} (ward ${admissionRow.ward_id}).`
    );
    await pool.query(
      `INSERT INTO ipd_notes (hospital_id, ipd_admission_id, note_type, message, flagged_by)
       VALUES (?, ?, 'alert', ?, 'system')`,
      [
        hospitalId,
        admissionId,
        `No nurse could be auto-assigned for this admission (ward ${admissionRow.ward_id}). Manual assignment required.`,
      ]
    );
  }

  return result;
}

module.exports = {
  SHIFTS,
  getCurrentShift,
  getCurrentDayOfWeek,
  findWardNurse,
  findDoctorTeamNurse,
  resolveNurseAssignment,
  assignNurseForAdmission,
};
