import { GARMIN_PASSWORD_ENC_KEY } from "astro:env/server";

/**
 * Server-only AES-GCM string encryption, reused for two Garmin secrets:
 * - the stored password (`garmin_credentials.garmin_password_encrypted`), a
 *   re-login fallback decrypted server-side to hand transiently to the sidecar;
 * - the ephemeral session cookie blob (see `garmin-session-cookie.ts`).
 *
 * Stored form: `base64(iv) + "." + base64(ciphertext)`.
 *
 * Uses the Workers-native WebCrypto API (`crypto.subtle`) — no Node-only deps,
 * so this runs unchanged in the Cloudflare Workers V8 isolate.
 */

const IV_BYTES = 12; // AES-GCM standard nonce length
const SEPARATOR = ".";

function getKeyMaterial(): string {
  if (!GARMIN_PASSWORD_ENC_KEY) {
    throw new Error("GARMIN_PASSWORD_ENC_KEY is not configured");
  }
  return GARMIN_PASSWORD_ENC_KEY;
}

/** Derive a 256-bit AES-GCM key from the arbitrary-length env secret via SHA-256. */
async function deriveKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(getKeyMaterial()));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encrypt an arbitrary UTF-8 string to `base64(iv).base64(ciphertext)`. */
export async function encryptString(plaintext: string): Promise<string> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return toBase64(iv) + SEPARATOR + toBase64(new Uint8Array(ciphertext));
}

/** Inverse of {@link encryptString}. Throws on a malformed or undecryptable blob. */
export async function decryptString(blob: string): Promise<string> {
  const [ivPart, ctPart] = blob.split(SEPARATOR);
  if (!ivPart || !ctPart) {
    throw new Error("Malformed encrypted blob");
  }
  const key = await deriveKey();
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(ivPart) }, key, fromBase64(ctPart));
  return new TextDecoder().decode(plaintext);
}

// Thin domain-named delegates so existing password callers are untouched.
export async function encryptPassword(plaintext: string): Promise<string> {
  return encryptString(plaintext);
}

export async function decryptPassword(blob: string): Promise<string> {
  return decryptString(blob);
}
