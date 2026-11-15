/** The five command-centre pages, as the shell mounts them.
 *
 * Each one is a view of the same window: the rail, the background layer and the
 * skins are the app's own, and the page only fills the main pane. A page that
 * reads `/api/v1` needs the device's bearer, so every one of them renders
 * behind `PairingGate` — a device without a token would otherwise show a pane
 * of 401s instead of the one thing that fixes it. */

import type { ReactNode } from "react";

import { useAuth } from "../foundation/api.ts";
import { PersonalAgentPage } from "../personal/PersonalAgentPage.tsx";
import { MissionCenter } from "../personal/MissionCenter.tsx";
import { CloudComputerSettings } from "../settings/CloudComputerSettings.tsx";
import { AgentSettings } from "../settings/AgentSettings.tsx";
import { Workbench as TerminalWorkbench } from "../workbench/Workbench.tsx";
import { PairingGate } from "./PairingGate.tsx";

export type CommandPage = "hermes" | "missions" | "computers" | "agents" | "terminals";

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
export function CommandPageView({ page }: { readonly page: CommandPage }): ReactNode {
  const auth = useAuth();
  if (auth.status !== "paired") {
    return (
      <PageFrame testId={`command-page-${page}`}>
        <PairingGate />
      </PageFrame>
    );
  }
  return <PageFrame testId={`command-page-${page}`}>{content(page)}</PageFrame>;
}

function content(page: CommandPage): ReactNode {
  switch (page) {
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
