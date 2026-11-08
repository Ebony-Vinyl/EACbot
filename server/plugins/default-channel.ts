import type { PluginChannelInput } from "./channel-store.ts";

/** Trust root for the reviewed EACbot community catalog; the private key is never in this repository. */
export const EAC_COMMUNITY_CHANNEL: PluginChannelInput & { trust: "reviewed" } = {
  sourceId: "eac-community",
  name: "EAC Community",
  url: "https://raw.githubusercontent.com/Ebony-Vinyl/eacbot-extensions/main/catalog/catalog.json",
  keyId: "eac-community-v1",
  trust: "reviewed",
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAfF+68kz6NL6i45m3cKUl1Vg/mVeuj48TcI9LOXK15W4=
-----END PUBLIC KEY-----
`,
};
