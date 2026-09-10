// NHA (National Health Authority) direct ABDM Gateway provider — ABDM_PROVIDER=nha.
//
// Real ABDM sandbox docs: https://sandbox.abdm.gov.in (free registration required
// for ABDM_CLIENT_ID / ABDM_CLIENT_SECRET). Endpoint paths/payload shapes below
// match the public "ABHA Number" API family as documented at the time of
// writing — ABDM versions its APIs, so re-check the current Postman collection
// in the sandbox portal before relying on this in production.

const crypto = require("crypto");

const GATEWAY_BASE_URL = process.env.ABDM_GATEWAY_BASE_URL || "https://dev.abdm.gov.in";
const ABHA_BASE_URL = process.env.ABDM_BASE_URL || "https://abhasbx.abdm.gov.in/abha/api";
const CLIENT_ID = process.env.ABDM_CLIENT_ID;
const CLIENT_SECRET = process.env.ABDM_CLIENT_SECRET;
const CM_ID = process.env.ABDM_CM_ID || "sbx";

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// Every V3 ABHA API call (public certificate, login, enrollment...) requires
// a fresh REQUEST-ID (UUID) and TIMESTAMP (ISO 8601) header on top of the
// bearer token, or the gateway rejects it with "ABDM-1016: Invalid Timestamp"
// — verified against the live sandbox on 2026-08-20. Only the /sessions
// token exchange itself is exempt.
function abhaHeaders(token, extra) {
  return {
    Authorization: `Bearer ${token}`,
    "X-CM-ID": CM_ID,
    "REQUEST-ID": crypto.randomUUID(),
    TIMESTAMP: new Date().toISOString(),
    ...extra,
  };
}

// ---------- Gateway session token (client-credentials grant), cached in-memory ----------
let cachedSession = null; // { token, expiresAt }

