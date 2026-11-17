/**
 * herdr-core terminal layer: the protocol client EACbot uses to talk to `hc`
 * on the user's own computer.
 *
 * Protocol facts come from herdr-core commit
 * c84d6e76156a6c2aac1da20efbe800f10acfe897, schema version 0.1.21
 * (Apache-2.0; see `third_party/herdr-core/README.md`).
 */

export { AttachStream, type AttachEvents, type AttachOptions } from "./attach.ts";
export { HcClient, planFor, type HcClientEvents, type HcClientOptions } from "./client.ts";
export { HcConnection, type ConnectionMode, type ConnectionOptions, type FrameSink } from "./connection.ts";
export { ControlLease, type LeaseHolder, type LeaseOptions, type LeaseRole } from "./lease.ts";
export {
  LineDecoder,
  PROTOCOL_GENERATION,
  RpcError,
  RpcErrorCode,
  TransportError,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isRpcErrorKind,
  parseMessage,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type RpcErrorData,
  type RpcErrorKind,
} from "./protocol.ts";
export {
  TerminalRegistry,
  type ReconcileResult,
  type RegistryListener,
  type RegistrySnapshot,
} from "./registry.ts";
export {
  HC_PROGRAM,
  SPAWN_OPTIONS,
  assertHost,
  assertSecureSshArgs,
  defaultSpawner,
  describeSpawnPlan,
  localConnectPlan,
  parseSshTarget,
  remoteConnectLine,
  sshConfigFromTarget,
  sshConnectDescriptor,
  sshConnectPlan,
  type SpawnPlan,
  type SpawnedProcess,
  type Spawner,
  type SshConnectConfig,
  type SshConnectDescriptor,
} from "./transport.ts";
export type * from "./types.ts";
export {
  FrameDecoder,
  FrameError,
  FrameKind,
  FRAME_HEADER_BYTES,
  INITIAL_STREAM_CREDIT,
  MAX_FRAME_PAYLOAD,
  MAX_STREAM_CHUNK,
  creditPayload,
  decodeCloseReason,
  decodeFrameHeader,
  encodeCloseReason,
  encodeFrame,
  focusPayload,
  readCredit,
  readResize,
  resizePayload,
  type Frame,
  type FrameErrorCode,
  type FrameKindValue,
} from "./wire.ts";
