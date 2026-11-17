# Core configuration: `core.json`

`core/bootstrap/main.ts` starts the new server with an isolated
`EAC_CORE_DATA_DIR`. This document describes the configuration file that the
production composition reads from that directory, and what it does and does not
do.

```sh
EAC_CORE_DATA_DIR=.zcode/core-data node --experimental-strip-types core/bootstrap/main.ts
```

The file is `$EAC_CORE_DATA_DIR/core.json`. It is read once, at composition
time. A missing file or a missing directory is an empty configuration: no agent
is invented, no computer is assumed, and `/api/v1/agents` answers an empty list.
A file that exists but does not parse, or that does not match the schema below,
is an error that names the field; a corrupt file is never treated as absent.

The file holds which agent instances this core may run and which of the
person's own computers it knows. It never holds a session token, a pairing code
or a license key, and the server never writes one into it.

## Shape

```json
{
  "version": 1,
  "agents": [
    {
      "id": "hermes-main",
      "agentId": "hermes",
      "home": "/home/person/.eacbot/hermes",
      "authMode": "subscription",
      "baseUrl": "http://127.0.0.1:8642",
      "token": { "env": "HERMES_API_SERVER_KEY" }
    },
    {
      "id": "pi-work",
      "agentId": "pi",
      "home": "/home/person/.eacbot/pi-work",
      "authMode": "apiKey",
      "apiKey": { "name": "OPENAI_API_KEY", "value": { "env": "PI_WORK_KEY" } },
      "model": "openai/gpt-5",
      "env": { "LANG": "en_US.UTF-8" }
    }
  ],
  "environments": [
    {
      "id": "office-box",
      "label": "Office box",
      "kind": "ssh",
      "host": "box.example",
      "user": "person",
      "authMode": "subscription"
    }
  ]
}
```

Every field is checked, and an unknown field anywhere is refused. A mistyped
`"tokens"` that was silently dropped would leave a person believing their
credential reached the engine.

## Agent instances

One entry is one instance: one engine, one home, one auth mode, one model list.
Two entries of the same `agentId` are separate in all of those.

| Field | Meaning |
| --- | --- |
| `id` | Unique instance id. Task commands cannot name it; see below. |
| `agentId` | `hermes`, `claudeCode`, `codex`, `openCode`, `pi`, `ohMyPi` or `custom`. |
| `home` | Absolute path this instance's own home lives at. Two instances never share one. |
| `authMode` | `subscription`, `apiKey`, `compatibleEndpoint` or `local`. |
| `enabled` | Defaults to `true`. `false` keeps the entry in the file but neither serves tasks nor appears in `/api/v1/agents`. |
| `cli` | The executable, when it differs from the engine's own. Required for `custom`. |
| `baseUrl` | HTTP agents only (`hermes`, `openCode`). Required for them. |
| `token` | HTTP agents only. `hermes` requires it; its server refuses every run without one. |
| `apiKey` | `{ "name": <provider credential>, "value": <secret> }`, for `authMode: "apiKey"`. |
| `provider` | `{ "baseUrl": …, "apiKeyName"?: …, "apiKey"?: … }`, for `compatibleEndpoint` and `local`. |
| `env` | Extra names for the child process, from the agent environment allowlist only. |
| `model` | `"provider/model"` or `{ "providerId", "modelId", "variant"? }`. |
| `args` | A custom ACP agent's argv after `cli`. |

A credential belongs to exactly one auth mode. A `subscription` instance carries
no `apiKey` and no `provider`; an `apiKey` instance carries no `provider`; a
`local` endpoint carries no credential at all. Each of those is refused rather
than dropped, because the person asked for billing that cannot happen.

### Where a secret lives

`token`, `apiKey.value` and `provider.apiKey` accept either a literal string or
`{ "env": "NAME" }`. The named variable is read from the host environment at
composition time, so a file copied between machines need not carry a key. A name
that resolves to nothing is reported as `token is not set: environment variable
NAME is empty or missing`, and that instance is skipped; the rest of the
composition still builds.

A secret value never reaches a log line, an HTTP response or the missions
database. It is held by one instance's adapter, which uses it as a bearer on its
own HTTP requests — including the catalog probe — or as one allowlisted variable
in a child process.

### What crosses into a child process

Only the names in `ALLOWED_ENV_NAMES` (`core/agents/env.ts`): locale, terminal,
proxy, certificate and home locations. `env` may add names from that same list
and nothing else. Provider credentials are refused there — use `apiKey` or
`provider` — and control-plane secrets (`EACBOT_*`, `EAC_*`, `MAUSBOT_*`,
`OPENMAUSBOT_*`) are refused under every casing. `HOME` and the engine's own
home variable are set from `home`, so they cannot be overridden.

### Several instances of one agent

Several instances of one `agentId` are allowed, but a mission command names only
an agent kind (`"agent": "pi"`), so it cannot say which instance. The first
`enabled` entry of a kind serves every task of that kind, and its models are the
ones that kind reports. A second enabled entry is validated but not registered:
it is listed in `skipped` with that reason, and `onError` receives it. Reordering
the file is how a person changes which instance serves.

## Model catalogs

`GET /api/v1/agents/:kind/models` answers with the engine's own catalog, read by
`core/agents/catalog.ts`:

- `pi`, `ohMyPi` and `codex` are asked over their own RPC surface;
- `openCode` and `hermes` are asked over HTTP, with the instance's bearer;
- `claudeCode` and `custom` have no catalog surface and are reported as
  unknown rather than as an empty list.

A failed probe is an `unknown` reading carrying the reason (`the engine refused
get_available_models`, `spawn pi ENOENT`, `GET /api/model answered 401`), and
the route answers `reported: false` with no models. A fake model is never
substituted.

Readings are cached for five minutes. Concurrent readers share one in-flight
probe, so two browser tabs never launch two engines. `refreshCatalogs()` on the
composition re-reads every configured kind; a launcher calls it once after
building, before or alongside starting the server.

## Environments

`environments` is read into the environment port. An entry is a connection
fact: a label, a host, a user, and a credential handle (`credentialRef`), never
key material. A configured computer is not trusted on the strength of the file:
it starts with no connectivity test recorded, and `check` reports what a
transport actually observed. With no transport configured it answers
`reachable: false` with `no transport is configured for this environment`.

An `ssh` entry needs `host` and `user`; a `local` entry needs `baseUrl`; an
`apiKey` entry needs `credentialRef`. Cloud providers are not part of this file
or this composition.

## Permissions

`core.json` is written 0600 inside a 0700 directory. `saveCoreConfig` writes
through a temporary file and renames it into place, and it validates the
document before writing, so a file the loader would refuse is never produced. A
hand-written file that other users can read is narrowed to 0600 before its
contents are used, rather than refused: the credential in it is still the one
the person meant to use.

## What this composition does not do

`buildProductionComposition` is a factory. It reads the configuration, builds
one adapter per enabled instance, seeds the environment list and opens the
mission database. It opens no socket, spawns no engine and reads no real home
unless the caller passes those in: `spawn`, `fetch` and `hostEnv` are options,
so a test composes the same graph against a temporary directory and scripted
children. Starting the HTTP server is a separate call (`startServer`), and the
terminal ports stay inert until a terminal transport is composed.
