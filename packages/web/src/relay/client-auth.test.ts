import { describe, expect, test } from "vitest";
import { browserRelayAuthenticationPayload } from "./client";

const temporary = `rrd_${"t".repeat(43)}`;
const durable = `rrd_${"d".repeat(43)}`;
const token = `rcd_${"k".repeat(43)}`;

describe("browser relay authentication payload", () => {
  test("keeps the account enrollment and raw durable credentials inside the encrypted auth shape", () => {
    const payload = browserRelayAuthenticationPayload({
      deviceToken: token,
      deviceCredential: temporary,
      cloudEnrollment: {
        enrollmentId: "11111111-1111-4111-8111-111111111111",
        challenge: `rce_${"c".repeat(43)}`,
        name: "Work browser",
        durableRelayCredential: durable,
      },
    });

    expect(payload).toEqual({
      token,
      relayCredential: durable,
      cloudEnrollment: {
        v: 1,
        kind: "cloud-device-enrollment",
        enrollmentId: "11111111-1111-4111-8111-111111111111",
        challenge: `rce_${"c".repeat(43)}`,
        name: "Work browser",
        localDeviceToken: token,
        durableRelayCredential: durable,
      },
    });
    expect(JSON.stringify(payload)).not.toContain(temporary);
    expect(payload).not.toHaveProperty("pairing");
  });

  test("preserves the existing manual relay-pairing payload", () => {
    expect(
      browserRelayAuthenticationPayload({
        deviceToken: token,
        deviceCredential: temporary,
        pairing: { secret: `rcp_${"p".repeat(43)}`, name: "Phone", relayCredential: durable },
      }),
    ).toEqual({
      token,
      relayCredential: durable,
      pairing: { secret: `rcp_${"p".repeat(43)}`, name: "Phone" },
    });
  });
});
