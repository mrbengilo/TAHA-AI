import { requireEnv } from "./env";
import type { ProviderId } from "./providers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_AAD = encoder.encode("taha-ai:integration-token:v1");

export type OAuthStatePayload = {
  provider: ProviderId;
  nonce: string;
  exp: number;
  returnTo: string;
};

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmacHex(secret: string, value: string) {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function createSignedState(provider: ProviderId, returnTo = "/connections") {
  const payload: OAuthStatePayload = {
    provider,
    nonce: crypto.randomUUID(),
    exp: Date.now() + 10 * 60 * 1000,
    returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/connections",
  };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(requireEnv("OAUTH_STATE_SECRET"));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
  return { token: `${encoded}.${toBase64Url(new Uint8Array(signature))}`, payload };
}

export async function verifySignedState(token: string): Promise<OAuthStatePayload> {
  const [encoded, signatureValue, extra] = token.split(".");
  if (!encoded || !signatureValue || extra) throw new Error("OAUTH_STATE_INVALID");
  const key = await importHmacKey(requireEnv("OAUTH_STATE_SECRET"));
  const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(signatureValue), encoder.encode(encoded));
  if (!valid) throw new Error("OAUTH_STATE_INVALID");

  const payload = JSON.parse(decoder.decode(fromBase64Url(encoded))) as OAuthStatePayload;
  if (!payload.nonce || !payload.provider || payload.exp <= Date.now()) throw new Error("OAUTH_STATE_EXPIRED");
  return payload;
}

function integrationKeyBytes() {
  const encoded = requireEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY");
  const bytes = fromBase64Url(encoded);
  if (bytes.length !== 32) throw new Error("INTEGRATION_KEY_INVALID");
  return bytes;
}

async function importEncryptionKey() {
  return crypto.subtle.importKey("raw", integrationKeyBytes(), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredentials(value: Record<string, unknown>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: TOKEN_AAD, tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return {
    ciphertext: toBase64Url(new Uint8Array(encrypted)),
    iv: toBase64Url(iv),
    keyVersion: 1,
  };
}

export async function decryptCredentials<T extends Record<string, unknown>>(ciphertext: string, iv: string): Promise<T> {
  const key = await importEncryptionKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: TOKEN_AAD, tagLength: 128 },
    key,
    fromBase64Url(ciphertext),
  );
  return JSON.parse(decoder.decode(decrypted)) as T;
}
