# EACbot core development entry

`core/bootstrap/main.ts` starts the new server with an isolated `EAC_CORE_DATA_DIR`. The root remains the legacy application until the new product passes its full acceptance gates.

```sh
EAC_CORE_DATA_DIR=.zcode/core-data node --experimental-strip-types core/bootstrap/main.ts
```

The server binds loopback and prints a one-time pairing code to the local terminal. It uses fake agent adapters by default so a fresh process cannot invoke a model or a user's real computer. Environment and terminal ports are inert until their production adapters are explicitly composed.

The web workbench lives in `src/next/`, using the same `/api/v1` contract. The existing anime background, custom image store, rotation, ambient effects, and Live2D must remain intact. No Boat, paid cloud, hosted-computer sales, or provider advertising is part of the new product.

All agent and terminal behavior must be tested with fake native services first. Real tests use only explicitly allocated user-owned test environments and never the existing application or personal data.
