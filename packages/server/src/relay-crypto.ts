import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_HANDSHAKE_MAX_SKEW_MS = 5 * 60_000;
export const RELAY_CHANNEL_MAX_AGE_MS = 30 * 60_000;
export const RELAY_CHANNEL_MAX_FRAMES = 1_000_000;
export const RELAY_MAX_PLAINTEXT_BYTES = 1024 * 1024;

const HANDSHAKE_DOMAIN = "roamcode-relay-handshake-v1";
const KEY_SCHEDULE_DOMAIN = "roamcode-relay-key-schedule-v1";
const TRAFFIC_DOMAIN = "roamcode-relay-traffic-v1";
const FRAME_DOMAIN = "roamcode-relay-frame-v1";
const MAX_SEQUENCE = (1n << 64n) - 1n;
const AUTH_TAG_BYTES = 16;
const BASE_NONCE_BYTES = 12;
const TRAFFIC_KEY_BYTES = 32;
const DER_PUBLIC_KEY_MAX_BYTES = 512;

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

export type RelayCryptoErrorCode =
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

export class RelayCryptoError extends Error {
  constructor(
    readonly code: RelayCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelayCryptoError";
  }
}

export interface RelayIdentity {
  /** Base64url-encoded SPKI DER public key. Safe to pin and exchange. */
  publicKey: string;
  /** Base64url-encoded PKCS#8 DER private key. Host persistence must use mode 0600. */
  privateKey: string;
  fingerprint: string;
}

export interface RelayEphemeralKeyPair {
  publicKey: string;
  privateKey: string;
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

export interface RelayChannelOptions {
  role: RelayRole;
  localEphemeral: RelayEphemeralKeyPair;
  deviceHello: RelayHandshakeHello;
  hostHello: RelayHandshakeHello;
  deviceIdentityPublicKey: string;
  hostIdentityPublicKey: string;
  now?: () => number;
  maxAgeMs?: number;
  maxFrames?: number;
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(
  value: unknown,
  field: string,
  maxBytes: number,
  code: RelayCryptoErrorCode = "INVALID_RELAY_HELLO",
): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RelayCryptoError(code, `invalid relay ${field}`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    throw new RelayCryptoError(code, `invalid relay ${field}`);
  }
  return decoded;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new RelayCryptoError("INVALID_RELAY_HELLO", `invalid relay ${field}`);
  }
  return value;
}

function encodeFields(domain: string, fields: readonly (string | Uint8Array)[]): Buffer {
  const values = [Buffer.from(domain, "utf8"), ...fields.map((field) => Buffer.from(field))];
  const output: Buffer[] = [];
  for (const value of values) {
    if (value.length > 1024 * 1024) throw new RelayCryptoError("INVALID_RELAY_HELLO", "relay field too large");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    output.push(length, value);
  }
  return Buffer.concat(output);
}

function publicKeyDer(value: string, code: RelayCryptoErrorCode = "INVALID_RELAY_IDENTITY") {
  try {
    const der = fromBase64Url(value, "public key", DER_PUBLIC_KEY_MAX_BYTES);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong curve");
    }
    return { der, key };
  } catch (error) {
    if (error instanceof RelayCryptoError && error.code === code) throw error;
    throw new RelayCryptoError(code, "relay public key must be an ECDSA/ECDH P-256 SPKI key");
  }
}

function privateKeyDer(value: string) {
  try {
    const der = fromBase64Url(value, "private key", 512);
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong curve");
    }
    return { der, key };
  } catch {
    throw new RelayCryptoError("INVALID_RELAY_IDENTITY", "relay private key must be a P-256 PKCS#8 key");
  }
}

function publicDerFromPrivate(privateKey: string): Buffer {
  const privatePem = privateKeyDer(privateKey).key.export({ format: "pem", type: "pkcs8" });
  return Buffer.from(
    createPublicKey(privatePem).export({
      format: "der",
      type: "spki",
    }),
  );
}

export function relayIdentityFingerprint(publicKey: string): string {
  const { der } = publicKeyDer(publicKey);
  return `sha256:${createHash("sha256").update(der).digest("base64url")}`;
}

export function generateRelayIdentity(): RelayIdentity {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const publicKey = toBase64Url(pair.publicKey);
  return { publicKey, privateKey: toBase64Url(pair.privateKey), fingerprint: relayIdentityFingerprint(publicKey) };
}