async function getSessionToken() {
  if (cachedSession && cachedSession.expiresAt > Date.now() + 30_000) {
    return cachedSession.token;
  }

  // NOTE: the v3 path (/api/hiecm/gateway/v3/sessions) 401s for our sandbox
  // bridge — verified against the live gateway on 2026-08-20. This older
  // v0.5 path is what our bridge (SBXID_061554) is actually authorized for
  // and returns a real accessToken/expiresIn pair. Re-check with ABDM support
  // if this bridge is ever upgraded to a v3-scoped one.
  const res = await fetch(`${GATEWAY_BASE_URL}/gateway/v0.5/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      grantType: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`ABDM session request failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  cachedSession = {
    token: data.accessToken,
    expiresAt: Date.now() + (Number(data.expiresIn) || 1800) * 1000,
  };
  return cachedSession.token;
}

// ---------- Public certificate, used to RSA-encrypt Aadhaar/mobile/OTP payloads ----------
let cachedCert = null; // { publicKey, fetchedAt }
const CERT_TTL_MS = 24 * 60 * 60 * 1000;

async function getPublicCertificate() {
  if (cachedCert && Date.now() - cachedCert.fetchedAt < CERT_TTL_MS) {
    return cachedCert.publicKey;
  }

  const token = await getSessionToken();
  const res = await fetch(`${ABHA_BASE_URL}/v3/profile/public/certificate`, {
    method: "GET",
    headers: abhaHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`ABDM public certificate request failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  // The gateway returns the raw base64 DER (SubjectPublicKeyInfo), not a
  // PEM-armored key — crypto.publicEncrypt needs proper PEM framing or it
  // throws "error:1E08010C:DECODER routines::unsupported". Verified against
  // the live sandbox on 2026-08-20.
  cachedCert = { publicKey: toPem(data.publicKey), fetchedAt: Date.now() };
  return cachedCert.publicKey;
}

function toPem(base64Der) {
  const body = base64Der.match(/.{1,64}/g).join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

function encryptWithPublicKey(plainText, publicKeyPem) {
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1",
    },
    Buffer.from(plainText, "utf8")
  );
  return encrypted.toString("base64");
}

// ---------- Login (existing ABHA holder): request OTP ----------
async function requestLoginOtp(identifierType, identifierValue) {
  const token = await getSessionToken();
  const publicKey = await getPublicCertificate();
  const encryptedId = encryptWithPublicKey(identifierValue, publicKey);

  const res = await fetch(`${ABHA_BASE_URL}/v3/profile/login/request/otp`, {
    method: "POST",
    headers: abhaHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      scope: identifierType === "aadhaar" ? ["abha-login", "aadhaar-verify"] : ["abha-login", "mobile-verify"],
      loginHint: identifierType,
      loginId: encryptedId,
      otpSystem: identifierType === "aadhaar" ? "aadhaar" : "abdm",
    }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    // A 404 here means ABDM found no ABHA linked to this mobile/Aadhaar at
    // all (e.g. ABDM-1115 "mobile number ... does not match with any of the
    // records") — a legitimate "not found" outcome, not a provider failure.
    // Without this, staff never saw the "Create New ABHA" fallback for
    // identifiers with no existing account. Verified against the live
    // sandbox on 2026-08-20.
    if (res.status === 404) {
      console.error(`ABDM OTP request: no ABHA for this identifier (${res.status}): ${detail}`);
      const err = new Error("No ABHA account found for this identifier.");
      err.code = "NOT_FOUND";
      throw err;
    }
    throw new Error(`ABDM OTP request failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return { txnId: data.txnId };
}

// ---------- Login: verify OTP, then fetch the ABHA profile ----------
// identifierType must match what requestLoginOtp used ("mobile"/"aadhaar") —
// the gateway ties the OTP's validity to the exact scope it was requested
// under, so verifying with a plain ["abha-login"] scope after requesting
// with ["abha-login","aadhaar-verify"]/["abha-login","mobile-verify"] gets
// rejected as "invalid OTP" even when the OTP digits are correct. Verified
// against the live sandbox on 2026-08-20.
async function verifyLoginOtp(txnId, otp, identifierType) {
  const token = await getSessionToken();
  const publicKey = await getPublicCertificate();
  const encryptedOtp = encryptWithPublicKey(otp, publicKey);
  const scope =
    identifierType === "aadhaar"
      ? ["abha-login", "aadhaar-verify"]
      : identifierType === "mobile"
      ? ["abha-login", "mobile-verify"]
      : ["abha-login"];

  const verifyRes = await fetch(`${ABHA_BASE_URL}/v3/profile/login/verify`, {
    method: "POST",
    headers: abhaHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      scope,
      authData: {
        authMethods: ["otp"],
        otp: { txnId, otpValue: encryptedOtp },
      },
    }),
  });
  if (!verifyRes.ok) {
    const detail = await safeText(verifyRes);
    if (verifyRes.status === 401 || verifyRes.status === 400) {
      console.error(`ABDM OTP verify rejected (${verifyRes.status}): ${detail}`);
      const err = new Error("Invalid or expired OTP.");
      err.code = "INVALID_OTP";
      throw err;
    }
    // The OTP itself checks out (verified against Aadhaar/mobile) but ABDM
    // has no ABHA account linked to that identifier — a legitimate "not
    // found" outcome (e.g. ABDM-1114 "No ABHA user registered with this
    // Aadhaar number"), not a provider failure. Route it to the same
    // NOT_FOUND path as the "no token in response" case below so the UI
    // offers "Create New ABHA" instead of a generic error.
    if (verifyRes.status === 404) {
      console.error(`ABDM OTP verify: no ABHA for this identifier (${verifyRes.status}): ${detail}`);
      const err = new Error("No ABHA account found for this identifier.");
      err.code = "NOT_FOUND";
      throw err;
    }
    throw new Error(`ABDM OTP verify failed (${verifyRes.status}): ${detail}`);
  }
  const verifyData = await verifyRes.json();
  const xToken = verifyData.token;
  if (!xToken) {
    const err = new Error("No ABHA account found for this identifier.");
    err.code = "NOT_FOUND";
    throw err;
  }

  // Authorization here must stay the GATEWAY session token (the same
  // `token` every other call in this file uses to authenticate MEDISYS
  // itself to ABDM) — xToken (the patient-specific token verifyRes.json()
  // just returned) only ever goes in the separate X-token header, which
  // identifies WHICH patient's account to fetch. This was passing xToken
  // as BOTH — wrong credential in Authorization — and produced a real,
  // reproducible "900900: Unclassified Authentication Failure" every time,
  // confirmed live, 2026-09-09 (multiple attempts, always failing at this
  // exact call after OTP verification itself succeeded cleanly). That fix
  // moved the failure from a generic "900900 unclassified" to a specific
  // "ABDM-1094 X-token expired" (401). Tried dropping the "Bearer " prefix
  // next, guessing X-token might not follow the Authorization header's
  // convention — wrong: that made it "Invalid X-token" (400) instead, and
  // public ABDM API references confirm "X-token: Bearer <token>" (with the
  // prefix) is the documented shape. Reverted to that. The real open
  // question is the genuine-looking expiry itself — this call fires
  // immediately after a successful verify with no meaningful delay in our
  // code, so if it's still rejected as expired, that points at something
  // other than elapsed time (e.g. a clock-sync/TIMESTAMP issue, or the
  // gateway `token` used for Authorization here being a stale cached one —
  // see getSessionToken()'s cache — rather than freshly issued alongside
  // this xToken). Needs a live retry to see if this alone was the last
  // piece, or whether the "expired" message needs investigating further.
  const accountRes = await fetch(`${ABHA_BASE_URL}/v3/profile/account`, {
    method: "GET",
    headers: abhaHeaders(token, { "X-token": `Bearer ${xToken}` }),
  });
  if (!accountRes.ok) {
    throw new Error(`ABDM profile fetch failed (${accountRes.status}): ${await safeText(accountRes)}`);
  }
  const account = await accountRes.json();
  return normalizeProfile(account);
}

// ---------- Create-new-ABHA fallback (Aadhaar OTP enrollment) ----------
async function requestEnrollmentOtp(aadhaarNumber) {
  const token = await getSessionToken();
  const publicKey = await getPublicCertificate();
  const encryptedAadhaar = encryptWithPublicKey(aadhaarNumber, publicKey);

  const res = await fetch(`${ABHA_BASE_URL}/v3/enrollment/request/otp`, {
    method: "POST",
    headers: abhaHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      scope: ["abha-enrol"],
      loginHint: "aadhaar",
      loginId: encryptedAadhaar,
      otpSystem: "aadhaar",
    }),
  });
  if (!res.ok) {
    throw new Error(`ABDM enrollment OTP request failed (${res.status}): ${await safeText(res)}`);
  }
  const data = await res.json();
  return { txnId: data.txnId };
}

