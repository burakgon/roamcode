export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_HANDSHAKE_MAX_SKEW_MS = 5 * 60_000;
export const RELAY_CHANNEL_MAX_AGE_MS = 30 * 60_000;
export const RELAY_CHANNEL_MAX_FRAMES = 1_000_000;
export const RELAY_MAX_PLAINTEXT_BYTES = 1024 * 1024;

const HANDSHAKE_DOMAIN = "roamcode-relay-handshake-v1";
const KEY_SCHEDULE_DOMAIN = "roamcode-relay-key-schedule-v1";
const TRAFFIC_DOMAIN = "roamcode-relay-traffic-v1";
const FRAME_DOMAIN = "roamcode-relay-frame-v1";
const AUTH_TAG_BYTES = 16;
const MAX_SEQUENCE = (1n << 64n) - 1n;

export type RelayRole = "device" | "host";
export type RelayDirection = "device-to-host" | "host-to-device";
export type RelayFrameKind =
  "auth" | "rpc-request" | "rpc-response" | "stream-open" | "stream-data" | "stream-control" | "close";

const FRAME_KINDS = new Set<RelayFrameKind>([
  "auth",
  "rpc-request",
  "rpc-response",
  "stream-open",
  "stream-data",
  "stream-control",
  "close",
]);

export type BrowserRelayCryptoErrorCode =
  | "INVALID_RELAY_IDENTITY"
  | "INVALID_RELAY_HELLO"
  | "RELAY_IDENTITY_MISMATCH"
  | "RELAY_SIGNATURE_INVALID"
  | "RELAY_HANDSHAKE_EXPIRED"
  | "RELAY_HANDSHAKE_MISMATCH"
  | "RELAY_FRAME_INVALID"
  | "RELAY_FRAME_OUT_OF_ORDER"
  | "RELAY_FRAME_AUTH_FAILED"
  | "RELAY_FRAME_TOO_LARGE"
  | "RELAY_KEY_ROTATION_REQUIRED"
  | "RELAY_CHANNEL_CLOSED";

export class BrowserRelayCryptoError extends Error {
  constructor(
    readonly code: BrowserRelayCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserRelayCryptoError";
  }
}

export interface BrowserRelayIdentity {
  publicKey: string;
  /** Non-extractable signing key; persist the CryptoKey in IndexedDB, never serialize it. */
  privateKey: CryptoKey;
  fingerprint: string;
}

export interface BrowserRelayEphemeralKeyPair {
  publicKey: string;
  publicCryptoKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface RelayHandshakeHello {
  v: typeof RELAY_PROTOCOL_VERSION;
  role: RelayRole;
  routeId: string;
  deviceId: string;
  sessionId: string;
  issuedAt: number;
  nonce: string;
  ephemeralPublicKey: string;
  identityFingerprint: string;
  signature: string;
}

export interface RelayEncryptedFrame {
  v: typeof RELAY_PROTOCOL_VERSION;
  sessionId: string;
  seq: string;
  kind: RelayFrameKind;
  ciphertext: string;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "Web Crypto unavailable");
  return globalThis.crypto.subtle;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(length);
  globalThis.crypto.getRandomValues(value);
  return value;
}

function concat(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, Math.min(value.byteLength, offset + 0x8000)));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(
  value: unknown,
  field: string,
  maxBytes: number,
  code: BrowserRelayCryptoErrorCode = "INVALID_RELAY_HELLO",
): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BrowserRelayCryptoError(code, `invalid relay ${field}`);
  }
  let binary: string;
  try {
    binary = atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
  } catch {
    throw new BrowserRelayCryptoError(code, `invalid relay ${field}`);
  }
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!decoded.byteLength || decoded.byteLength > maxBytes || toBase64Url(decoded) !== value) {
    throw new BrowserRelayCryptoError(code, `invalid relay ${field}`);
  }
  return decoded;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", `invalid relay ${field}`);
  }
  return value;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

function encodeFields(domain: string, fields: readonly (string | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const values = [utf8(domain), ...fields.map((field) => (typeof field === "string" ? utf8(field) : field))];
  const output: Uint8Array[] = [];
  for (const value of values) {
    if (value.byteLength > 1024 * 1024) {
      throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "relay field too large");
    }
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, value.byteLength, false);
    output.push(length, value);
  }
  return concat(...output);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

