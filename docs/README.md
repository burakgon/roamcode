# RoamCode documentation

RoamCode is a standalone control plane for persistent terminals and the coding agents you run inside them on a
machine you own. Start with the path that matches what you are trying to do.

## First run

- [Getting started](getting-started.md) — install, pair a browser, start a Session, and verify the service.
- [Terminal Sessions](terminal-sessions.md) — shell-first lifecycle, agent detection, and explicit integrations.
- [Remote access](remote-access.md) — connect a phone or another computer through a network path you control.
- [Windows through WSL2](windows-wsl.md) — run RoamCode in Linux and reach it from Windows.

## Operate a Node

- [Configuration](configuration.md) — ports, bind addresses, public origin, storage, terminal, providers, and API use.
- [Troubleshooting](troubleshooting.md) — service, provider, pairing, terminal, connectivity, and update diagnostics.
- [Service notes](service/README.md) — launchd and `systemd --user` behavior.
- [Stable releases](releases.md) — version identity, npm/Homebrew publication, OTA, and rollback.

## Product model

- [Product model](product-model.md) — Sessions, runtime observation, and the personal Node boundary.

## Security first

RoamCode grants a paired browser the ability to drive coding agents that run as your host user. Keep the server on
loopback unless you have deliberately secured the network boundary, use HTTPS for browser access outside localhost,
and treat every paired device credential like an SSH key. Read [SECURITY.md](../SECURITY.md) before exposing a Node.