/** Validates both key encodings and proves that the persisted private key belongs to the advertised identity. */
export function validateRelayIdentity(value: unknown): RelayIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity is invalid");
  }
  const identity = value as Partial<RelayIdentity>;
  if (
    typeof identity.publicKey !== "string" ||
    typeof identity.privateKey !== "string" ||
    typeof identity.fingerprint !== "string"
  ) {
    throw new RelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity is invalid");
  }
  const publicDer = publicKeyDer(identity.publicKey).der;
  if (!sameBytes(publicDer, publicDerFromPrivate(identity.privateKey))) {
    throw new RelayCryptoError("INVALID_RELAY_IDENTITY", "relay public and private keys do not match");
  }
  if (relayIdentityFingerprint(identity.publicKey) !== identity.fingerprint) {
    throw new RelayCryptoError("INVALID_RELAY_IDENTITY", "relay identity fingerprint does not match its public key");
  }
  return {
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    fingerprint: identity.fingerprint,
  };
}

export function generateRelayEphemeralKeyPair(): RelayEphemeralKeyPair {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return { publicKey: toBase64Url(pair.publicKey), privateKey: toBase64Url(pair.privateKey) };
}

function helloTranscript(hello: Omit<RelayHandshakeHello, "signature">): Buffer {
  const nonce = fromBase64Url(hello.nonce, "nonce", 32);
  if (nonce.length !== 32) throw new RelayCryptoError("INVALID_RELAY_HELLO", "relay nonce must be 32 bytes");
  const ephemeral = publicKeyDer(hello.ephemeralPublicKey, "INVALID_RELAY_HELLO").der;
  if (!Number.isSafeInteger(hello.issuedAt) || hello.issuedAt < 0) {
    throw new RelayCryptoError("INVALID_RELAY_HELLO", "invalid relay issue time");
  }
  if (hello.v !== RELAY_PROTOCOL_VERSION || (hello.role !== "device" && hello.role !== "host")) {
    throw new RelayCryptoError("INVALID_RELAY_HELLO", "unsupported relay handshake");
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(hello.identityFingerprint)) {
    throw new RelayCryptoError("INVALID_RELAY_HELLO", "invalid relay identity fingerprint");
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

export function createRelayHandshakeHello(input: {
  role: RelayRole;
  routeId: string;
  deviceId: string;
  sessionId?: string;
  identity: RelayIdentity;
  ephemeral?: RelayEphemeralKeyPair;
  nonce?: Uint8Array;
  issuedAt?: number;
}): { hello: RelayHandshakeHello; ephemeral: RelayEphemeralKeyPair } {
  const ephemeral = input.ephemeral ?? generateRelayEphemeralKeyPair();
  const sessionId = input.sessionId ?? toBase64Url(randomBytes(16));
  const identity = validateRelayIdentity(input.identity);
  const fingerprint = identity.fingerprint;
  const unsigned: Omit<RelayHandshakeHello, "signature"> = {
    v: RELAY_PROTOCOL_VERSION,
    role: input.role,
    routeId: safeId(input.routeId, "route id"),
    deviceId: safeId(input.deviceId, "device id"),
    sessionId: safeId(sessionId, "session id"),
    issuedAt: input.issuedAt ?? Date.now(),
    nonce: toBase64Url(input.nonce ?? randomBytes(32)),
    ephemeralPublicKey: ephemeral.publicKey,
    identityFingerprint: fingerprint,
  };
  const signature = cryptoSign("sha256", helloTranscript(unsigned), {
    key: privateKeyDer(identity.privateKey).key,
    dsaEncoding: "ieee-p1363",
  });
  return { hello: { ...unsigned, signature: toBase64Url(signature) }, ephemeral };
}

export function verifyRelayHandshakeHello(
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
): void {
  const { signature, ...unsigned } = hello;
  const transcript = helloTranscript(unsigned);
  if (
    hello.role !== expected.role ||
    hello.routeId !== expected.routeId ||
    hello.deviceId !== expected.deviceId ||
    hello.sessionId !== expected.sessionId
  ) {
    throw new RelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "relay handshake context does not match");
  }
  const fingerprint = relayIdentityFingerprint(expected.identityPublicKey);
  if (hello.identityFingerprint !== fingerprint) {
    throw new RelayCryptoError("RELAY_IDENTITY_MISMATCH", "relay identity does not match the paired fingerprint");
  }
  const now = expected.now ?? Date.now();
  const maxSkew = expected.maxSkewMs ?? RELAY_HANDSHAKE_MAX_SKEW_MS;
  if (!Number.isSafeInteger(maxSkew) || maxSkew < 1_000 || Math.abs(now - hello.issuedAt) > maxSkew) {
    throw new RelayCryptoError("RELAY_HANDSHAKE_EXPIRED", "relay handshake is outside the accepted clock window");
  }
  const rawSignature = fromBase64Url(signature, "signature", 128);
  if (rawSignature.length !== 64) {
    throw new RelayCryptoError("RELAY_SIGNATURE_INVALID", "relay handshake signature is invalid");
  }
  const verified = cryptoVerify(
    "sha256",
    transcript,
    { key: publicKeyDer(expected.identityPublicKey).key, dsaEncoding: "ieee-p1363" },
    rawSignature,
  );
  if (!verified) throw new RelayCryptoError("RELAY_SIGNATURE_INVALID", "relay handshake signature is invalid");
}

/** Small exported primitive used to pin RFC 5869 test vectors independently of the handshake. */
export function hkdfSha256(input: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 1 || length > 255 * 32) {
    throw new RelayCryptoError("INVALID_RELAY_HELLO", "invalid HKDF output length");
  }
  return Buffer.from(hkdfSync("sha256", input, salt, info, length));
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function sessionTranscript(deviceHello: RelayHandshakeHello, hostHello: RelayHandshakeHello): Buffer {
  const { signature: deviceSignature, ...unsignedDevice } = deviceHello;
  const { signature: hostSignature, ...unsignedHost } = hostHello;
  return encodeFields(KEY_SCHEDULE_DOMAIN, [
    helloTranscript(unsignedDevice),
    fromBase64Url(deviceSignature, "device signature", 128),
    helloTranscript(unsignedHost),
    fromBase64Url(hostSignature, "host signature", 128),
  ]);
}

function sequenceFromFrame(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new RelayCryptoError("RELAY_FRAME_INVALID", "invalid relay frame sequence");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SEQUENCE) throw new RelayCryptoError("RELAY_FRAME_INVALID", "relay frame sequence overflow");
  return parsed;
}

