# nullroom-cli

[![Test](https://github.com/nullroomio/nullroom-cli/actions/workflows/test.yml/badge.svg)](https://github.com/nullroomio/nullroom-cli/actions/workflows/test.yml)

Post-quantum encrypted P2P communication from the terminal. CLI client for [nullroom.io](https://nullroom.io).

Fully interoperable with the web app — a CLI user can connect to a browser user and vice versa.

> **Note:** This is an early version, built largely with the help of AI tools. Expect rough edges, bugs, and missing features. Bug reports and patience are equally appreciated.

## Features

Same cryptographic protocol as the [nullroom.io web app](https://github.com/nullroomio/nullroom):

- **End-to-end encrypted** — AES-GCM-256 + ML-KEM-768 (post-quantum) hybrid key
- **P2P-first transport** — direct WebRTC when available, encrypted Coturn relay fallback (`turns:` on 443/TCP) when NAT/firewall constraints require it
- **Single binary** — compiles to a standalone executable via `bun build --compile`
- **Agent-friendly** — `--json` flag on all commands for machine-readable output

## Commands

```
nr create              Create a secure room, output a 4-word code
nr join <code>         Join a room via phrase or nr:// connection string
nr send <file>         Encrypted file transfer (up to 16 MB)
nr receive <code>      Receive a file
echo "data" | nr pipe  Pipe stdin/stdout through an encrypted tunnel
```

## Install

```bash
bun install
bun run build    # produces ./nr binary
```

## Dev

```bash
bun run src/index.ts create
bun run typecheck
bun test
```