async function fingerprint(publicKey: string): Promise<string> {
  const der = fromBase64Url(publicKey, "public key", 512, "INVALID_RELAY_IDENTITY");
  try {
    await subtle().importKey("spki", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay public key must be P-256 SPKI");
  }
  return `sha256:${toBase64Url(new Uint8Array(await subtle().digest("SHA-256", der)))}`;
}

export async function browserRelayIdentityFingerprint(publicKey: string): Promise<string> {
  return fingerprint(publicKey);
}

export async function validateBrowserRelayIdentity(value: unknown): Promise<BrowserRelayIdentity> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity is invalid");
  }
  const identity = value as Partial<BrowserRelayIdentity>;
  if (
    typeof identity.publicKey !== "string" ||
    typeof identity.fingerprint !== "string" ||
    !(identity.privateKey instanceof CryptoKey) ||
    identity.privateKey.type !== "private" ||
    identity.privateKey.extractable ||
    identity.privateKey.algorithm.name !== "ECDSA" ||
    (identity.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
    !identity.privateKey.usages.includes("sign")
  ) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity is invalid");
  }
  const actualFingerprint = await fingerprint(identity.publicKey);
  if (actualFingerprint !== identity.fingerprint) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity fingerprint does not match");
  }
  const challenge = encodeFields("roamcode-relay-identity-proof-v1", [randomBytes(32)]);
  try {
    const publicKey = await subtle().importKey(
      "spki",
      fromBase64Url(identity.publicKey, "identity public key", 512),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, challenge);
    if (!(await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, challenge))) {
      throw new Error("key mismatch");
    }
  } catch {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay public and private keys do not match");
  }
  return {
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    fingerprint: identity.fingerprint,
  };
}

export async function generateBrowserRelayIdentity(): Promise<BrowserRelayIdentity> {
  const pair = (await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = toBase64Url(new Uint8Array(await subtle().exportKey("spki", pair.publicKey)));
  return validateBrowserRelayIdentity({
    publicKey,
    privateKey: pair.privateKey,
    fingerprint: await fingerprint(publicKey),
  });
}

export async function generateBrowserRelayEphemeralKeyPair(): Promise<BrowserRelayEphemeralKeyPair> {
  const pair = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    publicKey: toBase64Url(new Uint8Array(await subtle().exportKey("spki", pair.publicKey))),
    publicCryptoKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

function helloTranscript(hello: Omit<RelayHandshakeHello, "signature">): Uint8Array<ArrayBuffer> {
  const nonce = fromBase64Url(hello.nonce, "nonce", 32);
  if (nonce.byteLength !== 32) throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "relay nonce must be 32 bytes");
  const ephemeral = fromBase64Url(hello.ephemeralPublicKey, "ephemeral public key", 512);
  if (!Number.isSafeInteger(hello.issuedAt) || hello.issuedAt < 0) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "invalid relay issue time");
  }
  if (hello.v !== RELAY_PROTOCOL_VERSION || (hello.role !== "device" && hello.role !== "host")) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "unsupported relay handshake");
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(hello.identityFingerprint)) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "invalid relay identity fingerprint");
  }
  return encodeFields(HANDSHAKE_DOMAIN, [
    String(hello.v),
    hello.role,
    safeId(hello.routeId, "route id"),
    safeId(hello.deviceId, "device id"),
    safeId(hello.sessionId, "session id"),
    String(hello.issuedAt),
    nonce,
    ephemeral,
    hello.identityFingerprint,
  ]);
}

export async function createBrowserRelayHandshakeHello(input: {
  role: RelayRole;
  routeId: string;
  deviceId: string;
  identity: BrowserRelayIdentity;
  sessionId?: string;
  ephemeral?: BrowserRelayEphemeralKeyPair;
  issuedAt?: number;
  nonce?: Uint8Array;
}): Promise<{ hello: RelayHandshakeHello; ephemeral: BrowserRelayEphemeralKeyPair }> {
  if (input.identity.privateKey.type !== "private" || input.identity.privateKey.algorithm.name !== "ECDSA") {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay signing key is invalid");
  }
  const actualFingerprint = await fingerprint(input.identity.publicKey);
  if (actualFingerprint !== input.identity.fingerprint) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity fingerprint does not match");
  }
  const ephemeral = input.ephemeral ?? (await generateBrowserRelayEphemeralKeyPair());
  const unsigned: Omit<RelayHandshakeHello, "signature"> = {
    v: RELAY_PROTOCOL_VERSION,
    role: input.role,
    routeId: safeId(input.routeId, "route id"),
    deviceId: safeId(input.deviceId, "device id"),
    sessionId: safeId(input.sessionId ?? toBase64Url(randomBytes(16)), "session id"),
    issuedAt: input.issuedAt ?? Date.now(),
    nonce: toBase64Url(input.nonce ?? randomBytes(32)),
    ephemeralPublicKey: ephemeral.publicKey,
    identityFingerprint: actualFingerprint,
  };
  let signature: ArrayBuffer;
  try {
    signature = await subtle().sign(
      { name: "ECDSA", hash: "SHA-256" },
      input.identity.privateKey,
      helloTranscript(unsigned),
    );
  } catch {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay signing key cannot sign");
  }
  if (signature.byteLength !== 64) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "browser ECDSA implementation is incompatible");
  }
  return { hello: { ...unsigned, signature: toBase64Url(new Uint8Array(signature)) }, ephemeral };
}

