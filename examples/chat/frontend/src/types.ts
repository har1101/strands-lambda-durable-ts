// Contract A: runtime configuration served at /config.json.
export type AppConfig = {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  cognitoDomain: string;
  apiBaseUrl: string;
  eventsHttpDomain: string;
  eventsRealtimeDomain: string;
};

// Contract B: HTTP API.
export type ConversationStatus = "idle" | "running" | "waiting_approval" | "failed";

export type ConversationSummary = {
  conversationId: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
};

export type Interrupt = { id: string; name: string; reason?: unknown };

export type PendingApproval = { callbackId: string; interrupt: Interrupt };

export type ConversationDetail = ConversationSummary & {
  pendingApproval?: PendingApproval;
  lastError?: string;
  activeRunId?: string;
  /** Prompt of the active or last failed run; not yet part of `messages`. */
  pendingText?: string;
};

export type ChatMessage = { seq: number; role: "user" | "assistant"; content: unknown[]; createdAt: string };

// Contract C: live events published on /chat/{sub}/{conversationId}.
export type ToolStatus = "progress" | "success" | "error" | "interrupted";

export type LiveEvent = { runId: string } & (
  | { kind: "run_started" }
  | { kind: "model_start"; call: number; attempt: string }
  | { kind: "text"; call: number; attempt: string; text: string }
  | { kind: "tool"; tool: string; toolUseId: string; status: ToolStatus; result?: unknown; text?: string }
  | { kind: "approval"; callbackId: string; interrupt: Interrupt }
  | { kind: "done" }
  | { kind: "failed"; error: string }
);

export const isBusy = (status: ConversationStatus | undefined): boolean =>
  status === "running" || status === "waiting_approval";
