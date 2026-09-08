// Thin compatibility shim: standalone scripts (seed.js, demo-seed.js,
// check-date.js, etc.) only ever need "a" connection and keep working
// unchanged against the master database. Real request-handling code should
// use req.db (see server.js role-gate middlewares) for hospital-scoped
// tables, or dbRouter's masterPool/getHospitalPool directly for the
// hospital directory / login / superadmin routes.
const { masterPool, getHospitalPool } = require("./dbRouter");

module.exports = masterPool;
module.exports.getHospitalPool = getHospitalPool;
