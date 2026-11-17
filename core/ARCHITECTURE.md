# EACbot core architecture

`core/` is the new, self-hosted server. It does not import `server/`, sell hosted computers, or migrate legacy data. The user's own SSH Linux computer is the only execution environment. Hermes is the personal agent; specialist agents run under herdr-core (`hc`) on that computer.

## Boundaries

- `packages/agent-protocol/`: versioned public wire contracts shared with clients and adapters.
- `core/missions/`: the only task authority. Terminal/OSC 7501 state never mutates missions.
- `core/agents/`: native agent transports, capabilities, install/model descriptors, and scoped orchestration tools.
- `core/environments/`: user-owned SSH environments and private environment agent; no provider-specific commercial integration.
- `core/terminal/`: herdr-core protocol and authenticated browser/Android streams.
- `core/http/`: composition-independent HTTP/SSE/WSS modules.

Node 24, strict erasable TypeScript with explicit `.ts` imports, `node:sqlite` WAL for durable state, no legacy `server/` imports. Secrets never enter URLs, terminal output, artifacts, or event logs. Protocol facts from herdr-core commit `c84d6e76156a6c2aac1da20efbe800f10acfe897`, schema version 0.1.21; retain its Apache-2.0 attribution before distributing binaries or adapting implementation code.

Every mutable operation accepts a caller command id and, where appropriate, an expected revision. Acceptance is durable before native execution. `interrupt` preserves a resumable native session; `cancel` terminates. `freeze` is not emulated with either. Agent native sessions and terminal IDs are distinct.

## Verification

Tests run only in temporary directories. They must not read `~/.eacbot`, real Hermes state, user SSH keys, or a running application. Native CLIs are exercised only in explicitly allocated test environments, with no claim that a fake proves a real provider or model.
