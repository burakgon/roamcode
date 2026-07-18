import acceptableUseMarkdown from "./legal/aup-v1.md";
import dpaMarkdown from "./legal/dpa-v1.md";
import privacyMarkdown from "./legal/privacy-v1.md";
import termsMarkdown from "./legal/terms-v1.md";

export const PUBLIC_DOCUMENT_PATHS = [
  "/legal/terms",
  "/legal/privacy",
  "/legal/acceptable-use",
  "/legal/dpa",
  "/legal/subprocessors",
  "/security",
  "/contact",
] as const;

export type PublicDocumentPath = (typeof PUBLIC_DOCUMENT_PATHS)[number];

interface PublicDocumentSection {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface PublicDocument {
  title: string;
  eyebrow: string;
  summary: string;
  version: string;
  effectiveDate: string;
  provisional?: string;
  sections: PublicDocumentSection[];
  source?: string;
}

const effectiveDate = "July 17, 2026";
const previewVersion = "preview-2026-07-17";

const canonicalLegalDocuments: Partial<Record<PublicDocumentPath, PublicDocument>> = {
  "/legal/terms": {
    title: "RoamCode Cloud Public Preview Terms",
    eyebrow: "Legal",
    summary: "Terms for the hosted RoamCode control-plane and relay public preview.",
    version: "1.0",
    effectiveDate: "17 July 2026",
    sections: [],
    source: termsMarkdown,
  },
  "/legal/privacy": {
    title: "RoamCode Cloud Privacy Notice",
    eyebrow: "Legal",
    summary: "How the hosted RoamCode public preview handles personal information.",
    version: "1.0",
    effectiveDate: "17 July 2026",
    sections: [],
    source: privacyMarkdown,
  },
  "/legal/acceptable-use": {
    title: "RoamCode Cloud Acceptable Use Policy",
    eyebrow: "Legal",
    summary: "Rules for authorized and safe use of the hosted RoamCode public preview.",
    version: "1.0",
    effectiveDate: "17 July 2026",
    sections: [],
    source: acceptableUseMarkdown,
  },
  "/legal/dpa": {
    title: "RoamCode Cloud Data Processing Addendum",
    eyebrow: "Legal",
    summary: "Data-processing terms for organizations using the hosted RoamCode Cloud Service.",
    version: "1.0",
    effectiveDate: "17 July 2026",
    sections: [],
    source: dpaMarkdown,
  },
};

const documents: Record<PublicDocumentPath, PublicDocument> = {
  "/legal/terms": {
    title: "Interim Managed Service Terms",
    eyebrow: "Legal",
    summary:
      "Terms for the optional RoamCode managed account and relay preview. The open-source software remains available under the MIT License.",
    version: previewVersion,
    effectiveDate,
    provisional:
      "These are interim preview terms, not a final enterprise order form. The managed-service operator, commercial terms, governing law, support commitments, and any negotiated liability terms must be identified in your account or signed order before paid production use.",
    sections: [
      {
        title: "1. Scope",
        paragraphs: [
          "These terms apply to the optional managed account, organization, browser-enrollment, and blind-relay services reached through roamcode.ai (the “Managed Service”). They do not replace the license for software you download, self-host, modify, or redistribute.",
          "The party identified as the service operator in your account or signed order is the provider of the Managed Service. Until an operator and final commercial terms are identified, the service is a preview provided for evaluation rather than a production commitment.",
        ],
      },
      {
        title: "2. Open-source software",
        paragraphs: [
          'The public RoamCode repository is licensed under the <a href="/source/license">MIT License</a>. That license permits use, copying, modification, distribution, sublicensing, and sale subject to its notice requirement. These Managed Service terms do not narrow or revoke that grant.',
          "Third-party coding agents, identity providers, hosting platforms, and package dependencies remain subject to their own terms and licenses.",
        ],
      },
      {
        title: "3. Accounts and organizations",
        bullets: [
          "Provide accurate account information and keep authentication methods and devices secure.",
          "Use an Organization only when you are authorized to act for it and invite its members.",
          "Review roles, Node grants, signed-in CLI devices, and browser access; revoke access that is no longer needed.",
          "Notify the operator through the published contact channel if you reasonably believe an account or managed route is compromised.",
        ],
      },
      {
        title: "4. Customer-controlled execution",
        paragraphs: [
          "RoamCode operates the real Claude Code, Codex, or another installed adapter on a customer-controlled Node. The agent runs with the authority of that Node’s operating-system user. RoamCode is not a sandbox and does not independently review the commands, code changes, files, or external actions produced by an agent.",
          "You are responsible for Node security, repository backups, provider accounts, provider-native safety settings, instructions given to agents, and human review of consequential actions. Only connect Nodes, repositories, accounts, and systems you are authorized to use.",
        ],
      },
      {
        title: "5. Managed Service boundary",
        paragraphs: [
          "The account service manages identity, Organizations, membership, Node inventory, grants, enrollment, and coarse service health. The managed relay is designed to route end-to-end encrypted frames and minimum routing metadata. Source code, prompts, working directories, provider credentials, and terminal plaintext are intended to remain on the selected Node and authorized browser.",
          'The detailed data boundary is described in the <a href="/legal/privacy">Privacy Notice</a> and <a href="/security">Security Overview</a>.',
        ],
      },
      {
        title: "6. Acceptable use",
        paragraphs: [
          'You must follow the <a href="/legal/acceptable-use">Acceptable Use Policy</a>. The operator may limit or suspend managed access when reasonably necessary to protect users, the service, or third parties, investigate abuse, comply with law, or respond to a security incident.',
        ],
      },
      {
        title: "7. Preview availability and changes",
        paragraphs: [
          "The preview may change, be rate-limited, interrupted, or withdrawn. No service-level agreement, uptime promise, support response time, data-residency commitment, or production warranty exists unless it appears in a signed order.",
          "Material changes to accepted managed-service terms should be versioned and presented for acceptance before they apply. Security and abuse controls may be changed immediately when reasonably required to protect the service.",
        ],
      },
      {
        title: "8. Suspension, termination, and export",
        paragraphs: [
          "You may stop using the Managed Service and disconnect your Nodes. Account deletion, export, retention, and offboarding capabilities remain subject to the controls actually shown in the product and any signed order. Self-hosted software and data on your Nodes are not automatically deleted when a managed account is closed.",
        ],
      },
      {
        title: "9. Disclaimers and liability",
        paragraphs: [
          "The Managed Service preview is provided on an “as is” and “as available” basis to the maximum extent permitted by applicable law. Nothing here excludes a right or liability that applicable law does not allow the parties to exclude.",
          "Final warranty, indemnity, liability cap, governing-law, and dispute terms require an identified operator and signed commercial terms. This interim page does not invent those terms.",
        ],
      },
      {
        title: "10. Contact",
        paragraphs: [
          'Use the current <a href="/contact">Contact page</a> for product, privacy, and legal routing. Report vulnerabilities only through the private channel described on the <a href="/security">Security page</a>.',
        ],
      },
    ],
  },
  "/legal/privacy": {
    title: "Interim Privacy Notice",
    eyebrow: "Legal",
    summary:
      "What the current RoamCode public site and optional managed preview process—and what remains on your Nodes.",
    version: previewVersion,
    effectiveDate,
    provisional:
      "This notice accurately describes the current product boundary but is not a substitute for identifying the final managed-service operator, representative, data-protection contact, hosting locations, retention schedule, and transfer mechanism before paid production use.",
    sections: [
      {
        title: "1. Scope and roles",
        paragraphs: [
          "This notice covers the roamcode.ai public site and optional Managed Service. A self-hosted RoamCode operator controls its own deployment and data; the public project does not receive that deployment’s terminal traffic merely because the software is installed.",
          "For the Managed Service, the operator identified in your account or signed order acts as controller for account administration, service security, and its own legal obligations. Where an enterprise customer instructs the operator to process personal data in Organization metadata, the parties must document controller and processor roles in an executed data processing agreement.",
        ],
      },
      {
        title: "2. Data the Managed Service receives",
        bullets: [
          "Account identity and authentication data, such as name, email address, verification state, account identifiers, and the identity provider or passkey used.",
          "Personal and Organization context, membership, invitation, role, Node-access, and legal-acceptance records.",
          "Node inventory and coarse health data, such as Node name, platform, service version, online state, last heartbeat, runtime availability, and managed-route status.",
          "Public browser or CLI identity material, requested scopes, revocation state, and coarse last-used timestamps needed to authorize devices.",
          "Security and operational metadata needed to authenticate requests, rate-limit abuse, diagnose failures, and maintain audit records. This can include time, request route, result, IP-derived security signals, and bounded actor or resource identifiers.",
          "Messages you intentionally send through a published support, legal, or security channel.",
        ],
      },
      {
        title: "3. Data designed to stay off the account service",
        bullets: [
          "Repository contents, source code, prompts, terminal output, working-directory paths, and provider conversation content.",
          "Claude Code, Codex, or other provider credentials and API keys.",
          "Raw Node, browser-device, pairing, durable relay, or recovery credentials. Enrollment sends public identity material and a domain-separated hash of a temporary relay credential rather than the reusable secret.",
          "Plaintext carried over the blind relay. Authorized endpoints encrypt and decrypt the terminal and Node protocol frames.",
        ],
      },
      {
        title: "4. Browser storage and cookies",
        paragraphs: [
          "The account surface uses essential HttpOnly cookies to maintain a signed-in session. It also uses browser storage for the selected context and short-lived invite, reset, or enrollment recovery state. The terminal PWA stores device-scoped preferences and credentials locally so it can reconnect to an authorized Node.",
          "The current public site does not use advertising cookies. Infrastructure providers may still process ordinary request and security logs needed to deliver and protect the site.",
        ],
      },
      {
        title: "5. Purposes and legal bases",
        paragraphs: [
          "Data is used to create and secure accounts, provide Organizations and Node enrollment, enforce access and revocation, operate the managed relay, prevent abuse, diagnose incidents, communicate service changes, and comply with law.",
          "Where data-protection law applies, the expected bases are performance of the requested service, legitimate interests in securing and improving it, compliance with legal obligations, and consent only for an optional use that genuinely relies on consent. The identified operator must confirm the bases that apply to its deployment before production use.",
        ],
      },
      {
        title: "6. Sharing and subprocessors",
        paragraphs: [
          'Data may be processed by infrastructure, identity, communications, and security providers needed to operate the feature you choose; by Organization administrators acting within their role; or when required by law. RoamCode does not sell account data or use terminal content for advertising. The current readiness status is published at <a href="/legal/subprocessors">Subprocessors</a>.',
        ],
      },
      {
        title: "7. Retention and deletion",
        paragraphs: [
          "Account, Organization, grant, and security records are kept while needed to provide and protect the Managed Service and to meet legal obligations. Expired enrollment and recovery records are bounded and pruned. A final production retention schedule and backup-deletion window have not yet been published.",
          "Revoking a cloud device or managed browser grant stops future authorized use but does not silently delete local Node data. Closing a managed account likewise does not erase repositories, provider history, tmux sessions, or configuration stored on a customer-controlled Node.",
        ],
      },
      {
        title: "8. Security",
        paragraphs: [
          'Current controls include same-origin account routing, essential HttpOnly account cookies, scoped and revocable credentials, end-to-end encrypted relay frames, signed authorization snapshots, explicit enrollment, security headers, and privacy-bounded audit metadata. No system is risk-free; see the <a href="/security">Security Overview</a> and keep Nodes and provider accounts patched.',
        ],
      },
      {
        title: "9. Your choices and rights",
        paragraphs: [
          "Depending on where you live and the operator’s role, you may have rights to information, access, correction, deletion, restriction, portability, objection, withdrawal of consent, and complaint to a data-protection authority. These rights can have exceptions and may not apply to data controlled solely by your employer or self-hosted operator.",
          'Use the route identified on the <a href="/contact">Contact page</a>. The final operator must publish a verified privacy contact and any required representative or data-protection officer before production processing.',
        ],
      },
      {
        title: "10. International transfers and children",
        paragraphs: [
          "No transfer mechanism or regional hosting commitment is claimed by this preview notice. Those details must be published with the final operator and subprocessor list. The Managed Service is a developer tool for people authorized to operate development systems and is not directed to children.",
        ],
      },
    ],
  },
  "/legal/acceptable-use": {
    title: "Acceptable Use Policy",
    eyebrow: "Legal",
    summary: "Rules for using the optional managed account and relay without harming users, systems, or the service.",
    version: previewVersion,
    effectiveDate,
    provisional:
      "This interim policy governs the managed preview only. It does not add field-of-use restrictions to software received under the MIT License.",
    sections: [
      {
        title: "1. Authorized systems only",
        paragraphs: [
          "Use RoamCode only with Nodes, repositories, accounts, credentials, networks, and third-party services you own or are authorized to operate. Do not use the Managed Service to gain or retain unauthorized access.",
        ],
      },
      {
        title: "2. Prohibited managed-service use",
        bullets: [
          "Malware delivery, credential theft, phishing, destructive payloads, botnet control, cryptomining abuse, or deliberate persistence on systems without authorization.",
          "Harassment, threats, unlawful surveillance, privacy invasion, exploitation, or processing that violates applicable law or another person’s rights.",
          "Uploading, distributing, or generating content when you lack the rights or legal authority to do so.",
          "Bypassing authentication, revocation, rate limits, tenant boundaries, safety controls, or service restrictions.",
          "Probing or disrupting other users, Organizations, Nodes, routes, or infrastructure; intercepting traffic; or attempting to obtain credentials or plaintext that the relay is not meant to see.",
          "Reselling or sharing managed access in a way that conceals the responsible account or prevents abuse response, unless a signed order permits it.",
        ],
      },
      {
        title: "3. Security research",
        paragraphs: [
          'Good-faith research must minimize access and impact, avoid customer data, stop when sensitive information is encountered, and use the private process on the <a href="/security">Security page</a>. Do not publish exploitable details before a reasonable remediation window.',
        ],
      },
      {
        title: "4. Automated and high-impact actions",
        paragraphs: [
          "You remain responsible for agent instructions and outcomes. Use human review and provider-native controls before deploying code, changing production systems, sending communications, spending money, handling regulated data, or taking another consequential action.",
        ],
      },
      {
        title: "5. Enforcement",
        paragraphs: [
          "The operator may investigate credible abuse and proportionately rate-limit, revoke a credential, isolate a route, suspend managed access, preserve required evidence, or report unlawful activity. When practicable and safe, the operator should provide notice and a route to contest an action.",
        ],
      },
      {
        title: "6. Scope of this policy",
        paragraphs: [
          'This policy controls use of the Managed Service. Your rights to use the public software are governed by the <a href="/source/license">MIT License</a> and applicable law, not by a hidden enterprise field-of-use restriction.',
        ],
      },
    ],
  },
  "/legal/dpa": {
    title: "Data Processing Addendum Readiness",
    eyebrow: "Legal",
    summary:
      "The processing boundary and terms that must be completed before RoamCode is offered as a production enterprise processor.",
    version: previewVersion,
    effectiveDate,
    provisional:
      "This page is not an executed DPA and does not by itself appoint a processor. Enterprise processing requires a signed addendum identifying both parties and completing the items below.",
    sections: [
      {
        title: "1. Intended roles and scope",
        paragraphs: [
          "When a customer submits personal data in Organization, membership, invitation, Node, grant, or support metadata for the operator to process on its behalf, the customer is expected to act as controller and the identified managed-service operator as processor for that data. The operator remains an independent controller for its own account security, abuse prevention, and legal obligations where applicable.",
          "Self-hosted RoamCode is outside this managed DPA boundary: the self-hosting party chooses and controls its own infrastructure and processing.",
        ],
      },
      {
        title: "2. Processing details to appear in an executed DPA",
        bullets: [
          "Subject matter: managed identity, Organization administration, Node inventory, scoped access, browser enrollment, and encrypted relay reachability.",
          "Duration: the service term plus a documented deletion and backup-expiry period.",
          "Nature and purpose: authenticate people and devices, enforce grants, route encrypted frames, maintain security records, and provide support under documented instructions.",
          "Data subjects: customer personnel, contractors, invited users, and people named in customer-submitted support or administrative metadata.",
          "Data categories: account identifiers and contact details; membership, role, invitation, Node, device, grant, coarse health, legal-acceptance, and privacy-bounded security metadata.",
          "Excluded by design: provider credentials, source code, prompts, terminal plaintext, working-directory paths, and reusable Node or relay secrets in the account service.",
        ],
      },
      {
        title: "3. Required contractual commitments",
        bullets: [
          "Process personal data only on documented customer instructions and notify the customer if an instruction appears unlawful.",
          "Bind authorized personnel to confidentiality and limit access by role and need.",
          "Maintain appropriate technical and organizational measures and help the customer respond to rights requests, security incidents, impact assessments, and regulator consultations.",
          "Delete or return customer personal data after the service, subject to documented legal retention, and describe backup expiry.",
          "Provide information reasonably needed to demonstrate compliance and define a proportionate audit process.",
          "Flow equivalent obligations to approved subprocessors and remain responsible for their processing as required by the executed agreement.",
        ],
      },
      {
        title: "4. Security schedule",
        paragraphs: [
          'The current architecture uses scoped credentials, explicit revocation, same-origin account routing, signed authorization, end-to-end encrypted relay frames, bounded enrollment recovery, and privacy-safe service metadata. A production security schedule must identify operational controls, access review, key management, vulnerability handling, incident notification, backup, recovery, and testing. See the <a href="/security">Security Overview</a>.',
        ],
      },
      {
        title: "5. Subprocessors and transfers",
        paragraphs: [
          'No final subprocessor authorization, hosting region, data-residency promise, Standard Contractual Clauses, UK addendum, adequacy reliance, or transfer-impact assessment is claimed here. These must be completed in the signed DPA and published <a href="/legal/subprocessors">subprocessor register</a> before production enterprise processing.',
        ],
      },
      {
        title: "6. How to complete a DPA",
        paragraphs: [
          'The final operator must publish a verified legal contact and executable addendum process on the <a href="/contact">Contact page</a>. Until then, this page documents readiness and product boundaries only.',
        ],
      },
    ],
  },
  "/legal/subprocessors": {
    title: "Subprocessor Readiness Register",
    eyebrow: "Legal",
    summary: "Current managed-preview dependency categories and the information still required for a production list.",
    version: previewVersion,
    effectiveDate,
    provisional:
      "No production subprocessor list or transfer commitment has been finalized. Do not treat this readiness register as authorization for regulated production data.",
    sections: [
      {
        title: "Current categories",
        bullets: [
          "Edge, DNS, static asset, request-security, and Worker infrastructure used to serve roamcode.ai and proxy same-origin account requests.",
          "Managed database, compute, storage, and observability infrastructure used by the separately operated account control plane.",
          "Identity providers chosen by the operator or customer for social or managed sign-in.",
          "Transactional communications providers, if enabled for verification, password reset, invitations, or service notices.",
        ],
      },
      {
        title: "What is not a managed subprocessor by default",
        paragraphs: [
          "Claude Code, Codex, repositories, CI systems, and other tools running from a Node are selected and controlled by the customer. Their data flows are not routed through the account service merely because RoamCode opens their terminal UI.",
          "A provider can still be the customer’s own vendor and processor under the customer’s separate agreement.",
        ],
      },
      {
        title: "Production publication requirement",
        paragraphs: [
          "Before enterprise production processing, this register must name each legal entity, service purpose, processing location, data categories, transfer safeguard, and notice mechanism for changes. A signed DPA must define authorization and objection rights.",
        ],
      },
      {
        title: "Questions",
        paragraphs: [
          'Use the <a href="/contact">Contact page</a>. No unnamed provider, region, or transfer safeguard should be inferred from this preview register.',
        ],
      },
    ],
  },
  "/security": {
    title: "Security Overview",
    eyebrow: "Trust center",
    summary: "How RoamCode separates the account control plane, encrypted reachability, and real agent execution.",
    version: "current",
    effectiveDate,
    sections: [
      {
        title: "Report a vulnerability",
        paragraphs: [
          'Do not open a public issue with vulnerability details. Use GitHub’s private vulnerability reporting from the repository <a href="/source/security">Security tab</a>. If that is unavailable, open a minimal issue asking maintainers to establish a private channel and include no sensitive details.',
        ],
      },
      {
        title: "Execution boundary",
        paragraphs: [
          "RoamCode runs the real coding-agent CLI on a customer-controlled Node as that Node’s operating-system user. It is remote code execution by design, not a sandbox. Provider-native approvals and sandboxing can reduce risk but do not replace Node hardening, least privilege, backups, and human review.",
        ],
      },
      {
        title: "Managed relay boundary",
        paragraphs: [
          "The optional relay is a reachability service. The browser and Node establish a pinned encrypted channel; the relay routes bounded ciphertext and minimum routing metadata. Account, Node, device, and relay credentials have separate purposes and revocation boundaries.",
        ],
      },
      {
        title: "Current safeguards",
        bullets: [
          "Mandatory direct-installation credentials, short-lived one-use pairing, independent device revocation, and cross-origin request checks.",
          "Same-origin hosted account routing, HttpOnly account cookies, explicit Node selection, public-key browser identity, and fresh signed authorization before enrollment completion.",
          "End-to-end encrypted relay frames, pinned endpoint identities, replay/order checks, bounded frames and queues, and separate route capabilities.",
          "Security headers, no-referrer account and terminal shells, rate limiting, privacy-bounded audit metadata, and stable-release integrity checks.",
        ],
      },
      {
        title: "Support boundary",
        paragraphs: [
          'Only the latest stable SemVer release is supported. Review the full public <a href="/source/security-policy">Security Policy</a> before exposing a Node remotely.',
        ],
      },
    ],
  },
  "/contact": {
    title: "Contact and Support",
    eyebrow: "RoamCode",
    summary: "Use the channel that matches the request and keep secrets out of public posts.",
    version: "current",
    effectiveDate,
    provisional:
      "A verified managed-service legal entity, privacy address, enterprise sales route, and support SLA have not yet been published. They must be added before paid production service.",
    sections: [
      {
        title: "Product help and community",
        paragraphs: [
          'Use <a href="/source/discussions">GitHub Discussions</a> for public product questions and implementation help. Use the public issue tracker only for non-sensitive reproducible bugs. Never include tokens, credentials, private URLs, customer data, or production logs.',
        ],
      },
      {
        title: "Security",
        paragraphs: [
          'Use the private route described on the <a href="/security">Security page</a>. Do not send vulnerability details through Discussions or a public issue.',
        ],
      },
      {
        title: "Privacy, legal, and enterprise",
        paragraphs: [
          "The production operator must publish verified private contact details in the account surface and any signed order. Until that exists, do not submit regulated production data or rely on the preview for a rights request, DPA signature, procurement notice, or contractual support commitment.",
          'The current public documents are the <a href="/legal/terms">Interim Terms</a>, <a href="/legal/privacy">Privacy Notice</a>, <a href="/legal/acceptable-use">Acceptable Use Policy</a>, and <a href="/legal/dpa">DPA Readiness</a>.',
        ],
      },
    ],
  },
};

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function isPublicDocumentPath(pathname: string): pathname is PublicDocumentPath {
  return (PUBLIC_DOCUMENT_PATHS as readonly string[]).includes(normalizedPath(pathname));
}

function documentForPath(pathname: string): [PublicDocumentPath, PublicDocument] | undefined {
  const normalized = normalizedPath(pathname);
  if (!isPublicDocumentPath(normalized)) return;
  return [normalized, canonicalLegalDocuments[normalized] ?? documents[normalized]];
}

function renderSection(section: PublicDocumentSection, index: number): string {
  return `<section class="rc-document-section" aria-labelledby="section-${index}">
    <h2 id="section-${index}">${section.title}</h2>
    ${(section.paragraphs ?? []).map((paragraph) => `<p>${paragraph}</p>`).join("")}
    ${section.bullets ? `<ul>${section.bullets.map((item) => `<li>${item}</li>`).join("")}</ul>` : ""}
  </section>`;
}

function renderInlineMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/gu, (url) => `<a href="${url}" rel="noopener">${url}</a>`);
}

function renderCanonicalMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0]?.startsWith("# ")) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  if (lines[0]?.startsWith("Effective:")) lines.shift();
  while (lines[0]?.trim() === "") lines.shift();
  const output: string[] = [];
  let sectionOpen = false;
  let listOpen = false;
  let sectionIndex = 0;
  const closeList = () => {
    if (!listOpen) return;
    output.push("</ul>");
    listOpen = false;
  };
  const closeSection = () => {
    closeList();
    if (!sectionOpen) return;
    output.push("</section>");
    sectionOpen = false;
  };
  const openSection = (title?: string) => {
    closeSection();
    sectionIndex += 1;
    output.push(
      title
        ? `<section class="rc-document-section" aria-labelledby="canonical-section-${sectionIndex}"><h2 id="canonical-section-${sectionIndex}">${renderInlineMarkdown(title)}</h2>`
        : '<section class="rc-document-section" aria-label="Introduction">',
    );
    sectionOpen = true;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith("## ")) {
      openSection(line.slice(3));
      continue;
    }
    if (!sectionOpen) openSection();
    if (line.startsWith("- ")) {
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    output.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  closeSection();
  return output.join("");
}

const legalNavigation: Array<[PublicDocumentPath, string]> = [
  ["/legal/terms", "Terms"],
  ["/legal/privacy", "Privacy"],
  ["/legal/acceptable-use", "Acceptable use"],
  ["/legal/dpa", "DPA readiness"],
  ["/legal/subprocessors", "Subprocessors"],
];

