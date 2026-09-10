# CLI v0.1

`unified-mcp` — thin commands only; the browser is the front door.

| command | purpose |
|---|---|
| `unified-mcp start --config <ABS_PATH>` | start the daemon; control plane on `127.0.0.1:7420`; prints URL + start token |
| `unified-mcp start --config <ABS_PATH> --embedded` | zero-setup: hosting + bridge + control plane in one process |
| `unified-mcp bridge --config <ABS_PATH>` | stdio bridge process — what clients spawn |
| `unified-mcp stop` | graceful stop of the running daemon |
| `unified-mcp status` | running? control plane URL? config version? session count? |

- `--config` must be **absolute**; the file is read once and never written (owner constraint).
- No `install`, `prune`, `ingest`, or `sync` commands in v0.1 — Future record ([`docs/FUTURE.md`](FUTURE.md)).
- Exit codes: `0` ok · `1` usage · `2` config invalid · `3` lock held · `4` link auth failure.

## Client config example (`.mcp.json`)

```json
{
  "mcpServers": {
    "unified": {
      "command": "/abs/path/unified-mcp",
      "args": ["bridge", "--config", "/abs/config.json"]
    }
  }
}
```

## Embedded mode

`--embedded` runs bridge + hosting + control plane in one process with the same modules (ARCHITECTURE) — the zero-setup path. It seeds `defaultAction: "allow"`; strict daemon mode seeds `"deny"`.
