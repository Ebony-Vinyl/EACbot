# Announcements and the version-upgrade surface

The announcement module has two sources: this workspace's admins (Settings →
Announcements, `announcements.json` in the data directory) and one
operator-run JSON feed, `EAC_ANNOUNCEMENTS_URL`, that every installation
polls about every ten minutes. `/api/announcements` merges both (a local id
wins), applies each announcement's start/end window, and is readable by every
signed-in client; only an owner or administrator may create, edit, or remove
local announcements. The version-upgrade surface per client was already
mapped (desktop self-update, server update check, the Updates settings page);
this recipe covers the new announcement surface and the remote feed.

## Driving it

```sh
# Announcements against a fixture, with the operator feed:
EAC_ANNOUNCEMENTS_URL=https://announcements.example/eacbot.json \
  node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb doctor --url http://127.0.0.1:PORT

curl -s http://127.0.0.1:PORT/api/announcements            # [] to start
curl -s -X POST http://127.0.0.1:PORT/api/announcements \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"Body","level":"important"}'
curl -s http://127.0.0.1:PORT/api/announcements/manage     # the local list
curl -s -X PATCH http://127.0.0.1:PORT/api/announcements/ID \
  -H 'content-type: application/json' \
  -d '{"title":"Edited","startsAt":1730000000000,"endsAt":null}'
curl -s -X DELETE http://127.0.0.1:PORT/api/announcements/ID
```

A member session may `GET /api/announcements` but gets 403 on the mutations
(`request-auth.ts` lists only the GET under `CLIENT_ALLOW`).

## Recorded run (2026-11-08)

- Fixture `http://127.0.0.1:20681` and then `http://127.0.0.1:22431`
  (relaunched with `EAC_ANNOUNCEMENTS_URL` pointing at the operator's own
  announcement host): `doctor` reported no problems; loopback had the
  admin/client scopes.
- Announcement lifecycle over HTTP: create → GET (important sorted first) →
  patch with a start/end window → a future `startsAt` stayed hidden →
  DELETE; Chinese text survived storage and readback as UTF-8.
- Remote feed: with `EAC_ANNOUNCEMENTS_URL` set, `/api/announcements`
  returned the operator's announcement with `"source":"remote"`, merged
  after the local one.
- Plugin lifecycle over the same fixture: `POST /api/plugins/local` with an
  absolute package path → activate → tools list → grant for a real bot id →
  grants list → revoke → disable → delete; a grant naming a bot the
  workspace does not have was refused 422. `tools/call` answered 409
  `runtime-unavailable`: the fixture does not opt into `EAC_PLUGIN_PROCESS`,
  and the call path with a runtime is covered by
  `server/routes/plugins-grants.test.ts` (fake runtime) and
  `server/plugins/supervisor.test.ts` (real stdio subprocess).
- Bot run: `new-bot` → `send` → `wait` returned `settled`, `messages`
  carried the fake engine's reply, tool row and digest.

## What is not proven here

- The banner's rendered pixels (the strips are renderer-only; the harness
  drives the transcript, not the announcement strip).
- `EAC_PLUGIN_PROCESS=1` subprocess tool calls over the live fixture HTTP —
  the launcher does not cross that variable; unit tests cover it.
- The 92 pre-existing stale `zh.json` translations and the pre-existing
  `vocabulary.test.ts` EACbot-Cloud wording failures were already failing
  before this change and are not part of it.
