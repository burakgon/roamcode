# RoamCode Relay Protocol v1

Status: implementation contract for review. The hosted service must not be declared production-ready until an
independent cryptography and abuse-resistance review has accepted this document and the exact implementation.

## Product and trust boundary

The relay is optional. Direct HTTPS remains preferred, and a local-only RoamCode host continues to provide the full
single-host product without a RoamCode account. A self-hosted relay and RoamCode Cloud run the same wire protocol.

The relay may learn only the minimum routing and abuse-control metadata:

- relay route id, opaque device id, connection id, frame length, time, and aggregate rate-limit counters;
- whether a route is online and when a connection opens or closes;
- protocol version and unencrypted handshake public material.

The relay must never receive plaintext API bodies, terminal input/output, prompts, source code, filesystem paths,
provider credentials, the host access credential, or end-to-end identity private keys. Relay routing credentials are
independent, revocable capabilities and are not provider or host credentials. Payloads are not persisted. Operational
logs exclude routing credentials, ciphertext bodies, query strings, IP addresses by default, and application content.

## Cryptographic profile

Version 1 uses primitives available in the W3C Web Cryptography API and Node.js 24 without shipping a second
cryptographic implementation into the browser:

- long-term identity signatures: ECDSA P-256 with SHA-256;
- per-connection ephemeral agreement: ECDH P-256;
- key schedule: HKDF-SHA-256;
- traffic protection: AES-256-GCM with a 96-bit nonce and 128-bit tag;
- hashes and fingerprints: SHA-256.

