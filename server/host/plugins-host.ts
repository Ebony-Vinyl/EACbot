import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "../routes/table.ts";
import { createPluginRoutes } from "../routes/plugins.ts";
import { createPlatformRoutes, type PlatformRouteBots } from "../routes/platforms.ts";
import { createDeviceRoutes } from "../routes/devices.ts";
import { createBoardRoutes } from "../routes/boards.ts";
import { PluginInstallStore } from "../plugins/store.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { StdioPluginSupervisor } from "../plugins/supervisor.ts";
import { PluginChannelStore } from "../plugins/channel-store.ts";
import { PluginMarketService } from "../plugins/market.ts";
import { EAC_COMMUNITY_CHANNEL } from "../plugins/default-channel.ts";
import { PlatformAccountStore } from "../plugins/platform-accounts.ts";
import { PlatformOutboxStore } from "../plugins/platform-outbox.ts";
import type { PlatformInboundHost } from "./platform-inbound.ts";
import { MemorySpaceStore } from "../memory-spaces/store.ts";
import { DeviceRegistry } from "../plugins/device-registry.ts";
import type { TaskRuntime } from "../tasks/runtime.ts";
import { KanbanStore } from "../plugins/kanban.ts";
import { createPluginConfigHost } from "../plugins/config-host.ts";
import { createPluginUiRoutes } from "../routes/plugin-ui.ts";
import type { PluginGrantTarget } from "../../shared/plugins/permissions.ts";

export interface PluginsHostOptions {
  dataDir: string;
  hostVersion: string;
  host: "server" | "desktop" | "web";
  platform: string;
  mayManage(auth: RequestAuth): boolean;
  enableProcessRuntime?: boolean;
  bots: PlatformRouteBots;
  /** When present, POST /api/platforms/inbound starts turns; the outbox holds the replies for their bridge. */
  inbound?: PlatformInboundHost;
  outbox?: PlatformOutboxStore;
  /** The account store, when the caller shares it with the inbound host. */
  accounts?: PlatformAccountStore;
  memory?: MemorySpaceStore;
  generatePanel?(botId: string, prompt: string): Promise<string | null>;
  grantTargets?(): PluginGrantTarget[];
  tasks?: TaskRuntime;
}

/** The composed plugin registry, its HTTP surface, and the account store the inbound host shares. */
export interface PluginsHost {
  route: RouteHandler;
  registry: PluginRegistry;
  accounts: PlatformAccountStore;
}

/** Composition for the plugin registry and its HTTP surface; server/index.ts only mounts the returned route. */
export function createPluginsHost(options: PluginsHostOptions): PluginsHost {
  const runtime = options.enableProcessRuntime
    ? new StdioPluginSupervisor({ dataDir: options.dataDir, onExit: (installationId, reason) => created.markRuntimeFailure(installationId, reason) })
    : undefined;
  const created = new PluginRegistry(new PluginInstallStore(options.dataDir), {
    hostVersion: options.hostVersion,
    host: options.host,
    platform: options.platform,
    ...(runtime ? { runtime } : {}),
  });
  const registry = created;
  void created.reconcile().catch(() => console.warn("plugin runtime: reconciliation failed"));
  const channels = new PluginChannelStore(options.dataDir);
  channels.ensureDefault(EAC_COMMUNITY_CHANNEL);
  const market = new PluginMarketService({
    dataDir: options.dataDir,
    registry: created,
    channels,
    platform: options.platform,
  });
  const pluginConfig = createPluginConfigHost({
    dataDir: options.dataDir,
    ...(runtime?.call ? { call: (installationId, method, params, timeoutMs) => runtime.call!(installationId, method, params, timeoutMs) } : {}),
    ...(runtime?.isRunning ? { isRunning: (installationId) => runtime.isRunning!(installationId) } : {}),
  });
  const plugins = createPluginRoutes({ registry: created, channels, market, mayManage: options.mayManage, botExists: (botId) => options.bots.has(botId), config: pluginConfig, grantTargets: options.grantTargets });
  const ui = createPluginUiRoutes({ registry: created, dataDir: options.dataDir, mayManage: options.mayManage, generate: options.generatePanel });
  const platformAccounts = options.accounts ?? new PlatformAccountStore(options.dataDir);
  const platforms = createPlatformRoutes({
    accounts: platformAccounts,
    memory: options.memory ?? new MemorySpaceStore(options.dataDir),
    bots: options.bots,
    mayManage: options.mayManage,
    ...(options.inbound ? { inbound: options.inbound } : {}),
    ...(options.outbox ? { outbox: options.outbox } : {}),
  });
  const devices = createDeviceRoutes({
    devices: new DeviceRegistry(options.dataDir),
    mayManage: options.mayManage,
  });
  const boards = createBoardRoutes({
    boards: options.tasks?.boards ?? new KanbanStore(options.dataDir),
    execution: options.tasks,
    accountForBot: (botId) => options.bots.bindingOf(botId)?.accountId,
    mayManage: options.mayManage,
  });
  return {
    route: async (context) => {
      const uiAnswer = await ui(context);
      if (uiAnswer !== PASS) return uiAnswer;
      const answered = await plugins(context);
      if (answered !== PASS) return answered;
      const platformAnswer = await platforms(context);
      if (platformAnswer !== PASS) return platformAnswer;
      const deviceAnswer = await devices(context);
      if (deviceAnswer !== PASS) return deviceAnswer;
      return boards(context);
    },
    registry,
    accounts: platformAccounts,
  };
}
