import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { CloudAuthorizationStore } from "./cloud-authorization-store.js";
import {
  CloudDeviceEnrollmentConflictError,
  type DeviceInfo,
  type DeviceStore,
  type PendingCloudDevicePromotion,
} from "./device-store.js";
import { relayIdentityFingerprint } from "./relay-crypto.js";
import type { RelayDeviceProvisioner } from "./relay-provision.js";
import { relayCredentialHash } from "./relay-store.js";

export const DEFAULT_CLOUD_CONTROL_PLANE_URL = "https://roamcode.ai";
export const CLOUD_DEVICE_ENROLLMENT_CONFIRM_PATH = "/api/v1/hosts/device-enrollments/confirm";
export const CLOUD_DEVICE_ENROLLMENT_COMPLETE_PATH = "/api/v1/hosts/device-enrollments/complete";
export const CLOUD_DEVICE_ENROLLMENT_HOST_ROUTE = "/api/v1/cloud/device-enrollments/confirm";

const MAX_CREDENTIAL_BYTES = 512;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const HOST_CREDENTIAL = /^rch_[A-Za-z0-9_-]{64}$/;
const ENROLLMENT_CHALLENGE = /^rce_[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN = /^rcd_[A-Za-z0-9_-]{43}$/;
const RELAY_DEVICE_CREDENTIAL = /^rrd_[A-Za-z0-9_-]{43}$/;
const RELAY_CREDENTIAL_HASH = /^sha256:[A-Za-z0-9_-]{43}$/;
const RELAY_IDENTITY_FINGERPRINT = /^sha256:[A-Za-z0-9_-]{43}$/;

export const CloudDeviceEnrollmentRequestSchema = z
  .object({
    v: z.literal(1),
    enrollmentId: z.uuid(),
    challenge: z.string().regex(ENROLLMENT_CHALLENGE),
  })
  .strict();

export const CloudHostDeviceEnrollmentConfirmationSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("host-device-enrollment-confirmation"),
    enrollmentId: z.uuid(),
    challenge: z.string().regex(ENROLLMENT_CHALLENGE),
    actorId: z.string().min(1).max(256).regex(SAFE_IDENTIFIER),
    deviceIdentityPublicKey: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const CloudHostDeviceEnrollmentCompletionSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("host-device-enrollment-completion"),
    enrollmentId: z.uuid(),
    actorId: z.string().min(1).max(256).regex(SAFE_IDENTIFIER),
    temporaryRelayCredentialHash: z.string().regex(RELAY_CREDENTIAL_HASH),
    durableRelayCredentialHash: z.string().regex(RELAY_CREDENTIAL_HASH),
  })
  .strict()
  .superRefine((completion, context) => {
    if (completion.temporaryRelayCredentialHash === completion.durableRelayCredentialHash) {
      context.addIssue({ code: "custom", path: ["durableRelayCredentialHash"], message: "hashes must differ" });
    }
  });

export const CloudRelayDeviceEnrollmentPayloadSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("cloud-device-enrollment"),
    enrollmentId: z.uuid(),
    challenge: z.string().regex(ENROLLMENT_CHALLENGE),
    name: z.string().min(1).max(80),
    localDeviceToken: z.string().regex(DEVICE_TOKEN),
    durableRelayCredential: z.string().regex(RELAY_DEVICE_CREDENTIAL),
  })
  .strict();

export const CloudRelayDeviceEnrollmentAuthSchema = z
  .object({
    token: z.string().regex(DEVICE_TOKEN),
    relayCredential: z.string().regex(RELAY_DEVICE_CREDENTIAL),
    cloudEnrollment: CloudRelayDeviceEnrollmentPayloadSchema,
  })
  .strict()
  .superRefine((auth, context) => {
    if (auth.token !== auth.cloudEnrollment.localDeviceToken) {
      context.addIssue({ code: "custom", path: ["token"], message: "local device token must match byte-for-byte" });
    }
    if (auth.relayCredential !== auth.cloudEnrollment.durableRelayCredential) {
      context.addIssue({
        code: "custom",
        path: ["relayCredential"],
        message: "durable relay credential must match byte-for-byte",
      });
    }
  });

const CloudHostDeviceSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    hostId: z.uuid(),
    actorId: z.string().min(1).max(256).regex(SAFE_IDENTIFIER),
    label: z.string().min(1).max(120),
    pairedBy: z.string().min(1).max(256).regex(SAFE_IDENTIFIER),
    pairedAt: z.string().min(1).max(64),
    lastSeenAt: z.string().min(1).max(64).nullable(),
    revokedAt: z.string().min(1).max(64).nullable(),
  })
  .strict();

const CloudHostDeviceEnrollmentResponseSchema = z
  .object({
    device: CloudHostDeviceSchema,
    temporary_relay_credential_hash: z.string().regex(RELAY_CREDENTIAL_HASH).optional(),
    device_identity: z
      .object({
        public_key: z
          .string()
          .min(1)
          .max(1_024)
          .regex(/^[A-Za-z0-9_-]+$/),
        fingerprint: z.string().regex(RELAY_IDENTITY_FINGERPRINT),
      })
      .strict()
      .optional(),
  })
  .strict();

const CloudHostDeviceEnrollmentCompletionResponseSchema = z
  .object({
    v: z.literal(1),
    state: z.enum(["active", "revoked"]),
    deviceId: z.uuid(),
  })
  .strict();

export type CloudDeviceEnrollmentRequest = z.infer<typeof CloudDeviceEnrollmentRequestSchema>;
export type CloudHostDeviceEnrollmentConfirmation = z.infer<typeof CloudHostDeviceEnrollmentConfirmationSchema>;
export type CloudHostDeviceEnrollmentCompletion = z.infer<typeof CloudHostDeviceEnrollmentCompletionSchema>;
export type CloudHostDeviceEnrollmentCompletionResult = z.infer<
  typeof CloudHostDeviceEnrollmentCompletionResponseSchema
>;
export type CloudRelayDeviceEnrollmentPayload = z.infer<typeof CloudRelayDeviceEnrollmentPayloadSchema>;
export type CloudRelayDeviceEnrollmentAuth = z.infer<typeof CloudRelayDeviceEnrollmentAuthSchema>;

export interface CloudDeviceEnrollmentConfirmationResult {
  actorId: string;
  deviceId: string;
  temporaryRelayCredentialHash?: string;
  deviceIdentity?: { publicKey: string; fingerprint: string };
}

export interface CloudRelayDeviceEnrollmentSaga {
  enroll(input: {
    actorId: string;
    deviceIdentityPublicKey: string;
    cloudEnrollment: unknown;
  }): Promise<{ device: DeviceInfo; token: string }>;
  recover(): Promise<{ completed: number; failed: number }>;
}

export interface CloudDeviceEnrollmentConfirmer {
  confirm(input: CloudHostDeviceEnrollmentConfirmation): Promise<CloudDeviceEnrollmentConfirmationResult>;
  complete(input: CloudHostDeviceEnrollmentCompletion): Promise<CloudHostDeviceEnrollmentCompletionResult>;
}

export interface CloudDeviceEnrollmentRuntimeConfig {
  controlPlaneOrigin: string;
  hostCredential: string;
}

export type CloudDeviceEnrollmentErrorCode = "REJECTED" | "UNAVAILABLE" | "INVALID_RESPONSE";

export class CloudDeviceEnrollmentError extends Error {
  constructor(
    readonly code: CloudDeviceEnrollmentErrorCode,
    readonly retryable: boolean,
  ) {
    super(
      code === "REJECTED"
        ? "cloud device enrollment was rejected"
        : code === "UNAVAILABLE"
          ? "cloud device enrollment is temporarily unavailable"
          : "cloud device enrollment returned an invalid response",
    );
    this.name = "CloudDeviceEnrollmentError";
  }
}

export interface CreateCloudDeviceEnrollmentConfirmerOptions extends CloudDeviceEnrollmentRuntimeConfig {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/** Normalize an origin once so a client payload can never choose where the host credential is sent. */
export function normalizeCloudControlPlaneOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("cloud control-plane URL must be a valid origin");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("cloud control-plane URL must be an origin without credentials, a path, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("cloud control-plane URL must use HTTPS away from loopback");
  }
  return url.origin;
}