export async function verifyBrowserRelayHandshakeHello(
  hello: RelayHandshakeHello,
  expected: {
    role: RelayRole;
    routeId: string;
    deviceId: string;
    sessionId: string;
    identityPublicKey: string;
    now?: number;
    maxSkewMs?: number;
  },
): Promise<void> {
  const { signature, ...unsigned } = hello;
  const transcript = helloTranscript(unsigned);
  if (
    hello.role !== expected.role ||
    hello.routeId !== expected.routeId ||
    hello.deviceId !== expected.deviceId ||
    hello.sessionId !== expected.sessionId
  ) {
    throw new BrowserRelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "relay handshake context does not match");
  }
  const actualFingerprint = await fingerprint(expected.identityPublicKey);
  if (hello.identityFingerprint !== actualFingerprint) {
    throw new BrowserRelayCryptoError("RELAY_IDENTITY_MISMATCH", "relay identity does not match the pinned key");
  }
  const now = expected.now ?? Date.now();
  const maxSkewMs = expected.maxSkewMs ?? RELAY_HANDSHAKE_MAX_SKEW_MS;
  if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 1_000 || Math.abs(now - hello.issuedAt) > maxSkewMs) {
    throw new BrowserRelayCryptoError(
      "RELAY_HANDSHAKE_EXPIRED",
      "relay handshake is outside the accepted clock window",
    );
  }
  const rawSignature = fromBase64Url(signature, "signature", 128);
  if (rawSignature.byteLength !== 64) {
    throw new BrowserRelayCryptoError("RELAY_SIGNATURE_INVALID", "relay handshake signature is invalid");
  }
  let key: CryptoKey;
  try {
    key = await subtle().importKey(
      "spki",
      fromBase64Url(expected.identityPublicKey, "identity public key", 512),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new BrowserRelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity public key is invalid");
  }
  if (!(await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, rawSignature, transcript))) {
    throw new BrowserRelayCryptoError("RELAY_SIGNATURE_INVALID", "relay handshake signature is invalid");
  }
}

function sessionTranscript(device: RelayHandshakeHello, host: RelayHandshakeHello): Uint8Array<ArrayBuffer> {
  const { signature: deviceSignature, ...unsignedDevice } = device;
  const { signature: hostSignature, ...unsignedHost } = host;
  return encodeFields(KEY_SCHEDULE_DOMAIN, [
    helloTranscript(unsignedDevice),
    fromBase64Url(deviceSignature, "device signature", 128),
    helloTranscript(unsignedHost),
    fromBase64Url(hostSignature, "host signature", 128),
  ]);
}

function sequence(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new BrowserRelayCryptoError("RELAY_FRAME_INVALID", "invalid relay frame sequence");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SEQUENCE) throw new BrowserRelayCryptoError("RELAY_FRAME_INVALID", "relay frame sequence overflow");
  return parsed;
}

function nonceFor(base: Uint8Array, value: bigint): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(base);
  const encoded = new Uint8Array(12);
  new DataView(encoded.buffer).setBigUint64(4, value, false);
  for (let index = 0; index < nonce.byteLength; index += 1) nonce[index] = nonce[index]! ^ encoded[index]!;
  return nonce;
}

function aad(sessionId: string, direction: RelayDirection, value: bigint, kind: RelayFrameKind) {
  return encodeFields(FRAME_DOMAIN, [
    String(RELAY_PROTOCOL_VERSION),
    safeId(sessionId, "session id"),
    direction,
    value.toString(),
    kind,
  ]);
}

export class BrowserRelayCipherState {
  private sendSequence = 0n;
  private receiveSequence = 0n;
  private closed = false;
  private readonly createdAt: number;
  private readonly sendDirection: RelayDirection;
  private readonly receiveDirection: RelayDirection;