async function verifyEnrollmentOtp(txnId, otp, mobile) {
  const token = await getSessionToken();
  const publicKey = await getPublicCertificate();
  const encryptedOtp = encryptWithPublicKey(otp, publicKey);

  // This is the SAME ABDM endpoint as verifyBio() below (byAadhaar,
  // swapping authMethods "otp" for "bio"), but the two auth methods don't
  // share an identical envelope — bio's flow (confirmed by live probing)
  // never needs a mobile field at all; otp's does. consent needing to be a
  // top-level {code, version} object (not a flat consentCode string) is
  // shared between both and was confirmed live, 2026-09-09 — the very next
  // attempt after fixing it no longer had consent in the rejection.
  //
  // mobile took two more (wrong) guesses to place correctly: top-level
  // plain, then top-level RSA-encrypted, both still rejected as "Invalid
  // Mobile Number" — turned out the validator wasn't even reading a
  // top-level field under any encoding (confirmed by testing four
  // different top-level variants that all produced the byte-identical
  // error). Structurally probing every remaining placement (dummy txnId/
  // otp, real public cert) pinned it down: PLAIN digits, nested inside
  // authData.otp — i.e. exactly where this file originally had it before
  // an earlier fix moved it out. "mobile" disappeared from the rejection
  // the moment it went back there, leaving only the (expected, since the
  // txnId/otp in that probe were dummy values) "Invalid Transaction Id".
  // mobile is REQUIRED here (this becomes the new ABHA's registered
  // contact number) — the caller must supply a real one, not the empty
  // phone field a fresh registration form starts with.
  if (!mobile) {
    const err = new Error("A mobile number is required to create a new ABHA.");
    err.code = "PROVIDER_ERROR";
    throw err;
  }
  const res = await fetch(`${ABHA_BASE_URL}/v3/enrollment/enrol/byAadhaar`, {
    method: "POST",
    headers: abhaHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      consent: { code: "abha-enrollment", version: "1.4" },
      authData: {
        authMethods: ["otp"],
        otp: { txnId, otpValue: encryptedOtp, mobile },
      },
    }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    if (res.status === 401 || res.status === 400) {
      // Was throwing INVALID_OTP here with no console.error at all, unlike
      // every other verify path in this file — the real ABDM rejection
      // reason (often something other than a genuinely wrong OTP; e.g. a
      // scope/consent mismatch) was silently discarded. Fixed 2026-09-09
      // while chasing exactly this blind spot.
      console.error(`ABDM enrollment verify rejected (${res.status}): ${detail}`);
      const err = new Error("Invalid or expired OTP.");
      err.code = "INVALID_OTP";
      throw err;
    }
    throw new Error(`ABDM enrollment verify failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return normalizeProfile(data.ABHAProfile || data);
}

// ---------- Fingerprint (Mantra MFS110) enrollment ----------
// FIXED 2026-09-09 — the previous version of this function (aadhaarNumber +
// consent + authData.bioDto.fingerPrintAuthPid, no txnId) was a reverse-
// engineered guess and was WRONG. It happened to occasionally get past
// ABDM's gateway-level checks (real bridge auth, valid session token, valid
// consent object) but always failed at the actual bio-match step with the
// generic content-validation error `{"bioDto":"Invalid Aadhaar bio
// request"}` — which looked exactly like "wrong finger/wrong Aadhaar" and
// was misdiagnosed as that at first. It's actually a wrong ENVELOPE: ABDM's
// official ABHA V3 API Integrator Guide (section 11.2 "Create ABHA via
// Biometric", sandboxcms.abdm.gov.in) documents biometric enrollment as
// the SAME two-step txnId flow as OTP enrollment (see requestEnrollmentOtp
// + verifyEnrollmentOtp above), not a one-shot call:
//   Step 1: POST /v3/enrollment/request/otp with the Aadhaar (RSA-encrypted)
//           — same call requestEnrollmentOtp() below already makes for the
//           Aadhaar-OTP path. This is required even for bio auth (it
//           anchors the transaction and DOES send a real OTP SMS to the
//           Aadhaar-linked mobile as a side effect — unused here, the
//           fingerprint scan replaces entering that OTP).
//   Step 2: POST /v3/enrollment/enrol/byAadhaar with:
//     { authData: { authMethods: ["bio"],
//                    bio: { timeStamp, txnId, fingerPrintAuthPid, mobile } },
//       consent: { code: "abha-enrollment", version: "1.4" } }
//   — key is "bio", NOT "bioDto"; no aadhaarNumber field at all (the
//   Aadhaar was already consumed by step 1's txnId); timeStamp and a plain
//   "mobile" (the ABHA's primary contact number) are BOTH required
//   alongside fingerPrintAuthPid, mirroring the OTP variant's shape exactly
//   (see verifyEnrollmentOtp above — same consent object, same endpoint,
//   only authMethods/the inner object differ).
async function verifyBio(aadhaarNumber, mobile, pidXml) {
  if (!mobile) {
    const err = new Error("A mobile number is required to verify via fingerprint.");
    err.code = "PROVIDER_ERROR";
    throw err;
  }

  const { txnId } = await requestEnrollmentOtp(aadhaarNumber);

  const token = await getSessionToken();
  const base64PidXml = Buffer.from(pidXml, "utf8").toString("base64");
  const timeStamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  const res = await fetch(`${ABHA_BASE_URL}/v3/enrollment/enrol/byAadhaar`, {
    method: "POST",
    headers: abhaHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      consent: { code: "abha-enrollment", version: "1.4" },
      authData: {
        authMethods: ["bio"],
        bio: { timeStamp, txnId, fingerPrintAuthPid: base64PidXml, mobile },
      },
    }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    if (res.status === 400 || res.status === 401) {
      console.error(`ABDM biometric enrollment rejected (${res.status}): ${detail}`);
      const err = new Error("Fingerprint didn't match or capture invalid.");
      err.code = "PROVIDER_ERROR";
      throw err;
    }
    if (res.status === 404) {
      console.error(`ABDM biometric enrollment: Aadhaar not found (${res.status}): ${detail}`);
      const err = new Error("This Aadhaar number isn't recognized by ABDM.");
      err.code = "NOT_FOUND";
      throw err;
    }
    throw new Error(`ABDM biometric enrollment failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return normalizeProfile(data.ABHAProfile || data);
}

// ---------- Helpers ----------
function normalizeProfile(raw) {
  const dob =
    raw.dob ||
    (raw.yearOfBirth
      ? `${raw.yearOfBirth}-${String(raw.monthOfBirth || 1).padStart(2, "0")}-${String(raw.dayOfBirth || 1).padStart(2, "0")}`
      : null);
  const addressParts = [raw.address, raw.districtName, raw.stateName, raw.pincode].filter(Boolean);
  return {
    abhaNumber: raw.ABHANumber || raw.healthIdNumber || raw.abhaNumber || null,
    abhaAddress: raw.healthId || raw.abhaAddress || raw.preferredAbhaAddress || null,
    name: raw.name || [raw.firstName, raw.middleName, raw.lastName].filter(Boolean).join(" ") || null,
    gender: raw.gender === "M" ? "Male" : raw.gender === "F" ? "Female" : raw.gender === "O" ? "Other" : raw.gender || null,
    dob,
    mobile: raw.mobile || null,
    address: addressParts.length ? addressParts.join(", ") : null,
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
  name: "nha",
  isConfigured,
  requestLoginOtp,
  verifyLoginOtp,
  requestEnrollmentOtp,
  verifyEnrollmentOtp,
  verifyBio,
};
