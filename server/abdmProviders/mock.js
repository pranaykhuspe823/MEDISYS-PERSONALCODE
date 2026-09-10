// Mock ABHA provider — canned profile data, zero network calls. Used when
// ABDM_PROVIDER=mock (the default), so the whole registration flow (fetch →
// OTP → auto-fill → UHID creation) works end-to-end without waiting on NHA
// sandbox approval or Eka Care signup.
//
// OTP is always "111111". A mobile/Aadhaar number ending in nine zeros
// (e.g. 6000000000) always "sends" successfully but resolves to no linked
// ABHA account, so the "No ABHA found" fallback UI can be exercised too.

function isConfigured() {
  return true;
}

async function requestLoginOtp(identifierType, identifierValue) {
  const isNotFoundSentinel = /0{9}$/.test(identifierValue);
  return { txnId: `mock-txn-${isNotFoundSentinel ? "notfound-" : ""}${Date.now()}-${Math.round(Math.random() * 1e6)}` };
}

async function verifyLoginOtp(txnId, otp) {
  assertOtp(otp);
  if (txnId.includes("notfound-")) {
    const err = new Error("No ABHA account found for this identifier.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return mockProfile();
}

async function requestEnrollmentOtp(_aadhaarNumber) {
  return { txnId: `mock-enroll-txn-${Date.now()}-${Math.round(Math.random() * 1e6)}` };
}

async function verifyEnrollmentOtp(_txnId, otp, _mobile) {
  assertOtp(otp);
  return mockProfile({ newlyCreated: true });
}

async function verifyBio(aadhaarNumber, mobile, pidXml) {
  if (typeof pidXml !== "string" || !pidXml.includes("<PidData")) {
    const err = new Error("Invalid fingerprint capture data.");
    err.code = "PROVIDER_ERROR";
    throw err;
  }
  if (!mobile) {
    const err = new Error("A mobile number is required to verify via fingerprint.");
    err.code = "PROVIDER_ERROR";
    throw err;
  }
  if (/0{9}$/.test(aadhaarNumber)) {
    const err = new Error("No ABHA account found for this identifier.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return mockProfile({ authMethod: "bio", mobile });
}

function assertOtp(otp) {
  if (String(otp) !== "111111") {
    const err = new Error("Invalid OTP. (Mock mode always uses 111111.)");
    err.code = "INVALID_OTP";
    throw err;
  }
}

function mockProfile(extra = {}) {
  return {
    abhaNumber: "91-1234-5678-9012",
    abhaAddress: "testpatient@abdm",
    name: "Test ABHA Patient",
    gender: "Male",
    dob: "1990-05-15",
    address: "123 Sample Street, Test City, Maharashtra, 400001",
    mobile: "9876543210",
    mock: true,
    ...extra,
  };
}

module.exports = {
  name: "mock",
  isConfigured,
  requestLoginOtp,
  verifyLoginOtp,
  requestEnrollmentOtp,
  verifyEnrollmentOtp,
  verifyBio,
};
