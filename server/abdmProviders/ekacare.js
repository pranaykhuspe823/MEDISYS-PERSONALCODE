// Eka Care Connect API provider — ABDM_PROVIDER=ekacare. An alternative to
// calling NHA's ABDM Gateway directly, useful while an NHA sandbox approval
// email is pending (Eka Care is an approved ABDM "Connect" intermediary).
//
// Endpoint paths/payload shapes below are taken from Eka Care's published
// developer docs (https://developer.eka.care/api-reference/user-app/abdm-connect)
// as of the time of writing. Eka Care versions its API — re-check the docs if
// a call starts failing after they ship changes.
//
// Auth: EKACARE_API_KEY is used two different ways depending on what you were
// issued (see https://developer.eka.care/api-reference/authorization):
//   - If you also set EKACARE_CLIENT_SECRET: EKACARE_API_KEY is treated as a
//     client_id and exchanged for a short-lived access token via
//     POST /connect-auth/v1/account/login, cached until near-expiry.
//   - Otherwise: EKACARE_API_KEY is used directly as a long-lived bearer
//     token ("Generate directly from the Developer Console for backend-to-
//     backend communication" per their auth docs) — no exchange step.

const BASE_URL = process.env.EKACARE_BASE_URL || "https://api.eka.care";
const API_KEY = process.env.EKACARE_API_KEY;
const CLIENT_SECRET = process.env.EKACARE_CLIENT_SECRET;
const HIP_ID = process.env.EKACARE_HIP_ID; // optional partner HIP id, sent as X-Hip-Id if set

function isConfigured() {
  return Boolean(API_KEY);
}

// ---------- Access token: either the API key used as-is, or exchanged via client credentials ----------
let cachedToken = null; // { token, expiresAt } — only used when exchanging client_id/secret

async function getAccessToken() {
  if (!CLIENT_SECRET) {
    return API_KEY; // long-lived token, used directly
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const res = await fetch(`${BASE_URL}/connect-auth/v1/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: API_KEY, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) {
    throw new Error(`Eka Care auth failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000,
  };
  return cachedToken.token;
}

async function authHeaders() {
  const token = await getAccessToken();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (HIP_ID) headers["X-Hip-Id"] = HIP_ID;
  return headers;
}

// ---------- Login (existing ABHA holder) via mobile or Aadhaar + OTP ----------
async function requestLoginOtp(identifierType, identifierValue) {
  const res = await fetch(`${BASE_URL}/abdm/na/v1/profile/login/init`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      method: identifierType === "aadhaar" ? "aadhaar_number" : "mobile",
      identifier: identifierValue,
      otp_system: identifierType === "aadhaar" ? "aadhaar" : "abdm",
    }),
  });
  if (!res.ok) {
    throw new Error(`Eka Care login-init failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  if (!data.txn_id) {
    throw new Error("Eka Care login-init returned no txn_id.");
  }
  return { txnId: data.txn_id };
}

async function verifyLoginOtp(txnId, otp) {
  const res = await fetch(`${BASE_URL}/abdm/na/v1/profile/login/verify`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ txn_id: txnId, otp }),
  });
  if (!res.ok) {
    // Eka Care's docs don't distinguish "invalid OTP" from "no ABHA" via status
    // code — both come back as a generic 4XX error object.
    const err = new Error("Invalid or expired OTP.");
    err.code = "INVALID_OTP";
    throw err;
  }
  const data = await res.json();

  if (data.skip_state === "abha_create") {
    const err = new Error("No ABHA account found for this identifier.");
    err.code = "NOT_FOUND";
    throw err;
  }

  // `profile` carries the full demographic record; `abha_profiles[0]` is a
  // lighter fallback (name + abha_address only) used when multiple ABHA
  // accounts exist and Eka Care expects the caller to let the patient pick
  // one (skip_state: "abha_select") — we just take the first for now.
  const rawProfile = data.profile || (Array.isArray(data.abha_profiles) && data.abha_profiles[0]);
  if (!rawProfile) {
    const err = new Error("No ABHA account found for this identifier.");
    err.code = "NOT_FOUND";
    throw err;
  }
  return normalizeProfile(rawProfile);
}

// ---------- Create-new-ABHA fallback (Aadhaar OTP enrollment) ----------
async function requestEnrollmentOtp(aadhaarNumber) {
  const res = await fetch(`${BASE_URL}/abdm/na/v1/registration/aadhaar/init`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ aadhaar_number: aadhaarNumber }),
  });
  if (!res.ok) {
    throw new Error(`Eka Care Aadhaar-init failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  if (!data.txn_id) {
    throw new Error("Eka Care Aadhaar-init returned no txn_id.");
  }
  return { txnId: data.txn_id };
}

async function verifyEnrollmentOtp(txnId, otp, mobile) {
  const res = await fetch(`${BASE_URL}/abdm/na/v1/registration/aadhaar/verify`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ txn_id: txnId, otp }),
  });
  if (!res.ok) {
    const err = new Error("Invalid or expired OTP.");
    err.code = "INVALID_OTP";
    throw err;
  }
  const data = await res.json();

  // The real flow can require a *second* OTP round-trip (sent to the
  // Aadhaar-linked mobile) before an ABHA can be created — our current
  // single-OTP enrollment UI doesn't drive that extra step yet. Surface a
  // clear error rather than silently doing the wrong thing.
  if (data.skip_state === "confirm_mobile_otp") {
    const err = new Error(
      "Eka Care requires a second OTP sent to the Aadhaar-linked mobile number to finish creating this ABHA — that step isn't wired up in this form yet. Try the mock or nha provider, or complete registration manually."
    );
    err.code = "PROVIDER_ERROR";
    throw err;
  }

  const rawProfile = data.profile || (Array.isArray(data.abha_profiles) && data.abha_profiles[0]);
  if (!rawProfile) {
    throw new Error("Eka Care Aadhaar-verify did not return a profile.");
  }
  return normalizeProfile({ ...rawProfile, newlyCreated: true });
}

