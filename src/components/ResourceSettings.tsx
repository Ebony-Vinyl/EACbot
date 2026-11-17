import { lazy, Suspense, useState, type ReactNode } from "react";
import { Bot, Files, Monitor, Terminal, Workflow } from "lucide-react";
import type { PlatformId } from "../../shared/plugins/accounts";
import { t } from "@/lib/i18n";
import { useAuth } from "@/next/foundation/api";
import { PairingGate } from "@/next/pages/PairingGate";

const Agents = lazy(async () => ({ default: (await import("@/next/settings/AgentSettings")).AgentSettings }));
const Computers = lazy(async () => ({ default: (await import("@/next/settings/CloudComputerSettings")).CloudComputerSettings }));
const Terminals = lazy(async () => ({ default: (await import("@/next/workbench/Workbench")).Workbench }));
const FileSettings = lazy(async () => ({ default: (await import("./FilesView")).FilesView }));
const Platforms = lazy(async () => ({ default: (await import("./platforms/PlatformCenter")).PlatformCenter }));
const PlatformDetails = lazy(async () => ({ default: (await import("./platforms/PlatformDashboard")).PlatformDashboard }));
const PlatformAccounts = lazy(async () => ({ default: (await import("./PlatformAccountsPanel")).PlatformAccountsPanel }));

const tabs = [
  { id: "agents", label: "sidebar.nav.agents", icon: Bot },
  { id: "computers", label: "sidebar.nav.computers", icon: Monitor },
  { id: "terminals", label: "sidebar.nav.terminals", icon: Terminal },
  { id: "files", label: "neutral.files", icon: Files },
  { id: "platforms", label: "neutral.platforms", icon: Workflow },
] as const;
type Resource = typeof tabs[number]["id"];

function CoreResource({ children }: { children: ReactNode }) {
  const auth = useAuth();
  if (auth.status === "paired") return children;
  return window.ogb?.taskCore
    ? <p role={auth.error ? "alert" : "status"} className="p-4 text-sm text-ink-secondary">{auth.error ?? "正在连接本机任务服务…"}</p>
    : <PairingGate />;
}

export function ResourceSettings() {
  const [selected, setSelected] = useState<Resource>("agents");
  const [platform, setPlatform] = useState<PlatformId | null>(null);
  const [accounts, setAccounts] = useState(false);
  return <div className="settings-resources" data-testid="settings-resource-navigation">
    <div className="settings-resource-tabs" role="tablist" aria-label={t("neutral.resources")}>
      {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab"
        id={`resource-tab-${id}`} aria-selected={selected === id} aria-controls="resource-panel"
        data-settings-resource={id} onClick={() => setSelected(id)}
      ><Icon size={15} /><span>{t(label)}</span></button>)}
    </div>
    <div className="settings-resource-panel" role="tabpanel" id="resource-panel" aria-labelledby={`resource-tab-${selected}`}>
      <Suspense fallback={<p role="status" className="p-4 text-sm text-ink-secondary">正在加载…</p>}>
        {selected === "agents" && <CoreResource><Agents /></CoreResource>}
        {selected === "computers" && <CoreResource><Computers /></CoreResource>}
        {selected === "terminals" && <CoreResource><Terminals /></CoreResource>}
        {selected === "files" && <FileSettings />}
        {selected === "platforms" && (accounts
          ? <PlatformAccounts embedded onClose={() => setAccounts(false)} />
          : platform ? <PlatformDetails platform={platform} onBack={() => setPlatform(null)} />
          : <Platforms onOpen={setPlatform} onConnect={() => setAccounts(true)} />)}
      </Suspense>
    </div>
  </div>;
}
