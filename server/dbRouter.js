// Two-tier connection layer for per-hospital database isolation.
//
// masterPool connects to a small "router" database (medisys_master) holding
// only the tables that must be queryable BEFORE we know which hospital a
// request belongs to: `hospitals` (the directory, now with a `db_name`
// column), `user_directory` (user_id -> hospital_id, looked up at login
// before any hospital context exists), and superadmin rows in `users`
// (hospital_id IS NULL, resolved the same hospital-agnostic way).
//
// getHospitalPool(hospitalId) returns a lazily-created, cached pool pointed
// at that specific hospital's own dedicated database (same MySQL server,
// same credentials — only `database` differs, the same pattern already
// proven by the medisys_pharmacy cross-database tables). Every real
// clinical/business table (patients, users' staff rows, opd_visits, bills,
// the whole multi-entity import pipeline, etc.) lives in the hospital's own
// database, never in the master one.
require("dotenv").config();
const mysql = require("mysql2/promise");

const baseConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
};

const MASTER_DB_NAME = process.env.MASTER_DB_NAME || "medisys_master";

const masterPool = mysql.createPool({ ...baseConfig, database: MASTER_DB_NAME });

// hospitalId -> Pool. Small, unbounded cache — fine at real-world hospital-
// count scale (dozens to low hundreds), each pool only opens connections
// lazily as that hospital's own traffic needs them.
const hospitalPools = new Map();

async function getHospitalPool(hospitalId) {
  if (hospitalPools.has(hospitalId)) return hospitalPools.get(hospitalId);

  const [[row]] = await masterPool.query("SELECT db_name FROM hospitals WHERE id = ? LIMIT 1", [hospitalId]);
  if (!row || !row.db_name) {
    throw new Error(`No database is provisioned for hospital ${hospitalId}.`);
  }

  const pool = mysql.createPool({ ...baseConfig, database: row.db_name });
  hospitalPools.set(hospitalId, pool);
  return pool;
}

// Onboarding needs to create a brand-new database and hand back a pool for
// it before that hospital's row (and its db_name) even exists in master —
// this bypasses the master lookup and builds the pool directly from a known
// db_name, then caches it under the new hospital's id for reuse afterward.
function registerHospitalPool(hospitalId, dbName) {
  const pool = mysql.createPool({ ...baseConfig, database: dbName });
  hospitalPools.set(hospitalId, pool);
  return pool;
}

// Slugifies a hospital name into the `medisys_h<id>_<slug>` convention
// already established by the very first hospital's database name.
function hospitalDbName(hospitalId, hospitalName) {
  const slug = String(hospitalName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `medisys_h${hospitalId}_${slug || "hospital"}`;
}

// A standalone (non-pooled) connection for one-off database provisioning —
// CREATE DATABASE + changeUser() to point at it. Deliberately NOT borrowed
// from masterPool: changeUser() permanently repoints whichever physical
// connection it's called on, and a pooled connection gets handed back to
// the pool afterward — a later masterPool.query() could silently reuse that
// same connection still pointed at the wrong (just-created) database. This
// one is discarded (connection.end()) right after provisioning instead.
async function createStandaloneConnection() {
  return mysql.createConnection(baseConfig);
}

// Closes and evicts a hospital's cached pool (e.g. right before dropping its
// database on hospital deletion) so nothing keeps a dangling connection open
// to a database that's about to disappear.
async function closeHospitalPool(hospitalId) {
  const pool = hospitalPools.get(hospitalId);
  if (!pool) return;
  hospitalPools.delete(hospitalId);
  try {
    await pool.end();
  } catch {
    /* best-effort close */
  }
}

module.exports = {
  masterPool,
  getHospitalPool,
  registerHospitalPool,
  closeHospitalPool,
  createStandaloneConnection,
  hospitalDbName,
  baseConfig,
  MASTER_DB_NAME,
};
