# dsh-ship

[中文](README.zh.md) | English

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-ship"><img src="https://img.shields.io/npm/v/dsh-ship" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node >= 20">
  <img src="https://img.shields.io/badge/dsh-0.2.x-4D6BFE" alt="dsh 0.2.x">
  <img src="https://img.shields.io/npm/l/dsh-ship" alt="MIT">
</p>

**Publishing plugin for DeepSeek Harness**: ship **pure-static web apps** built in your sessions to **your own VPS + domain** — Caddy auto-HTTPS, atomic releases, instant rollback, config hot-reload. External users just open your URL in a browser; the server keeps **no resident component** (every deploy is an idempotent SSH operation).

> Phase 1 involves no model API / agent backend. Building is done by you (or the agent) — the plugin only takes a built dist directory and ships it safely.

## Tools (in-session)

| Tool | Purpose | Gate |
|---|---|---|
| `ship_targets` | List targets (secret-free view) with live version/health | free |
| `ship_publish` | Publish/update: upload → atomic switch → health check (auto-rollback on failure) → GC; first run provisions Caddy, site config, DNS check, HTTPS | **ask** |
| `ship_status` | Current version, releases, cert expiry, disk usage | free |
| `ship_rollback` | Roll back to previous or explicit version (atomic, instant) | **ask** |
| `ship_config_get` / `ship_config_set` | Runtime `config.json` read / hot-update (no redeploy) | set **ask** |
| `ship_logs` | Tail the server's Caddy logs | free |

Credentials never enter the conversation: tools only take `targetId`; targets are added via the Web bridge.

## Add a publish target

A target = one server (SSH) + one domain. Current release (M1; UI panel ships in M3) via the Web bridge:

```sh
curl -X POST http://127.0.0.1:<port>/api/dsh-ship -H 'content-type: application/json' -d '{
  "method": "targets.add",
  "args": {
    "host": "vps.example.com", "port": 22, "username": "root",
    "auth": "key", "privateKeyPath": "~/.ssh/id_ed25519",
    "domain": "notes.example.com", "spa": true
  }
}'
```

Or edit `~/.dsh/dsh-ship-targets.json` directly; no restart needed.

**Prerequisites**: an Ubuntu/Debian VPS (root login recommended) + a domain resolving to it (DNS is hard-checked; provisioning aborts with guidance otherwise) + ports 80/443 free of other web servers (occupied ports abort instead of silently migrating).

## Remote layout (design doc §5)

```
/srv/dsh-ship/sites/<targetId>/
  releases/<YYYYMMDDHHmmss>/   # immutable releases
    config.json -> ../shared/config.json
  current -> releases/<latest>  # atomically switched symlink; Caddy root
  shared/config.json             # runtime config (hot-reload, survives deploys)
```

## Config (cordis patch / plugin config; not exposed in UI)

| Field | Default | Meaning |
|---|---|---|
| `statePath` | `~/.dsh/dsh-ship-targets.json` | Targets + deployment history |
| `remoteRoot` | `/srv/dsh-ship` | Remote root directory |
| `maxVersions` | `5` | Releases kept by GC |
| `autoRollback` | `true` | Roll back on failed health check |

## Development

```sh
npm i            # ssh2 (lazy-loaded; unit tests don't need it)
npm test         # node --test tests/: core units + engine mock integration (25 cases, no real server)
npm run check    # syntax check
```

Layout mirrors dsh-local-llm: `core.js` (pure shell templates/parsers/validators, keyless-testable), `ssh.js` (ssh2 pool), `host-service.js` (Registry + DeployEngine + `/api/dsh-ship` bridge), `index.js` (tools + approval gate + mounting). Design and decisions: `docs/DESIGN.md`.

## Security notes

- SSH credentials are stored in plain JSON at `~/.dsh/dsh-ship-targets.json` (same tradeoff as dsh-ssh); a credentials-service integration is planned. Keep your local account secure.
- Host-key checking is off by default (matching dsh-ssh); `knownHosts` field reserved, UI support lands in M3.
- `ship_publish` / `ship_rollback` / `ship_config_set` go through the DSH approval surface; read-only tools are ungated.

## License

MIT

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
