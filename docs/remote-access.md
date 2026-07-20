# Remote access

RoamCode binds to `127.0.0.1:4280` by default. That is the safe starting point: only the Node itself can reach the
service. To use a phone or another computer, add a network path you control and keep the RoamCode process on loopback
whenever the chosen tool can proxy to it.

## Choose a route

| Route | Best for | Pairing origin |
| --- | --- | --- |
| Private network or mesh VPN | Your own devices on a trusted private network | The stable HTTPS name provided by that network |
| SSH local forwarding | Temporary access from one computer | `http://127.0.0.1:<forwarded-port>` on that computer |
| HTTPS reverse proxy | A stable browser/PWA origin you operate | Your exact `https://…` origin |

The route is infrastructure you operate; RoamCode does not provide a hosted relay or account service.

## Required properties

For access outside localhost:

- Use HTTPS. Installed PWAs, Web Push, and browser credential safety depend on a secure origin.
- Proxy WebSocket upgrades as well as ordinary HTTP requests.
- Preserve one stable public origin; set `ROAMCODE_PUBLIC_URL` to that origin.
- Keep the upstream on loopback where possible.
- Do not add the host recovery token to a URL, proxy configuration, or access log.
- Do not publish port 4280 directly to the internet.

Example service configuration:

```bash
ROAMCODE_PUBLIC_URL=https://code.example
```

After the route is working, issue a one-use link for the same origin:

```bash
roamcode pair --url https://code.example
```

The URL must be an origin only: no path, query string, fragment, username, or password.

## SSH forwarding

From a second computer, forward a local port to the Node's loopback listener:

```bash
ssh -N -L 4280:127.0.0.1:4280 your-node
```

Then open `http://127.0.0.1:4280` on the second computer and use a pairing link created with `roamcode pair`. SSH
forwarding is useful for temporary desktop access, but it is not a stable phone/PWA route.

## Reverse-proxy checklist

Before pairing a device, verify both requests:

```bash
curl -fsS https://code.example/health
curl -is https://code.example/ | head -1
```

The health endpoint should succeed and the root should return `HTTP/2 200` or `HTTP/1.1 200`. Then open the pairing
link in the intended browser.

If ordinary pages load but a terminal repeatedly reconnects, the proxy is usually missing WebSocket upgrade support
or its idle timeout is too short. See [troubleshooting](troubleshooting.md) before changing the RoamCode service.

## Revoke access

Every browser has an independent device credential. Revoke a lost or retired browser from **Settings → Devices**.
If you believe the host recovery credential was exposed, use the explicit offline recovery flow documented by
`roamcode reset-access --help`; it revokes every paired device.

Read the complete [security policy and threat boundary](../SECURITY.md) before operating a publicly reachable origin.