// ---------- Fingerprint (Mantra MFS110) verification — not supported ----------
// Eka Care's documented Connect API
// (https://developer.eka.care/api-reference/user-app/abdm-connect) only
// exposes OTP-based login and Aadhaar-OTP enrollment — no biometric/
// fingerprint auth method. Fail loudly rather than guess at an endpoint
// that isn't in their docs.
async function verifyBio(_aadhaarNumber, _mobile, _pidXml) {
  const err = new Error(
    "Biometric (fingerprint) ABHA verification isn't supported via Eka Care's documented API. Switch ABDM_PROVIDER=nha for fingerprint auth, or fall back to manual/OTP registration."
  );
  err.code = "PROVIDER_ERROR";
  throw err;
}

// ---------- Helpers ----------
function normalizeProfile(raw) {
  const dob =
    raw.day_of_birth && raw.month_of_birth && raw.year_of_birth
      ? `${raw.year_of_birth}-${String(raw.month_of_birth).padStart(2, "0")}-${String(raw.day_of_birth).padStart(2, "0")}`
      : raw.dob || null;
  const addressParts = [raw.address, raw.district_name, raw.state_name, raw.pincode].filter(Boolean);
  return {
    abhaNumber: raw.abha_number || null,
    abhaAddress: raw.abha_address || (Array.isArray(raw.abha_addresses) ? raw.abha_addresses[0] : null) || null,
    name: raw.full_name || raw.name || [raw.first_name, raw.middle_name, raw.last_name].filter(Boolean).join(" ") || null,
    gender: raw.gender === "M" ? "Male" : raw.gender === "F" ? "Female" : raw.gender === "O" ? "Other" : raw.gender || null,
    dob,
    mobile: raw.mobile || null,
    address: addressParts.length ? addressParts.join(", ") : null,
    newlyCreated: raw.newlyCreated || undefined,
  };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

module.exports = {
  name: "ekacare",
  isConfigured,
  requestLoginOtp,
  verifyLoginOtp,
  requestEnrollmentOtp,
  verifyEnrollmentOtp,
  verifyBio,
};