export function renderPublicDocument(pathname: string): string | undefined {
  const entry = documentForPath(pathname);
  if (!entry) return;
  const [path, document] = entry;
  const title = `${document.title} — RoamCode`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#07070a" />
    <meta name="description" content="${document.summary}" />
    <link rel="canonical" href="https://roamcode.ai${path}" />
    <title>${title}</title>
    <style>${publicDocumentCss}</style>
  </head>
  <body>
    <a class="skip" href="#document-content">Skip to document</a>
    <header class="topbar">
      <a class="brand" href="/" aria-label="RoamCode home">RoamCode</a>
      <nav aria-label="Utility">
        <a href="/security" ${path === "/security" ? 'aria-current="page"' : ""}>Security</a>
        <a href="/contact" ${path === "/contact" ? 'aria-current="page"' : ""}>Contact</a>
        <a class="app-link" href="/app">Open app</a>
      </nav>
    </header>
    <main id="document-content" tabindex="-1">
      <aside>
        <span>Legal documents</span>
        <nav aria-label="Legal documents">
          ${legalNavigation.map(([href, label]) => `<a href="${href}" ${path === href ? 'aria-current="page"' : ""}>${label}</a>`).join("")}
        </nav>
      </aside>
      <article>
        <header class="document-head">
          <span>${document.eyebrow}</span>
          <h1>${document.title}</h1>
          <p>${document.summary}</p>
          <dl>
            <div><dt>Version</dt><dd>${document.version}</dd></div>
            <div><dt>Effective</dt><dd>${document.effectiveDate}</dd></div>
          </dl>
        </header>
        ${document.provisional ? `<div class="provisional" role="note"><strong>Preview status</strong><p>${document.provisional}</p></div>` : ""}
        ${document.source ? renderCanonicalMarkdown(document.source) : document.sections.map(renderSection).join("")}
        <footer class="document-footer">
          <p>RoamCode’s public software remains available under the <a href="/source/license">MIT License</a>.</p>
          <nav aria-label="Document footer"><a href="/legal/privacy">Privacy</a><a href="/security">Security</a><a href="/contact">Contact</a></nav>
        </footer>
      </article>
    </main>
  </body>
</html>`;
}

export function mountPublicDocument(pathname: string): boolean {
  const html = renderPublicDocument(pathname);
  if (!html) return false;
  const next = new DOMParser().parseFromString(html, "text/html");
  document.documentElement.lang = next.documentElement.lang;
  document.head.replaceChildren(...Array.from(next.head.childNodes, (node) => document.importNode(node, true)));
  document.body.replaceChildren(...Array.from(next.body.childNodes, (node) => document.importNode(node, true)));
  return true;
}

const publicDocumentCss = `
:root { color-scheme: dark; background: #07070a; color: #f3f2f7; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html { background: #07070a; }
body { min-width: 320px; min-height: 100vh; margin: 0; background: radial-gradient(circle at 10% -10%, rgba(128,111,255,.12), transparent 32rem), #07070a; font-size: 16px; line-height: 1.7; }
a { color: #bcb3ff; text-underline-offset: 3px; }
a:hover { color: #f3f2f7; }
:focus-visible { outline: 2px solid #9d90ff; outline-offset: 3px; border-radius: 6px; }
.skip { position: fixed; top: 10px; left: 10px; z-index: 10; padding: 9px 13px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; background: #14141a; color: #fff; transform: translateY(-160%); }
.skip:focus { transform: translateY(0); }
.topbar { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px clamp(18px, 4vw, 56px); border-bottom: 1px solid rgba(255,255,255,.1); background: rgba(7,7,10,.86); }
.brand { color: #fff; font-weight: 800; letter-spacing: -.03em; text-decoration: none; }
.topbar nav { display: flex; align-items: center; gap: 8px; }
.topbar nav a { min-height: 42px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 9px; color: #aaa8b5; text-decoration: none; }
.topbar nav a:hover, .topbar nav a[aria-current="page"] { background: rgba(255,255,255,.055); color: #fff; }
.topbar nav .app-link { border: 1px solid rgba(255,132,82,.42); color: #ffd1bd; }
main { width: min(1180px, calc(100% - 36px)); display: grid; grid-template-columns: 210px minmax(0, 760px); justify-content: center; gap: clamp(34px, 6vw, 88px); margin: 0 auto; padding: clamp(42px, 7vw, 90px) 0 90px; }
aside { position: sticky; top: 28px; align-self: start; display: grid; gap: 12px; }
aside > span { color: #6e6b7a; font-size: 11px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
aside nav { display: grid; gap: 3px; }
aside a { min-height: 40px; display: flex; align-items: center; padding: 0 11px; border-radius: 8px; color: #aaa8b5; font-size: 14px; text-decoration: none; }
aside a:hover, aside a[aria-current="page"] { background: rgba(255,255,255,.05); color: #fff; }
article { min-width: 0; }
.document-head { padding-bottom: 34px; border-bottom: 1px solid rgba(255,255,255,.11); }
.document-head > span { color: #ff9569; font-size: 12px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
h1 { max-width: 720px; margin: 12px 0 16px; font-size: clamp(34px, 6vw, 62px); line-height: 1.05; letter-spacing: -.055em; }
.document-head > p { max-width: 690px; margin: 0; color: #bbb9c4; font-size: 18px; }
dl { display: flex; flex-wrap: wrap; gap: 24px; margin: 28px 0 0; }
dl div { display: grid; gap: 2px; }
dt { color: #6e6b7a; font-size: 10px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
dd { margin: 0; color: #d8d6df; font-size: 13px; }
.provisional { margin: 28px 0 10px; padding: 18px 20px; border: 1px solid rgba(239,188,103,.28); border-radius: 12px; background: rgba(55,39,17,.38); }
.provisional strong { color: #f4cf91; }
.provisional p { margin: 4px 0 0; color: #d8c5a6; }
.rc-document-section { padding: 34px 0; border-bottom: 1px solid rgba(255,255,255,.09); }
h2 { margin: 0 0 15px; font-size: clamp(21px, 3vw, 28px); line-height: 1.2; letter-spacing: -.025em; }
.rc-document-section p { margin: 0 0 14px; color: #c1bfc8; }
.rc-document-section p:last-child { margin-bottom: 0; }
.rc-document-section ul { display: grid; gap: 11px; margin: 0; padding-left: 23px; color: #c1bfc8; }
.rc-document-section li::marker { color: #ff8452; }
.document-footer { display: flex; justify-content: space-between; gap: 24px; padding-top: 34px; color: #85828f; font-size: 13px; }
.document-footer p { margin: 0; }
.document-footer nav { display: flex; gap: 14px; }
@media (max-width: 760px) {
  .topbar { align-items: flex-start; }
  .topbar nav { flex-wrap: wrap; justify-content: flex-end; }
  .topbar nav a { padding: 0 8px; }
  main { grid-template-columns: 1fr; padding-top: 30px; }
  aside { position: static; overflow-x: auto; padding-bottom: 8px; }
  aside nav { display: flex; width: max-content; }
  aside a { border: 1px solid rgba(255,255,255,.09); }
  .document-footer { flex-direction: column; }
}
@media (max-width: 480px) {
  .topbar nav a:not(.app-link) { display: none; }
  .document-head > p { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`;
