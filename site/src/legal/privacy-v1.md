# RoamCode Cloud Privacy Notice

Effective: 17 July 2026 · Version 1.0

This notice explains how the hosted RoamCode public preview handles personal information.

## Information processed

- Account data: name, email address, profile image, authentication provider identifiers, and session security metadata.
- Organization data: organization names, membership, invitations, roles, explicit access grants, and access requests.
- Host control metadata: host and workspace labels, agent version, connection state, credential version, and last-seen times.
- Security and audit data: administrative actions, tamper-evident audit entries, rate-limit counters, and narrowly scoped request logs.
- Allowlisted product events: event names and constrained operational properties such as client version, platform, connection kind, surface, and coarse latency bucket.

RoamCode is designed so that terminal streams and file contents pass between authorized endpoints in encrypted form and are not required by the control plane. Do not send secrets in organization names, host labels, access-request reasons, or support messages.

## Purposes and legal bases

Information is processed to provide and secure the service, authenticate users and devices, enforce organization permissions, deliver transactional email, investigate abuse, comply with law, and understand reliability through privacy-limited events. Depending on location and context, processing relies on performance of a contract, legitimate interests in operating a secure service, consent where required, and legal obligations.

## Sharing and subprocessors

Information is shared only with infrastructure, database, email-delivery, security, and support providers needed to operate the service; with an organization’s authorized administrators; when required by law; or in a corporate transaction subject to appropriate safeguards. RoamCode does not sell personal information or use customer source code for advertising.

Current subprocessors and processing locations are published at https://roamcode.ai/legal/subprocessors. Cross-border transfers use legally recognized safeguards where required.

## Retention

Free-plan audit records are retained for thirty days unless a security or legal need requires longer retention. Device authorizations expire within minutes. Access and refresh tokens expire or are revoked. Transactional email records are retained only for delivery and abuse prevention. Account and organization records remain while the account or organization is active and are deleted or de-identified after a reasonable recovery and compliance period.

## Security

RoamCode uses issuer-pinned federated sign-in, hashed opaque credentials, HttpOnly session cookies, least-privilege access grants, rate limiting, structured log redaction, encrypted transport, isolated backups, and a hash-chained audit log. No system can guarantee absolute security; suspected incidents should be reported through https://roamcode.ai/security.

## Choices and rights

You can review account and organization information in the product, revoke devices and credentials, leave organizations, and request access, correction, deletion, portability, or objection where applicable. Requests may be submitted through https://roamcode.ai/contact. Identity verification may be required.

## Changes

Material changes are published as a new document version. Where required, RoamCode will request renewed acceptance before continued use.