/** Read a host capability without following links or accepting permissions that expose it to other users. */
export function readCloudHostCredentialFile(path: string): string {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch {
    throw new Error("cloud host credential file could not be read");
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("cloud host credential path must be a regular file");
  }
  if (before.size <= 0 || before.size > MAX_CREDENTIAL_BYTES) {
    throw new Error("cloud host credential file has an invalid size");
  }
  if ((before.mode & 0o777) !== 0o600) {
    throw new Error("cloud host credential file must have mode 0600");
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new Error("cloud host credential file must be owned by the current user");
  }

  let descriptor: number | undefined;
  let raw: string;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size <= 0 ||
      opened.size > MAX_CREDENTIAL_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error("cloud host credential file changed while it was being opened");
    }
    raw = readFileSync(descriptor, "utf8");
    const afterRead = fstatSync(descriptor);
    if (
      Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_BYTES ||
      afterRead.dev !== opened.dev ||
      afterRead.ino !== opened.ino ||
      afterRead.size !== opened.size
    ) {
      throw new Error("cloud host credential file changed while it was being read");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("cloud host credential file")) throw error;
    throw new Error("cloud host credential file could not be read");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  const credential = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!HOST_CREDENTIAL.test(credential)) {
    throw new Error("cloud host credential file is invalid");
  }
  return credential;
}

