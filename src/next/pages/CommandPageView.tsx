/** The five command-centre pages, as the shell mounts them.
 *
 * Each one is a view of the same window: the rail, the background layer and the
 * skins are the app's own, and the page only fills the main pane. A page that
 * reads `/api/v1` needs the device's bearer, so every one of them renders
 * behind `PairingGate` — a device without a token would otherwise show a pane
 * of 401s instead of the one thing that fixes it. */

import { HerdrPage } from "../workbench/HerdrPage";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

import { useAuth } from "../foundation/api.ts";
import { PersonalAgentPage } from "../personal/PersonalAgentPage.tsx";
import { MissionCenter } from "../personal/MissionCenter.tsx";
import { CloudComputerSettings } from "../settings/CloudComputerSettings.tsx";
import { AgentSettings } from "../settings/AgentSettings.tsx";
import { Workbench as TerminalWorkbench } from "../workbench/Workbench.tsx";
import { PairingGate } from "./PairingGate.tsx";

export type CommandPage = "herdr" | "hermes" | "missions" | "computers" | "agents" | "terminals";

/** A page's frame: the app's pane colour, the scroll boundary, and the gate. */
function PageFrame({ testId, children }: { readonly testId: string; readonly children: ReactNode }): ReactNode {
  return (
    <main
      data-testid={testId}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app text-ink"
    >
      {children}
    </main>
  );
}

/** Renders one command-centre page, or the pairing gate when this device has
 * no session yet. */
export function CommandPageView({ page, onBackToChat }: { readonly page: CommandPage; readonly onBackToChat: () => void }): ReactNode {
  const auth = useAuth();
  if (auth.status !== "paired") {
    return (
      <PageFrame testId={`command-page-${page}`}>
        <header className="neutral-page-header flex items-center justify-between border-b border-hairline px-6 py-5">
          <h1 className="text-[22px] font-semibold tracking-tight">{t(`sidebar.nav.${page}`)}</h1>
          <Button onClick={onBackToChat}>返回聊天</Button>
        </header>
        {window.ogb?.taskCore ? <div role={auth.error ? "alert" : "status"} className="m-auto p-6 text-ink-secondary">{auth.error ?? "正在连接本机任务服务…"}</div> : <PairingGate key={page} />}
      </PageFrame>
    );
  }
  return <PageFrame testId={`command-page-${page}`}>{content(page)}</PageFrame>;
}

function content(page: CommandPage): ReactNode {
  switch (page) {
    case "herdr": return <HerdrPage />;
    case "hermes":
      return <PersonalAgentPage />;
    case "missions":
      return (
        <MissionCenter
          selectedId={null}
          onSelect={() => {}}
          onCreate={() => {}}
        />
      );
    case "computers":
      return <CloudComputerSettings />;
    case "agents":
      return <AgentSettings />;
    case "terminals":
      return <TerminalWorkbench />;
  }
}
