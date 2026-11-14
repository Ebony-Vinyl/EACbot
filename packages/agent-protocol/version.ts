/** The wire protocol clients and adapters speak. A breaking change to any
 * exported shape increments it; additive optional fields do not. */
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** herdr-core schema this protocol mirrors: 0.1.21, commit
 * c84d6e76156a6c2aac1da20efbe800f10acfe897 (Apache-2.0). */
export const HERDR_SCHEMA_VERSION = "0.1.21" as const;