  constructor(
    readonly sessionId: string,
    readonly role: RelayRole,
    private readonly sendKey: CryptoKey,
    private readonly receiveKey: CryptoKey,
    private readonly sendBaseNonce: Uint8Array,
    private readonly receiveBaseNonce: Uint8Array,
    private readonly now: () => number,
    private readonly maxAgeMs: number,
    private readonly maxFrames: number,
  ) {
    this.createdAt = now();
    this.sendDirection = role === "device" ? "device-to-host" : "host-to-device";
    this.receiveDirection = role === "device" ? "host-to-device" : "device-to-host";
  }

  async encrypt(kind: RelayFrameKind, plaintext: Uint8Array<ArrayBuffer>): Promise<RelayEncryptedFrame> {
    this.assertOpen();
    this.assertKind(kind);
    if (plaintext.byteLength > RELAY_MAX_PLAINTEXT_BYTES) {
      throw new BrowserRelayCryptoError("RELAY_FRAME_TOO_LARGE", "relay plaintext exceeds one MiB");
    }
    if (this.needsRotation() || this.sendSequence >= MAX_SEQUENCE) {
      throw new BrowserRelayCryptoError("RELAY_KEY_ROTATION_REQUIRED", "relay traffic keys must rotate");
    }
    const current = this.sendSequence;
    const ciphertext = await subtle().encrypt(
      {
        name: "AES-GCM",
        iv: nonceFor(this.sendBaseNonce, current),
        additionalData: aad(this.sessionId, this.sendDirection, current, kind),
        tagLength: 128,
      },
      this.sendKey,
      plaintext,
    );
    this.sendSequence += 1n;
    return {
      v: RELAY_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: current.toString(),
      kind,
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    };
  }

  async decrypt(frame: RelayEncryptedFrame): Promise<Uint8Array<ArrayBuffer>> {
    this.assertOpen();
    if (!frame || frame.v !== RELAY_PROTOCOL_VERSION || frame.sessionId !== this.sessionId) {
      throw new BrowserRelayCryptoError("RELAY_FRAME_INVALID", "relay frame belongs to another protocol or session");
    }
    this.assertKind(frame.kind);
    const current = sequence(frame.seq);
    if (current !== this.receiveSequence) {
      throw new BrowserRelayCryptoError("RELAY_FRAME_OUT_OF_ORDER", "relay frame is duplicate, skipped, or reordered");
    }
    if (this.needsRotation() || this.receiveSequence >= MAX_SEQUENCE) {
      throw new BrowserRelayCryptoError("RELAY_KEY_ROTATION_REQUIRED", "relay traffic keys must rotate");
    }
    const ciphertext = fromBase64Url(
      frame.ciphertext,
      "ciphertext",
      RELAY_MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES,
      "RELAY_FRAME_INVALID",
    );
    if (ciphertext.byteLength < AUTH_TAG_BYTES) {
      throw new BrowserRelayCryptoError("RELAY_FRAME_INVALID", "relay ciphertext is missing its authentication tag");
    }
    try {
      const plaintext = await subtle().decrypt(
        {
          name: "AES-GCM",
          iv: nonceFor(this.receiveBaseNonce, current),
          additionalData: aad(this.sessionId, this.receiveDirection, current, frame.kind),
          tagLength: 128,
        },
        this.receiveKey,
        ciphertext,
      );
      this.receiveSequence += 1n;
      return new Uint8Array(plaintext);
    } catch {
      throw new BrowserRelayCryptoError("RELAY_FRAME_AUTH_FAILED", "relay frame authentication failed");
    }
  }

  needsRotation(): boolean {
    return (
      this.now() - this.createdAt >= this.maxAgeMs ||
      this.sendSequence >= BigInt(this.maxFrames) ||
      this.receiveSequence >= BigInt(this.maxFrames)
    );
  }

  sequences(): { send: string; receive: string } {
    return { send: this.sendSequence.toString(), receive: this.receiveSequence.toString() };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendBaseNonce.fill(0);
    this.receiveBaseNonce.fill(0);
  }

  private assertOpen(): void {
    if (this.closed) throw new BrowserRelayCryptoError("RELAY_CHANNEL_CLOSED", "relay channel is closed");
  }

  private assertKind(kind: unknown): asserts kind is RelayFrameKind {
    if (typeof kind !== "string" || !FRAME_KINDS.has(kind as RelayFrameKind)) {
      throw new BrowserRelayCryptoError("RELAY_FRAME_INVALID", "unknown relay frame kind");
    }
  }
}

