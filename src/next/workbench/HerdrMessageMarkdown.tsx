import { useEffect, useState } from "react";
import { ChatMarkdown, LocalMarkdownImageContext } from "@/components/ChatMarkdown";
import { MarkdownImagePreview } from "@/components/AttachmentPreview";
import { apiClient } from "../foundation/api";

export function HerdrMessageMarkdown({ text, sessionId, messageId }: { text: string; sessionId: string; messageId: string }) {
  return <LocalMarkdownImageContext.Provider value={({ name, sourceOffset }) => <HerdrImage name={name} sessionId={sessionId} messageId={messageId} offset={sourceOffset} />}><ChatMarkdown text={text} /></LocalMarkdownImageContext.Provider>;
}

function HerdrImage({ name, sessionId, messageId, offset }: { name: string; sessionId: string; messageId: string; offset: number }) {
  const [result, setResult] = useState<{ dataUrl: string } | { error: string } | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    apiClient().request<{ dataUrl: string }>(`/herdr/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/images/${offset}`).then(
      value => { if (active) setResult(value); },
      error => { if (active) setResult({ error: error.message }); },
    );
    return () => { active = false; };
  }, [sessionId, messageId, offset]);
  if (!result) return <span role="status">正在加载图片…</span>;
  if ("error" in result) return <span role="alert">图片无法加载：{result.error}</span>;
  return <MarkdownImagePreview src={result.dataUrl} name={name} />;
}
