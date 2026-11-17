# herdr-core

Vendored attribution for [herdr-core](https://github.com/herdrdev/herdr-core)
("terminals for coding agents"), the terminal runtime EACbot's `core/terminal`
layer speaks to over `hc connect`.

- Upstream commit: `c84d6e76156a6c2aac1da20efbe800f10acfe897` (2026-11-14)
- Protocol generation: 1
- Schema version: 0.1.21
- License: Apache-2.0 — the full text is in [LICENSE](LICENSE), fetched with
  `gh api repos/herdrdev/herdr-core/contents/LICENSE?ref=<commit>`. Upstream
  ships no `NOTICE` file at this commit (the repository tree holds only
  `LICENSE`), so nothing beyond the license text is owed there.

Nothing in this directory is upstream code. EACbot's `core/terminal` is a
TypeScript client written against the published wire format; the facts it
encodes are documented at their definitions:

- `crates/herdr-core/src/wire.rs`: the frame layout
  (`[channel u32 LE][kind u8][len u32 LE][payload]`), the kind numbers, the
  16 MiB payload cap, the 256 KiB starting credit and the 4 MiB backlog that
  becomes a repaint.
- `crates/herdr-core/src/rpc.rs`: JSON-RPC envelopes and the stable
  `data.kind` error taxonomy.
- `crates/herdr-core/src/machines.rs`: `ssh <target> hc connect`, the target
  rules, and the remote `hc connect` lookup on `PATH` then `~/.local/bin`.
  EACbot hardens this path for a user-owned cloud computer it does not
  physically control: `StrictHostKeyChecking=yes` against a dedicated
  known-hosts file, `BatchMode=yes`, `IdentitiesOnly=yes` when a key is
  provisioned, and no `ProxyCommand`/`LocalCommand` surface. See
  `core/terminal/transport.ts`.
- `crates/herdr-core/src/attach.rs`: the attach stream, viewer input, CREDIT,
  RESIZE, FOCUS and FACTS.
- `schema/hc.openrpc.json`: every method, param and result, and the
  `hello`/attach capability fields (`automatic_input`,
  `resize_notifications`).
- `docs/api.md`: the two connection modes, the attach stream semantics, and
  the event and `missed` reconciliation rules.

Before distributing a binary that embeds herdr-core, or adapting its
implementation code, re-check this file and the root `NOTICE`.
