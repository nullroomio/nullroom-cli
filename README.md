# nullroom-cli

Post-quantum encrypted P2P communication from the terminal. CLI client for [nullroom.io](https://nullroom.io).

Fully interoperable with the web app — a CLI user can connect to a browser user and vice versa.

## Features

- **End-to-end encrypted** — AES-GCM-256 + ML-KEM-768 (post-quantum) hybrid key
- **True P2P** — WebRTC DataChannels, server only relays signaling
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
```

## Tech

- **Runtime:** Bun
- **WebRTC:** werift (pure TypeScript, no native deps)
- **PQC:** mlkem (ML-KEM-768 / FIPS 203)
- **Signaling:** ActionCable (WebSocket) to nullroom.io server
- **CLI:** Commander + @clack/prompts
