export type TokenVaultRecord = {
  version: 1;
  ciphertext: string;
  salt: string;
  iv: string;
  iterations: number;
  createdAt: string;
  updatedAt: string;
};

const TOKEN_VAULT_KEY = "quackalog.encrypted-token.v1";
const TOKEN_VAULT_ITERATIONS = 310_000;

export function isTokenVaultSupported(): boolean {
  try {
    return Boolean(
      window.crypto?.subtle &&
        typeof window.crypto.getRandomValues === "function" &&
        window.localStorage,
    );
  } catch {
    return false;
  }
}

export function readTokenVaultRecord(vaultId = "default"): TokenVaultRecord | null {
  try {
    const raw = window.localStorage.getItem(getTokenVaultKey(vaultId));

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<TokenVaultRecord>;

    if (
      parsed.version !== 1 ||
      typeof parsed.ciphertext !== "string" ||
      typeof parsed.salt !== "string" ||
      typeof parsed.iv !== "string" ||
      typeof parsed.iterations !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }

    return parsed as TokenVaultRecord;
  } catch {
    return null;
  }
}

export function hasTokenVaultRecord(vaultId = "default"): boolean {
  return readTokenVaultRecord(vaultId) !== null;
}

export function forgetTokenVaultRecord(vaultId = "default"): void {
  try {
    window.localStorage.removeItem(getTokenVaultKey(vaultId));
  } catch {
    // Local storage can be unavailable in privacy-restricted contexts.
  }
}

export async function saveEncryptedToken(token: string, passphrase: string, vaultId = "default"): Promise<TokenVaultRecord> {
  assertVaultSupport();

  const now = new Date().toISOString();
  const existing = readTokenVaultRecord(vaultId);
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt, TOKEN_VAULT_ITERATIONS);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
    key,
    new TextEncoder().encode(token),
  );
  const record: TokenVaultRecord = {
    version: 1,
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    iterations: TOKEN_VAULT_ITERATIONS,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  window.localStorage.setItem(getTokenVaultKey(vaultId), JSON.stringify(record));

  return record;
}

export async function unlockEncryptedToken(passphrase: string, vaultId = "default"): Promise<string> {
  assertVaultSupport();

  const record = readTokenVaultRecord(vaultId);

  if (!record) {
    throw new Error("No encrypted token is saved on this device.");
  }

  try {
    const salt = base64ToBytes(record.salt);
    const iv = base64ToBytes(record.iv);
    const ciphertext = base64ToBytes(record.ciphertext);
    const key = await deriveVaultKey(passphrase, salt, record.iterations);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
      key,
      bytesToArrayBuffer(ciphertext),
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("Passphrase could not unlock the saved token.");
  }
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: bytesToArrayBuffer(salt),
      iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertVaultSupport(): void {
  if (!isTokenVaultSupported()) {
    throw new Error("Encrypted token storage is not available in this browser.");
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";

  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }

  return btoa(value);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function getTokenVaultKey(vaultId: string): string {
  if (vaultId === "default") {
    return TOKEN_VAULT_KEY;
  }

  return `${TOKEN_VAULT_KEY}.${encodeURIComponent(vaultId)}`;
}