function frameNonce(baseNonce: Buffer, sequence: bigint): Buffer {
  const nonce = Buffer.from(baseNonce);
  const encoded = Buffer.alloc(BASE_NONCE_BYTES);
  encoded.writeBigUInt64BE(sequence, BASE_NONCE_BYTES - 8);
  for (let index = 0; index < BASE_NONCE_BYTES; index += 1) nonce[index] = nonce[index]! ^ encoded[index]!;
  return nonce;
}

function frameAad(sessionId: string, direction: RelayDirection, sequence: bigint, kind: RelayFrameKind): Buffer {
  return encodeFields(FRAME_DOMAIN, [
    String(RELAY_PROTOCOL_VERSION),
    safeId(sessionId, "session id"),
    direction,
    sequence.toString(),
    kind,
  ]);
}

export class RelayCipherState {
  private sendSequence = 0n;
  private receiveSequence = 0n;
  private closed = false;
  private readonly createdAt: number;
  private readonly sendDirection: RelayDirection;
  private readonly receiveDirection: RelayDirection;

  constructor(
    readonly sessionId: string,
    readonly role: RelayRole,
    private readonly sendKey: Buffer,
    private readonly receiveKey: Buffer,
    private readonly sendBaseNonce: Buffer,
    private readonly receiveBaseNonce: Buffer,
    private readonly now: () => number,
    private readonly maxAgeMs: number,
    private readonly maxFrames: number,
  ) {
    this.createdAt = now();
    this.sendDirection = role === "device" ? "device-to-host" : "host-to-device";
    this.receiveDirection = role === "device" ? "host-to-device" : "device-to-host";
  }

  encrypt(kind: RelayFrameKind, plaintext: Uint8Array): RelayEncryptedFrame {
    this.assertOpen();
    this.assertKind(kind);
    if (plaintext.byteLength > RELAY_MAX_PLAINTEXT_BYTES) {
      throw new RelayCryptoError("RELAY_FRAME_TOO_LARGE", "relay plaintext exceeds one MiB");
    }
    if (this.needsRotation() || this.sendSequence >= MAX_SEQUENCE) {
      throw new RelayCryptoError("RELAY_KEY_ROTATION_REQUIRED", "relay traffic keys must rotate");
    }
    const sequence = this.sendSequence;
    const cipher = createCipheriv("aes-256-gcm", this.sendKey, frameNonce(this.sendBaseNonce, sequence), {
      authTagLength: AUTH_TAG_BYTES,
    });
    cipher.setAAD(frameAad(this.sessionId, this.sendDirection, sequence, kind));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.sendSequence += 1n;
    return {
      v: RELAY_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: sequence.toString(),
      kind,
      ciphertext: toBase64Url(ciphertext),
    };
  }

