import { Component, type ReactNode } from "react";

import { t } from "@/lib/i18n";

export class PluginPanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <p role="alert" className="rounded-lg border border-hairline p-3 text-sm text-danger">{t("pluginUi.panelFailed")}</p>;
    return this.props.children;
  }
}