export async function establishBrowserRelayChannel(options: {
  role: RelayRole;
  localEphemeral: BrowserRelayEphemeralKeyPair;
  deviceHello: RelayHandshakeHello;
  hostHello: RelayHandshakeHello;
  deviceIdentityPublicKey: string;
  hostIdentityPublicKey: string;
  now?: () => number;
  maxAgeMs?: number;
  maxFrames?: number;
}): Promise<BrowserRelayCipherState> {
  const { deviceHello, hostHello } = options;
  if (
    deviceHello.role !== "device" ||
    hostHello.role !== "host" ||
    deviceHello.routeId !== hostHello.routeId ||
    deviceHello.deviceId !== hostHello.deviceId ||
    deviceHello.sessionId !== hostHello.sessionId
  ) {
    throw new BrowserRelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "relay hellos do not describe one channel");
  }
  const now = options.now?.() ?? Date.now();
  await verifyBrowserRelayHandshakeHello(deviceHello, {
    role: "device",
    routeId: deviceHello.routeId,
    deviceId: deviceHello.deviceId,
    sessionId: deviceHello.sessionId,
    identityPublicKey: options.deviceIdentityPublicKey,
    now,
  });
  await verifyBrowserRelayHandshakeHello(hostHello, {
    role: "host",
    routeId: deviceHello.routeId,
    deviceId: deviceHello.deviceId,
    sessionId: deviceHello.sessionId,
    identityPublicKey: options.hostIdentityPublicKey,
    now,
  });
  const localHello = options.role === "device" ? deviceHello : hostHello;
  let localPublic: Uint8Array;
  try {
    localPublic = new Uint8Array(await subtle().exportKey("spki", options.localEphemeral.publicCryptoKey));
  } catch {
    throw new BrowserRelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "relay ephemeral public key is unavailable");
  }
  if (!equalBytes(localPublic, fromBase64Url(localHello.ephemeralPublicKey, "local ephemeral public key", 512))) {
    throw new BrowserRelayCryptoError(
      "RELAY_HANDSHAKE_MISMATCH",
      "local ephemeral key does not match the signed hello",
    );
  }
  const remoteHello = options.role === "device" ? hostHello : deviceHello;
  let remotePublic: CryptoKey;
  try {
    remotePublic = await subtle().importKey(
      "spki",
      fromBase64Url(remoteHello.ephemeralPublicKey, "remote ephemeral public key", 512),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "relay ephemeral public key is invalid");
  }
  let shared: ArrayBuffer;
  try {
    shared = await subtle().deriveBits({ name: "ECDH", public: remotePublic }, options.localEphemeral.privateKey, 256);
  } catch {
    throw new BrowserRelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "relay ephemeral private key is invalid");
  }
  const salt = new Uint8Array(await subtle().digest("SHA-256", sessionTranscript(deviceHello, hostHello)));
  const info = encodeFields(TRAFFIC_DOMAIN, [deviceHello.routeId, deviceHello.deviceId, deviceHello.sessionId]);
  const hkdfKey = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const material = new Uint8Array(
    await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, hkdfKey, (32 * 2 + 12 * 2) * 8),
  );
  const deviceToHostKey = await subtle().importKey("raw", material.slice(0, 32), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const hostToDeviceKey = await subtle().importKey("raw", material.slice(32, 64), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  const deviceToHostNonce = material.slice(64, 76);
  const hostToDeviceNonce = material.slice(76, 88);
  material.fill(0);
  const maxAgeMs = options.maxAgeMs ?? RELAY_CHANNEL_MAX_AGE_MS;
  const maxFrames = options.maxFrames ?? RELAY_CHANNEL_MAX_FRAMES;
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 1_000 ||
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > Number.MAX_SAFE_INTEGER
  ) {
    throw new BrowserRelayCryptoError("INVALID_RELAY_HELLO", "invalid relay rotation policy");
  }
  return new BrowserRelayCipherState(
    deviceHello.sessionId,
    options.role,
    options.role === "device" ? deviceToHostKey : hostToDeviceKey,
    options.role === "device" ? hostToDeviceKey : deviceToHostKey,
    options.role === "device" ? deviceToHostNonce : hostToDeviceNonce,
    options.role === "device" ? hostToDeviceNonce : deviceToHostNonce,
    options.now ?? Date.now,
    maxAgeMs,
    maxFrames,
  );
}

export const relayBase64 = { encode: toBase64Url, decode: fromBase64Url };
