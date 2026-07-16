import type { RelayDeviceProvisioner } from "./relay-provision.js";

export interface RelayPairingPackage {
  v: 1;
  label: string;
  relayUrl: string;
  routeId: string;
  deviceId: string;
  deviceCredential: string;
  deviceToken: string;
  pairingSecret: string;
  expiresAt: number;
  hostIdentityPublicKey: string;
  hostIdentityFingerprint: string;
}

export interface RelayPairingBootstrap {
  appUrl: string;
  label: string;
  relayUrl: string;
  routeId: string;
  hostIdentityPublicKey: string;
  hostIdentityFingerprint: string;
  provisioner: RelayDeviceProvisioner;
  generateDeviceCredential?: () => string;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

export function normalizeRelayAppUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("relay app URL must be an origin without credentials, a path, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("relay app URL must use HTTPS away from loopback");
  }
  return url.origin;
}

export function buildRelayPairingUrl(appUrl: string, pairing: RelayPairingPackage): string {
  const url = new URL("/", normalizeRelayAppUrl(appUrl));
  url.hash = `relay-pair=${Buffer.from(JSON.stringify(pairing), "utf8").toString("base64url")}`;
  return url.toString();
}
