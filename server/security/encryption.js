// AES-256-GCM field-level encryption for anything sensitive enough to
// encrypt at rest before it lands in a DB column — first consumer is
// server/security/auditLog.js (encrypting stored transcripts), but this is
// deliberately generic, not voice-specific.
//
// Key: ENCRYPTION_KEY in server/.env — 64 hex chars (32 bytes). Generate one
// with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Layout of the returned base64 string: iv(12 bytes) || authTag(16 bytes) ||
// ciphertext. Bundling all three together means callers never need to store
// iv/tag in separate columns — one opaque string round-trips through
// encryptField/decryptField.
const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Add it to server/.env — see server/security/encryption.js for how to generate one."
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes). See server/security/encryption.js.");
  }
  return key;
}

// Returns null for null/undefined input so callers can pass an optional
// field straight through without an if-check at every call site.
function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptField(encoded) {
  if (!encoded) return null;
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = buf.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { encryptField, decryptField };
