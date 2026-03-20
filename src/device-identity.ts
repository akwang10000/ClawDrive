import * as fs from "fs";
import * as path from "path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "crypto";

interface StoredDeviceIdentity {
  version?: number;
  deviceId?: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
  createdAtMs?: number;
}

export interface DeviceIdentity {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
}

function tryLoadIdentity(filePath: string): DeviceIdentity | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as StoredDeviceIdentity;
    if (typeof parsed.publicKeyPem !== "string" || typeof parsed.privateKeyPem !== "string") {
      return null;
    }

    return {
      deviceId: fingerprintPublicKey(parsed.publicKeyPem),
      privateKeyPem: parsed.privateKeyPem,
      publicKeyPem: parsed.publicKeyPem,
    };
  } catch {
    return null;
  }
}

function persistIdentity(filePath: string, identity: DeviceIdentity): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stored: Required<StoredDeviceIdentity> = {
    version: 1,
    deviceId: identity.deviceId,
    privateKeyPem: identity.privateKeyPem,
    publicKeyPem: identity.publicKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}

export function loadOrCreateDeviceIdentity(
  preferredFilePath: string,
  legacyFilePaths: string[] = []
): DeviceIdentity {
  for (const candidatePath of [...legacyFilePaths, preferredFilePath]) {
    const identity = tryLoadIdentity(candidatePath);
    if (!identity) {
      continue;
    }

    if (candidatePath !== preferredFilePath) {
      persistIdentity(preferredFilePath, identity);
    } else {
      const raw = fs.readFileSync(candidatePath, "utf8");
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (parsed.deviceId !== identity.deviceId || parsed.version !== 1) {
        persistIdentity(preferredFilePath, identity);
      }
    }

    return identity;
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const identity: DeviceIdentity = {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    deviceId: "",
  };
  identity.deviceId = fingerprintPublicKey(identity.publicKeyPem);
  persistIdentity(preferredFilePath, identity);
  return identity;
}

export function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function signPayload(privateKeyPem: string, payload: string): string {
  return base64UrlEncode(sign(null, Buffer.from(payload, "utf8"), createPrivateKey(privateKeyPem)));
}