/** URL-only configuration is harmless; cloud host enrollment is enabled only when its credential file is set. */
export function resolveCloudDeviceEnrollmentConfig(
  env: NodeJS.ProcessEnv,
): CloudDeviceEnrollmentRuntimeConfig | undefined {
  const credentialFile = env.ROAMCODE_CLOUD_HOST_CREDENTIAL_FILE?.trim();
  if (!credentialFile) return undefined;
  return {
    controlPlaneOrigin: normalizeCloudControlPlaneOrigin(
      env.ROAMCODE_CLOUD_CONTROL_PLANE_URL?.trim() || DEFAULT_CLOUD_CONTROL_PLANE_URL,
    ),
    hostCredential: readCloudHostCredentialFile(credentialFile),
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function createCloudDeviceEnrollmentConfirmer(
  options: CreateCloudDeviceEnrollmentConfirmerOptions,
): CloudDeviceEnrollmentConfirmer {
  const origin = normalizeCloudControlPlaneOrigin(options.controlPlaneOrigin);
  if (!HOST_CREDENTIAL.test(options.hostCredential)) throw new Error("cloud host credential is invalid");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("cloud enrollment timeout is invalid");
  }

  return {
    async confirm(rawInput) {
      const parsed = CloudHostDeviceEnrollmentConfirmationSchema.safeParse(rawInput);
      if (!parsed.success) throw new CloudDeviceEnrollmentError("REJECTED", false);
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${CLOUD_DEVICE_ENROLLMENT_CONFIRM_PATH}`, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${options.hostCredential}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(parsed.data),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new CloudDeviceEnrollmentError("UNAVAILABLE", true);
      }

      if (response.status !== 201) {
        // Drain only a bounded amount. Never surface upstream bodies because they could reflect a challenge.
        await boundedResponseText(response).catch(() => "");
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new CloudDeviceEnrollmentError(retryable ? "UNAVAILABLE" : "REJECTED", retryable);
      }

      let value: unknown;
      try {
        value = JSON.parse(await boundedResponseText(response));
      } catch (error) {
        if (error instanceof CloudDeviceEnrollmentError) throw error;
        throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      }
      const body = CloudHostDeviceEnrollmentResponseSchema.safeParse(value);
      if (!body.success || body.data.device.actorId !== parsed.data.actorId) {
        throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      }
      if (parsed.data.deviceIdentityPublicKey) {
        const returnedIdentity = body.data.device_identity;
        if (!body.data.temporary_relay_credential_hash || !returnedIdentity) {
          throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
        }
        let expectedFingerprint: string;
        try {
          expectedFingerprint = relayIdentityFingerprint(parsed.data.deviceIdentityPublicKey);
        } catch {
          throw new CloudDeviceEnrollmentError("REJECTED", false);
        }
        if (
          returnedIdentity.public_key !== parsed.data.deviceIdentityPublicKey ||
          returnedIdentity.fingerprint !== expectedFingerprint
        ) {
          throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
        }
      }
      return {
        actorId: body.data.device.actorId,
        deviceId: body.data.device.id,
        ...(body.data.temporary_relay_credential_hash
          ? { temporaryRelayCredentialHash: body.data.temporary_relay_credential_hash }
          : {}),
        ...(body.data.device_identity
          ? {
              deviceIdentity: {
                publicKey: body.data.device_identity.public_key,
                fingerprint: body.data.device_identity.fingerprint,
              },
            }
          : {}),
      };
    },
    async complete(rawInput) {
      const parsed = CloudHostDeviceEnrollmentCompletionSchema.safeParse(rawInput);
      if (!parsed.success) throw new CloudDeviceEnrollmentError("REJECTED", false);
      let response: Response;
      try {
        response = await fetchImpl(`${origin}${CLOUD_DEVICE_ENROLLMENT_COMPLETE_PATH}`, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${options.hostCredential}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(parsed.data),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new CloudDeviceEnrollmentError("UNAVAILABLE", true);
      }
      if (response.status !== 200) {
        await boundedResponseText(response).catch(() => "");
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new CloudDeviceEnrollmentError(retryable ? "UNAVAILABLE" : "REJECTED", retryable);
      }
      let value: unknown;
      try {
        value = JSON.parse(await boundedResponseText(response));
      } catch (error) {
        if (error instanceof CloudDeviceEnrollmentError) throw error;
        throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      }
      const body = CloudHostDeviceEnrollmentCompletionResponseSchema.safeParse(value);
      if (!body.success) throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      return body.data;
    },
  };
}

export interface CreateCloudRelayDeviceEnrollmentSagaOptions {
  devices: DeviceStore;
  confirmer: CloudDeviceEnrollmentConfirmer;
  provisioner: RelayDeviceProvisioner;
  refreshAuthorization?: () => Promise<unknown>;
  /** Managed Nodes must observe the newly confirmed relay actor in a fresh signed snapshot before activation. */
  authorizationReady?: (actorId: string) => boolean;
  now?: () => number;
}

/** The control plane has one canonical identity namespace for both direct and relay-connected browsers. */
export function cloudDeviceEnrollmentAuthorizationReady(
  authorizationStore: Pick<CloudAuthorizationStore, "getActiveSnapshot">,
  actorId: string,
): boolean {
  if (!SAFE_IDENTIFIER.test(actorId) || actorId.length > 256) return false;
  const snapshot = authorizationStore.getActiveSnapshot();
  if (!snapshot) return false;
  return snapshot.grants.some(
    (grant) =>
      grant.principalType === "device" &&
      grant.principalId === actorId &&
      grant.permissions.includes("sessions:operate") &&
      (grant.scope.type === "organization" || (grant.scope.type === "host" && grant.scope.id === snapshot.hostId)),
  );
}

/**
 * Commits a browser enrollment in three durable phases. The control plane sees only the signed device public key;
 * local and relay bearer credentials stay inside the encrypted browser-to-Node channel and are persisted as hashes.
 */
export function createCloudRelayDeviceEnrollmentSaga(
  options: CreateCloudRelayDeviceEnrollmentSagaOptions,
): CloudRelayDeviceEnrollmentSaga {
  const now = options.now ?? Date.now;
  const refreshAuthorization = () => options.refreshAuthorization?.() ?? Promise.resolve();
  const assertAuthorizationReady = (actorId: string): void => {
    if (options.authorizationReady && !options.authorizationReady(actorId)) {
      throw new CloudDeviceEnrollmentError("UNAVAILABLE", true);
    }
  };

  return {
    async enroll(input) {
      const parsed = CloudRelayDeviceEnrollmentPayloadSchema.safeParse(input.cloudEnrollment);
      if (!parsed.success || !SAFE_IDENTIFIER.test(input.actorId) || input.actorId.length > 256) {
        throw new CloudDeviceEnrollmentError("REJECTED", false);
      }
      let identityFingerprint: string;
      try {
        identityFingerprint = relayIdentityFingerprint(input.deviceIdentityPublicKey);
      } catch {
        throw new CloudDeviceEnrollmentError("REJECTED", false);
      }
      const durableCredentialHash = relayCredentialHash(parsed.data.durableRelayCredential);
      let progress;
      try {
        progress = options.devices.beginCloudDeviceEnrollment(
          {
            enrollmentId: parsed.data.enrollmentId,
            deviceId: input.actorId,
            challenge: parsed.data.challenge,
            name: parsed.data.name,
            token: parsed.data.localDeviceToken,
            relayIdentityPublicKey: input.deviceIdentityPublicKey,
            durableRelayCredentialHash: durableCredentialHash,
          },
          now(),
        );
      } catch (error) {
        if (error instanceof CloudDeviceEnrollmentConflictError) {
          throw new CloudDeviceEnrollmentError("REJECTED", false);
        }
        throw error;
      }

      if (progress.state === "prepared") {
        const confirmed = await options.confirmer.confirm({
          v: 1,
          kind: "host-device-enrollment-confirmation",
          enrollmentId: parsed.data.enrollmentId,
          challenge: parsed.data.challenge,
          actorId: input.actorId,
          deviceIdentityPublicKey: input.deviceIdentityPublicKey,
        });
        if (
          confirmed.actorId !== input.actorId ||
          !confirmed.temporaryRelayCredentialHash ||
          confirmed.temporaryRelayCredentialHash === durableCredentialHash ||
          confirmed.deviceIdentity?.publicKey !== input.deviceIdentityPublicKey ||
          confirmed.deviceIdentity.fingerprint !== identityFingerprint
        ) {
          throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
        }
        try {
          progress = options.devices.finalizeCloudDeviceEnrollment(
            parsed.data.enrollmentId,
            confirmed.temporaryRelayCredentialHash,
            confirmed.deviceId,
            now(),
          );
        } catch (error) {
          if (error instanceof CloudDeviceEnrollmentConflictError) {
            throw new CloudDeviceEnrollmentError("REJECTED", false);
          }
          throw error;
        }
      }

      if (progress.state === "local-finalized") {
        const expectedCredentialHash = progress.temporaryRelayCredentialHash;
        if (!expectedCredentialHash) throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
        await options.provisioner.promoteDevice(input.actorId, expectedCredentialHash, durableCredentialHash);
        try {
          progress = options.devices.markCloudDeviceEnrollmentPromoted(
            parsed.data.enrollmentId,
            expectedCredentialHash,
            durableCredentialHash,
            now(),
          );
        } catch (error) {
          if (error instanceof CloudDeviceEnrollmentConflictError) {
            throw new CloudDeviceEnrollmentError("REJECTED", false);
          }
          throw error;
        }
      }

      if (progress.state === "cloud-report-pending") {
        const expectedCredentialHash = progress.temporaryRelayCredentialHash;
        const controlPlaneDeviceId = progress.controlPlaneDeviceId;
        if (!expectedCredentialHash || !controlPlaneDeviceId) {
          throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
        }
        const completion = await options.confirmer.complete({
          v: 1,
          kind: "host-device-enrollment-completion",
          enrollmentId: parsed.data.enrollmentId,
          actorId: input.actorId,
          temporaryRelayCredentialHash: expectedCredentialHash,
          durableRelayCredentialHash: durableCredentialHash,
        });
        if (completion.deviceId !== controlPlaneDeviceId) {
          throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
        }
        if (completion.state === "revoked") {
          await options.provisioner.revokeDevice(input.actorId, durableCredentialHash);
          try {
            options.devices.revokeCloudDeviceEnrollment(
              parsed.data.enrollmentId,
              controlPlaneDeviceId,
              expectedCredentialHash,
              durableCredentialHash,
              now(),
            );
          } catch (error) {
            if (error instanceof CloudDeviceEnrollmentConflictError) {
              throw new CloudDeviceEnrollmentError("REJECTED", false);
            }
            throw error;
          }
          throw new CloudDeviceEnrollmentError("REJECTED", false);
        }

        // Run this after both remote commits. A sync already in flight before confirmation could otherwise return a
        // snapshot that does not contain the actor while the newly durable broker credential is already usable.
        await refreshAuthorization();
        assertAuthorizationReady(input.actorId);
        try {
          progress = options.devices.completeCloudDeviceEnrollment(
            parsed.data.enrollmentId,
            expectedCredentialHash,
            durableCredentialHash,
            now(),
          );
        } catch (error) {
          if (error instanceof CloudDeviceEnrollmentConflictError) {
            throw new CloudDeviceEnrollmentError("REJECTED", false);
          }
          throw error;
        }
      }

      if (progress.state === "revoked") throw new CloudDeviceEnrollmentError("REJECTED", false);

      const device = options.devices.authenticate(parsed.data.localDeviceToken, now(), "relay");
      const pinnedIdentity = options.devices.relayIdentity(input.actorId);
      if (
        progress.state !== "complete" ||
        !device ||
        device.id !== input.actorId ||
        pinnedIdentity?.publicKey !== input.deviceIdentityPublicKey ||
        pinnedIdentity.fingerprint !== identityFingerprint
      ) {
        throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
      }
      return { device, token: parsed.data.localDeviceToken };
    },
    async recover() {
      let completed = 0;
      let failed = 0;
      const active: PendingCloudDevicePromotion[] = [];
      // Bound a recovery pass so a damaged or unexpectedly large local queue cannot monopolize the event loop.
      for (const pending of options.devices.pendingCloudDevicePromotions(now(), 25)) {
        try {
          if (!pending.brokerPromoted) {
            await options.provisioner.promoteDevice(
              pending.deviceId,
              pending.expectedCredentialHash,
              pending.credentialHash,
            );
            options.devices.markCloudDeviceEnrollmentPromoted(
              pending.enrollmentId,
              pending.expectedCredentialHash,
              pending.credentialHash,
              now(),
            );
          }
          const completion = await options.confirmer.complete({
            v: 1,
            kind: "host-device-enrollment-completion",
            enrollmentId: pending.enrollmentId,
            actorId: pending.deviceId,
            temporaryRelayCredentialHash: pending.expectedCredentialHash,
            durableRelayCredentialHash: pending.credentialHash,
          });
          if (completion.deviceId !== pending.controlPlaneDeviceId) {
            throw new CloudDeviceEnrollmentError("INVALID_RESPONSE", false);
          }
          if (completion.state === "revoked") {
            await options.provisioner.revokeDevice(pending.deviceId, pending.credentialHash);
            options.devices.revokeCloudDeviceEnrollment(
              pending.enrollmentId,
              pending.controlPlaneDeviceId,
              pending.expectedCredentialHash,
              pending.credentialHash,
              now(),
            );
            completed += 1;
            continue;
          }
          active.push({ ...pending, brokerPromoted: true });
        } catch {
          options.devices.deferCloudDevicePromotion(
            pending.enrollmentId,
            pending.expectedCredentialHash,
            pending.credentialHash,
            now(),
          );
          failed += 1;
        }
      }
      if (active.length === 0) return { completed, failed };
      try {
        // One signed snapshot covers the whole bounded batch and avoids revision replay failures between actors.
        await refreshAuthorization();
      } catch {
        for (const pending of active) {
          options.devices.deferCloudDevicePromotion(
            pending.enrollmentId,
            pending.expectedCredentialHash,
            pending.credentialHash,
            now(),
          );
        }
        return { completed, failed: failed + active.length };
      }
      for (const pending of active) {
        try {
          assertAuthorizationReady(pending.deviceId);
          options.devices.completeCloudDeviceEnrollment(
            pending.enrollmentId,
            pending.expectedCredentialHash,
            pending.credentialHash,
            now(),
          );
          completed += 1;
        } catch {
          options.devices.deferCloudDevicePromotion(
            pending.enrollmentId,
            pending.expectedCredentialHash,
            pending.credentialHash,
            now(),
          );
          failed += 1;
        }
      }
      return { completed, failed };
    },
  };
}

export interface CloudDeviceEnrollmentRecoveryLoop {
  start(): void;
  stop(): Promise<void>;
}

export interface CreateCloudDeviceEnrollmentRecoveryLoopOptions {
  saga: Pick<CloudRelayDeviceEnrollmentSaga, "recover">;
  intervalMs?: number;
  onResult?: (result: { completed: number; failed: number }) => void;
}

/**
 * Starts one recovery attempt immediately and retries on a fixed cadence without ever overlapping attempts.
 * The saga itself caps each pass and every network client it calls has a request timeout.
 */
export function createCloudDeviceEnrollmentRecoveryLoop(
  options: CreateCloudDeviceEnrollmentRecoveryLoopOptions,
): CloudDeviceEnrollmentRecoveryLoop {
  const intervalMs = options.intervalMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 5 * 60_000) {
    throw new Error("invalid cloud device enrollment recovery interval");
  }
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  const report = (result: { completed: number; failed: number }) => {
    try {
      options.onResult?.(result);
    } catch {
      /* Reporting must never stop recovery or become an unhandled rejection. */
    }
  };

  const run = () => {
    if (!running || inFlight) return;
    const operation = options.saga
      .recover()
      .then(report)
      .catch(() => report({ completed: 0, failed: 1 }))
      .finally(() => {
        if (inFlight === operation) inFlight = undefined;
      });
    inFlight = operation;
  };

  return {
    start() {
      if (running) return;
      running = true;
      run();
      timer = setInterval(run, intervalMs);
      timer.unref?.();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
