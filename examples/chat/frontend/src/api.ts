import type { ChatMessage, ConversationDetail, ConversationSummary } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ConversationWithMessages = { conversation: ConversationDetail; messages: ChatMessage[] };

export interface Api {
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(): Promise<ConversationSummary>;
  getConversation(id: string): Promise<ConversationWithMessages>;
  deleteConversation(id: string): Promise<void>;
  sendMessage(id: string, text: string): Promise<{ runId: string }>;
  sendApproval(id: string, callbackId: string, approved: boolean): Promise<void>;
}

export function createApi(baseUrl: string, getIdToken: () => string | undefined): Api {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = getIdToken();
    if (!token) throw new ApiError("ログインが必要です", 401);
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: unknown; message?: unknown };
        if (typeof payload.error === "string") message = payload.error;
        else if (typeof payload.message === "string") message = payload.message;
      } catch {
        // Non-JSON error body (e.g. CloudFront error page): keep the status text.
      }
      throw new ApiError(message, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const conversationPath = (id: string) => `/conversations/${encodeURIComponent(id)}`;

  return {
    listConversations: () =>
      request<{ conversations: ConversationSummary[] }>("GET", "/conversations").then(r => r.conversations),
    createConversation: () => request("POST", "/conversations", {}),
    getConversation: id => request("GET", conversationPath(id)),
    deleteConversation: id => request("DELETE", conversationPath(id)),
    sendMessage: (id, text) => request("POST", `${conversationPath(id)}/messages`, { text }),
    sendApproval: (id, callbackId, approved) =>
      request("POST", `${conversationPath(id)}/approval`, { callbackId, approved }),
  };
}
