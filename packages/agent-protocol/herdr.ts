/** A native Agent session owned by Herdr, independent of mission execution. */
export interface HerdrSession {
  id: string;
  title: string;
  project: string;
  tool: string;
  terminalId: string;
  nativeAddress?: string;
  createdAt: string;
  endedAt?: string;
  conversation: boolean;
}
export interface HerdrMessage { id: string; role: "user" | "assistant" | "tool"; text: string; tool?: { name: string; input: string; output?: string } }
export interface HerdrApproval { id: string; method: string; detail: string }
export interface HerdrConversation {
  messages: HerdrMessage[];
  approvals: HerdrApproval[];
  running: boolean;
  error?: string;
  notice?: string;
}