  decrypt(frame: RelayEncryptedFrame): Buffer {
    this.assertOpen();
    if (!frame || frame.v !== RELAY_PROTOCOL_VERSION || frame.sessionId !== this.sessionId) {
      throw new RelayCryptoError("RELAY_FRAME_INVALID", "relay frame belongs to another protocol or session");
    }
    this.assertKind(frame.kind);
    const sequence = sequenceFromFrame(frame.seq);
    if (sequence !== this.receiveSequence) {
      throw new RelayCryptoError("RELAY_FRAME_OUT_OF_ORDER", "relay frame is duplicate, skipped, or reordered");
    }
    if (this.needsRotation() || this.receiveSequence >= MAX_SEQUENCE) {
      throw new RelayCryptoError("RELAY_KEY_ROTATION_REQUIRED", "relay traffic keys must rotate");
    }
    const ciphertext = fromBase64Url(
      frame.ciphertext,
      "ciphertext",
      RELAY_MAX_PLAINTEXT_BYTES + AUTH_TAG_BYTES,
      "RELAY_FRAME_INVALID",
    );
    if (ciphertext.length < AUTH_TAG_BYTES) {
      throw new RelayCryptoError("RELAY_FRAME_INVALID", "relay ciphertext is missing its authentication tag");
    }
    const body = ciphertext.subarray(0, -AUTH_TAG_BYTES);
    const tag = ciphertext.subarray(-AUTH_TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.receiveKey, frameNonce(this.receiveBaseNonce, sequence), {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(frameAad(this.sessionId, this.receiveDirection, sequence, frame.kind));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      this.receiveSequence += 1n;
      return plaintext;
    } catch {
      throw new RelayCryptoError("RELAY_FRAME_AUTH_FAILED", "relay frame authentication failed");
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
    this.sendKey.fill(0);
    this.receiveKey.fill(0);
    this.sendBaseNonce.fill(0);
    this.receiveBaseNonce.fill(0);
  }

  private assertOpen(): void {
    if (this.closed) throw new RelayCryptoError("RELAY_CHANNEL_CLOSED", "relay channel is closed");
  }

  private assertKind(kind: unknown): asserts kind is RelayFrameKind {
    if (typeof kind !== "string" || !FRAME_KINDS.has(kind as RelayFrameKind)) {
      throw new RelayCryptoError("RELAY_FRAME_INVALID", "unknown relay frame kind");
    }
  }
}

export function establishRelayChannel(options: RelayChannelOptions): RelayCipherState {
  const { deviceHello, hostHello } = options;
  if (
    deviceHello.role !== "device" ||
    hostHello.role !== "host" ||
    deviceHello.routeId !== hostHello.routeId ||
    deviceHello.deviceId !== hostHello.deviceId ||
    deviceHello.sessionId !== hostHello.sessionId
  ) {
    throw new RelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "relay hellos do not describe one channel");
  }
  const now = options.now?.() ?? Date.now();
  verifyRelayHandshakeHello(deviceHello, {
    role: "device",
    routeId: deviceHello.routeId,
    deviceId: deviceHello.deviceId,
    sessionId: deviceHello.sessionId,
    identityPublicKey: options.deviceIdentityPublicKey,
    now,
  });
  verifyRelayHandshakeHello(hostHello, {
    role: "host",
    routeId: deviceHello.routeId,
    deviceId: deviceHello.deviceId,
    sessionId: deviceHello.sessionId,
    identityPublicKey: options.hostIdentityPublicKey,
    now,
  });
  const localHello = options.role === "device" ? deviceHello : hostHello;
  const localPrivateKey = privateKeyDer(options.localEphemeral.privateKey).key;
  const localPublicFromPrivate = publicDerFromPrivate(options.localEphemeral.privateKey);
  const advertisedLocalPublic = publicKeyDer(localHello.ephemeralPublicKey, "INVALID_RELAY_HELLO").der;
  if (!sameBytes(Buffer.from(localPublicFromPrivate), advertisedLocalPublic)) {
    throw new RelayCryptoError("RELAY_HANDSHAKE_MISMATCH", "local ephemeral key does not match the signed hello");
  }
  const remoteHello = options.role === "device" ? hostHello : deviceHello;
  const sharedSecret = diffieHellman({
    privateKey: localPrivateKey,
    publicKey: publicKeyDer(remoteHello.ephemeralPublicKey, "INVALID_RELAY_HELLO").key,
  });
  const salt = createHash("sha256").update(sessionTranscript(deviceHello, hostHello)).digest();
  const info = encodeFields(TRAFFIC_DOMAIN, [deviceHello.routeId, deviceHello.deviceId, deviceHello.sessionId]);
  const material = hkdfSha256(sharedSecret, salt, info, TRAFFIC_KEY_BYTES * 2 + BASE_NONCE_BYTES * 2);
  sharedSecret.fill(0);
  const deviceToHostKey = Buffer.from(material.subarray(0, 32));
  const hostToDeviceKey = Buffer.from(material.subarray(32, 64));
  const deviceToHostNonce = Buffer.from(material.subarray(64, 76));
  const hostToDeviceNonce = Buffer.from(material.subarray(76, 88));
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
    throw new RelayCryptoError("INVALID_RELAY_HELLO", "invalid relay rotation policy");
  }
  return new RelayCipherState(
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
