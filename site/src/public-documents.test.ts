import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test } from "vitest";

import {
  PUBLIC_DOCUMENT_PATHS,
  isPublicDocumentPath,
  mountPublicDocument,
  renderPublicDocument,
} from "./public-documents";

describe("public operational and legal documents", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  test("renders every published route as a complete, canonical, keyboard-navigable document", () => {
    const allowedInternalTargets = new Set([
      "/",
      "/app",
      "/source/license",
      "/source/security",
      "/source/security-policy",
      "/source/discussions",
      ...PUBLIC_DOCUMENT_PATHS,
    ]);
    for (const path of PUBLIC_DOCUMENT_PATHS) {
      const html = renderPublicDocument(`${path}/`);
      expect(html).toBeTypeOf("string");
      const page = new DOMParser().parseFromString(html!, "text/html");
      expect(page.documentElement.lang).toBe("en");
      expect(page.querySelector("h1")?.textContent?.trim()).not.toBe("");
      expect(page.querySelector('a.skip[href="#document-content"]')).not.toBeNull();
      expect(page.querySelector('main[id="document-content"][tabindex="-1"]')).not.toBeNull();
      expect(page.querySelector(`link[rel="canonical"][href="https://roamcode.ai${path}"]`)).not.toBeNull();
      expect(page.querySelector('nav[aria-label="Legal documents"]')).not.toBeNull();
      expect(page.body.textContent).toContain("MIT License");

      for (const link of page.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')) {
        const target = new URL(link.href, "https://roamcode.ai").pathname;
        expect(allowedInternalTargets.has(target), `${path} links to unpublished ${target}`).toBe(true);
      }
    }
  });

  test("renders the same v1.0 managed terms that the account service accepts", () => {
    const terms = renderPublicDocument("/legal/terms")!;
    expect(terms).toContain("RoamCode Cloud Public Preview Terms");
    expect(terms).toContain("Version</dt><dd>1.0");
    expect(terms).toContain("Open-source RoamCode components are governed by the license included");
    expect(terms).toContain("You retain all rights in your hosts, source code, terminal sessions");
    expect(terms).not.toContain("preview-2026-07-17");
    expect(terms).not.toMatch(/self-host(?:ed)?[^.]{0,80}(?:forbidden|prohibited|not permitted)/iu);

    const acceptableUse = renderPublicDocument("/legal/acceptable-use")!;
    expect(acceptableUse).toContain("systems, accounts, repositories, and data that you are authorized to access");
    expect(acceptableUse).toContain("private RoamCode service components");
  });

  test("states the canonical privacy and encrypted-terminal boundary", () => {
    const privacy = renderPublicDocument("/legal/privacy")!;
    for (const localOnlyFact of [
      "terminal streams and file contents",
      "encrypted form",
      "not required by the control plane",
      "does not sell personal information",
    ]) {
      expect(privacy).toContain(localOnlyFact);
    }
    expect(privacy).not.toContain("We are GDPR compliant");
  });

  test("publishes the canonical DPA and keeps the separate subprocessor register explicit", () => {
    const dpa = renderPublicDocument("/legal/dpa")!;
    const subprocessors = renderPublicDocument("/legal/subprocessors")!;
    expect(dpa).toContain("RoamCode Cloud Data Processing Addendum");
    expect(dpa).toContain("The customer is the controller and RoamCode is the processor");
    expect(dpa).toContain("end-to-end encrypted between authorized customer endpoints");
    expect(subprocessors).toContain("No production subprocessor list");
    expect(subprocessors).toContain("must name each legal entity");
  });

  test("pins every canonical legal source to the control-plane manifest hash", () => {
    const manifest = JSON.parse(readFileSync("src/legal/manifest.json", "utf8")) as {
      schemaVersion: number;
      documents: Array<{ type: string; version: string; source: string; sha256: string; publicUrl: string }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.documents.map((document) => document.type)).toEqual(["terms", "privacy", "aup", "dpa"]);
    for (const document of manifest.documents) {
      const source = readFileSync(`src/legal/${document.source}`);
      expect(createHash("sha256").update(source).digest("hex"), document.source).toBe(document.sha256);
      expect(document.version).toBe("1.0");
      expect(renderPublicDocument(new URL(document.publicUrl).pathname)).toContain("Version</dt><dd>1.0");
    }
  });

  test("mounts a selected document locally and rejects unknown routes", () => {
    expect(isPublicDocumentPath("/legal/privacy/")).toBe(true);
    expect(isPublicDocumentPath("/legal/cookies")).toBe(false);
    expect(renderPublicDocument("/legal/cookies")).toBeUndefined();

    expect(mountPublicDocument("/security")).toBe(true);
    expect(document.title).toBe("Security Overview — RoamCode");
    expect(document.querySelector("h1")?.textContent).toBe("Security Overview");
    expect(document.querySelector('a[href="/source/security"]')).not.toBeNull();
  });
});
