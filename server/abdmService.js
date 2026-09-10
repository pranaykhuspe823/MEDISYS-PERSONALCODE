// ABDM (Ayushman Bharat Digital Mission) integration — provider-agnostic
// wrapper. Lets OPD registration fetch a patient's existing ABHA profile
// (name/DOB/gender/address/ABHA number & address) by mobile or Aadhaar + OTP,
// instead of typing it all manually.
//
// Which backend actually talks to ABDM is chosen by ABDM_PROVIDER:
//   mock    — canned profile data, no network calls (default; safe for dev/demo)
//   nha     — calls the NHA ABDM Gateway v3 directly (server/abdmProviders/nha.js)
//   ekacare — calls Eka Care's Connect API instead (server/abdmProviders/ekacare.js),
//             useful while an NHA sandbox approval email is pending
//
// Three lookup methods are supported: mobile + OTP, Aadhaar + OTP, and
// fingerprint (Mantra MFS110 scanner) — the last one verifies a staff-entered
// Aadhaar number against a captured PID block instead of an OTP, so it's a
// single one-shot call rather than a request/verify pair.
//
// Every provider returns the same normalized shape so the rest of the app
// never needs to know which one is active:
//   { abhaNumber, abhaAddress, name, gender, dob, address, mobile }
//
// Switching providers is a single .env change (ABDM_PROVIDER=nha or =ekacare)
// — no frontend or route code needs to change. Whoever wires up real
// credentials later: cross-check exact endpoint paths/payloads against ABDM's
// current Postman collection (nha) or Eka Care's developer docs (ekacare)
// before flipping ABDM_PROVIDER away from mock — both providers version their
// APIs and this was written without access to a live account on either.

const PROVIDERS = {
  mock: require("./abdmProviders/mock"),
  nha: require("./abdmProviders/nha"),
  ekacare: require("./abdmProviders/ekacare"),
};

function resolveProviderName() {
  if (process.env.ABDM_PROVIDER) return process.env.ABDM_PROVIDER.toLowerCase();
  // Back-compat with the older ABDM_MOCK=true flag from before providers existed.
  if (String(process.env.ABDM_MOCK || "").toLowerCase() === "true") return "mock";
  return "mock"; // default: works out of the box with no credentials
}

function getProvider() {
  const name = resolveProviderName();
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown ABDM_PROVIDER "${name}". Use mock, nha, or ekacare.`);
  }
  return provider;
}

function currentProviderName() {
  return resolveProviderName();
}

function isMock() {
  return resolveProviderName() === "mock";
}

function isConfigured() {
  try {
    return getProvider().isConfigured();
  } catch {
    return false;
  }
}

// Wrap a provider call so any unexpected/network-level failure (provider down,
// timeout, DNS failure, unversioned API change, etc.) surfaces as a distinct
// PROVIDER_ERROR code — callers use this to let staff continue registering the
// patient manually instead of hard-blocking on an ABDM outage.
async function callProvider(fn, ...args) {
  const provider = getProvider();
  if (!provider.isConfigured()) {
    const err = new Error(
      `ABHA integration (${provider.name}) isn't configured yet. Set the required credentials in the server .env, or set ABDM_PROVIDER=mock for testing.`
    );
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  try {
    return await provider[fn](...args);
  } catch (err) {
    if (err.code === "INVALID_OTP" || err.code === "NOT_FOUND" || err.code === "PROVIDER_ERROR") {
      throw err;
    }
    // Unrecognized failure (network error, unexpected response shape, etc.) —
    // treat as a provider outage rather than a client-facing validation error.
    const wrapped = new Error(`ABHA provider (${provider.name}) error: ${err.message}`);
    wrapped.code = "PROVIDER_ERROR";
    throw wrapped;
  }
}

async function requestLoginOtp(identifierType, identifierValue) {
  return callProvider("requestLoginOtp", identifierType, identifierValue);
}

async function verifyLoginOtp(txnId, otp, identifierType) {
  return callProvider("verifyLoginOtp", txnId, otp, identifierType);
}

async function requestEnrollmentOtp(aadhaarNumber) {
  return callProvider("requestEnrollmentOtp", aadhaarNumber);
}

async function verifyEnrollmentOtp(txnId, otp, mobile) {
  return callProvider("verifyEnrollmentOtp", txnId, otp, mobile);
}

async function verifyBio(aadhaarNumber, mobile, pidXml) {
  return callProvider("verifyBio", aadhaarNumber, mobile, pidXml);
}

module.exports = {
  isConfigured,
  isMock,
  currentProviderName,
  requestLoginOtp,
  verifyLoginOtp,
  requestEnrollmentOtp,
  verifyEnrollmentOtp,
  verifyBio,
};