The profile follows the separation, context binding, directional-key, sequence, nonce, and AAD principles specified
by [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869),
[RFC 9180](https://www.rfc-editor.org/rfc/rfc9180), and the
[W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/). It is not advertised as HPKE or TLS and must not use
either protocol name on the wire.

## Identity and pairing

Each host owns a non-exported or mode-`0600` identity private key. Each relay-capable device generates its identity
key locally; browser private keys are stored as non-extractable `CryptoKey` objects in IndexedDB. Pairing transfers
only the public SPKI key and its SHA-256 fingerprint over the already-authenticated direct pairing channel. The host
stores the device public key beside the independently revocable device record.

Relay cannot be enabled for a legacy device with no pinned public key. Re-pairing or an explicit authenticated key
upgrade is required. Rotating a long-term identity invalidates the former fingerprint and requires the same explicit
trust ceremony. Revoking a device removes its relay routing capability and closes active channels immediately.
Removing that relay host from a browser also deletes its local non-extractable identity. Cancelled or expired
first-device attempts delete their provisional identities, and a bounded startup hygiene pass prunes abandoned keys
only after the pairing window while protecting keys referenced by saved or in-flight relay hosts.
Cancelling a displayed pairing link is an authenticated revocation, not a visual-only dismissal. Direct pairing
removes the one-use capability immediately. Relay pairing first confirms broker bootstrap revocation, then removes the
local ticket; if a device finishes enrollment during that race, cancellation reports the conflict so the user can
review and explicitly revoke the newly paired device.

An outbound-only first-device link carries an expiry-bounded broker bootstrap in its URL fragment. The browser
removes that fragment from history before parsing it, creates a distinct durable routing capability locally, and
sends the durable value only inside the encrypted device claim. The host commits only its hash to the broker. To make
a lost final response retryable, the broker accepts the original bootstrap hash alongside the durable hash only until
the link's original deadline; it never promotes that bootstrap value into the permanent credential slot.

## Authenticated ephemeral handshake

Every connection generates a fresh ECDH key pair and 32-byte random nonce. The device chooses a random 128-bit
session id. Each side signs a length-bounded, domain-separated transcript containing:

1. protocol label and version;
2. role (`device` or `host`);
3. route id, device id, and session id;
4. issue time;
5. random nonce;
6. ephemeral public SPKI key;
7. pinned identity-key fingerprint.

The receiver rejects unknown versions, invalid encodings, unexpected roles/identities, fingerprints that do not match
the paired record, signatures that do not verify, and clocks outside the five-minute handshake window. The relay can
forward these public messages but cannot replace an ephemeral key without breaking the signature.

After both hellos verify, each endpoint computes ECDH and derives exactly 88 bytes with HKDF-SHA-256. The salt is the
SHA-256 hash of the ordered device and host signed transcripts. The `info` value binds the protocol label, route id,
device id, and session id. Output is split into independent device-to-host and host-to-device 256-bit keys and 96-bit
base nonces. A role never uses its send key to receive.

Fresh ephemeral keys provide forward secrecy for a completed channel if long-term signing keys are compromised later.
They do not recover confidentiality if an endpoint itself is compromised while plaintext is in memory.

## Encrypted frames and ordering

Each direction starts at sequence zero. The nonce is its base nonce XOR the unsigned 64-bit big-endian sequence value,
left padded to 96 bits. A sender must never reuse a sequence with one key and must fail before overflow. A receiver
accepts exactly its next expected sequence: duplicate, skipped, reordered, wrong-session, or wrong-direction frames
fail closed. WebSocket ordering is the transport contract; reconnect creates a new handshake and sequence space.

Authenticated additional data binds the protocol version, session id, direction, sequence, and frame kind. Frame kinds
are allow-listed (`auth`, RPC request/response, stream open/data/control, close). Ciphertext includes the 128-bit GCM
tag. A failed authentication does not advance receive state. Plaintext and ciphertext sizes are bounded before
allocation.

Contexts rotate after 30 minutes or one million sent/received frames, whichever comes first. Rotation is a fresh
authenticated ephemeral handshake; it never carries an old traffic key forward. API mutations survive reconnect only
through their existing actor-scoped idempotency keys. Terminal ownership survives only if the host's current
proof-bound lease is still valid; reconnect alone never grants or steals input.

## Blind relay transport

Hosts make outbound-only WebSocket connections. A route has one active host connection and bounded device channels.
The broker authenticates a host routing capability and per-device routing capabilities using stored SHA-256 hashes.
Credentials are sent only in the first WebSocket message, never in a URL. They authenticate routing, not payloads.

After authentication the broker forwards opaque ciphertext envelopes by random channel id. It enforces maximum frame
size, connection count, handshake deadline, idle timeout, and byte/message rate limits without inspecting content. A
new host connection supersedes the stale one; device reconnect uses a new channel and E2E handshake. Broker restart
loses live channels but not route/revocation state.

## RPC and terminal tunnel

The first encrypted device frame authenticates its paired device credential to the host. The host validates it with
relay scope and binds all subsequent requests to that device identity. Relay traffic then enters the same server-side
authorization, revision, idempotency, input-lease, audit, and redaction paths as direct UI/CLI/API traffic.

RPC requests contain a bounded request id, method, relative path, a small allow-list of semantic headers, and an
optional byte body. Responses contain status, allow-listed response headers, and bounded bytes. Neither side forwards
cookies, proxy headers, arbitrary origins, hop-by-hop headers, or absolute URLs. Terminal streams use separate bounded
stream frames and the same one-writer/many-observer lease rules as direct WebSockets.

Large multipart uploads and file/media responses use an HTTP stream subtype instead of RPC buffering. The host opens
the request against its loopback server with a process-local relay capability, so the exact normal authentication,
team authorization, rate-limit, idempotency, audit, multipart, and route hooks remain authoritative. Device and host
credentials never enter the request URL.

Each direction has an explicit 512 KiB credit window and 64 KiB maximum plaintext chunk. A sender cannot transmit a
chunk without credit; the receiver replenishes upload credit only after the loopback write drains and replenishes
download credit only as the browser's `ReadableStream` gains capacity. This bounds queued plaintext independently of
WebSocket buffering. Request size, idle time, frame size, declared response length, final byte count, and cancellation
are enforced. AES-GCM authentication and strict frame sequencing protect every chunk and make truncation explicit.
Range responses and file entity tags let a caller retry an interrupted download from a known offset; an interrupted
multipart upload is atomically discarded and retried from the original browser `File`. Seamless in-flight reconnect
remains a separate product contract and must not be claimed merely because range retry is available.

## Required failure tests

- official HKDF vector, cross-runtime Node/browser vector, and independent directional key agreement;
- wrong pinned key, altered hello, stale hello, replayed hello, and identity/role reflection;
- ciphertext/tag/AAD modification, duplicate/skip/reorder, sequence overflow, and wrong-session frame;
- reconnect and scheduled rotation produce unrelated traffic keys and reset sequence only after authentication;
- relay sees no plaintext marker even when every forwarded/logged byte is captured;
- device revocation, role loss, host replacement, broker restart, idle timeout, and route deletion close access;
- offline/reconnect mutation retries keep idempotency semantics and never duplicate terminal input;
- multi-megabyte upload/download, slow-consumer backpressure, cancellation, early HTTP failure, byte-count mismatch,
  range retry, and interrupted-upload atomicity;
- bounded memory, frames, queues, connections, logs, and rate counters under an unauthenticated or compromised relay.
