import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, PendingApproval, ToolStatus } from "./types";

type Block = Record<string, unknown>;
type ToolUseBlock = { name: string; toolUseId: string; input?: unknown };
type ToolResultBlock = { toolUseId: string; status?: string; content?: unknown[] };

const asRecord = (value: unknown): Block | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Block) : undefined;

export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Strands tool results carry [{text} | {json}] blocks.
function formatToolResultContent(content: unknown[] | undefined): string {
  return (content ?? [])
    .map(item => {
      const block = asRecord(item);
      if (typeof block?.text === "string") return block.text;
      if (block && "json" in block) return formatJson(block.json);
      return formatJson(item);
    })
    .join("\n");
}

export function AssistantText({ text }: { text: string }) {
  // Some models leak <thinking> sections into text; hide them (also while still unterminated mid-stream).
  const visible = text.replace(/<thinking>[\s\S]*?(<\/thinking>\s*|$)/g, "").trim();
  if (!visible) return null;
  return (
    <div className="message assistant">
      <div className="bubble markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{visible}</Markdown>
      </div>
    </div>
  );
}

export function UserText({ text }: { text: string }) {
  return (
    <div className="message user">
      <div className="bubble">{text}</div>
    </div>
  );
}

export type ToolCardStatus = ToolStatus | "pending";

const TOOL_STATUS_LABELS: Record<ToolCardStatus, string> = {
  progress: "実行中",
  success: "完了",
  error: "エラー",
  interrupted: "承認待ち",
  pending: "未完了",
};

type ToolCardProps = { name: string; status: ToolCardStatus; input?: unknown; result?: string; note?: string };

export function ToolCard({ name, status, input, result, note }: ToolCardProps) {
  return (
    <div className="message assistant">
      <details className={`tool-card tool-${status}`}>
        <summary>
          <span className="tool-icon" aria-hidden>
            ⚙
          </span>
          <span className="tool-name">{name}</span>
          <span className={`tool-status tool-status-${status}`}>{TOOL_STATUS_LABELS[status]}</span>
        </summary>
        <div className="tool-body">
          {input !== undefined && (
            <>
              <div className="tool-label">入力</div>
              <pre>{formatJson(input)}</pre>
            </>
          )}
          {note && (
            <>
              <div className="tool-label">経過</div>
              <pre>{note}</pre>
            </>
          )}
          {result !== undefined && (
            <>
              <div className="tool-label">結果</div>
              <pre>{result}</pre>
            </>
          )}
          {input === undefined && !note && result === undefined && <div className="tool-label">詳細はありません</div>}
        </div>
      </details>
    </div>
  );
}

/** Renders stored messages; toolResult blocks (role "user") are folded into the matching toolUse card. */
export function HistoryMessages({ messages }: { messages: ChatMessage[] }) {
  const results = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    for (const item of message.content) {
      const result = asRecord(asRecord(item)?.toolResult) as ToolResultBlock | undefined;
      if (result?.toolUseId) results.set(result.toolUseId, result);
    }
  }

  const nodes: ReactNode[] = [];
  for (const message of messages) {
    const userTexts: string[] = [];
    message.content.forEach((item, index) => {
      const block = asRecord(item);
      const key = `${message.seq}-${index}`;
      if (typeof block?.text === "string") {
        if (message.role === "user") userTexts.push(block.text);
        else nodes.push(<AssistantText key={key} text={block.text} />);
        return;
      }
      const toolUse = asRecord(block?.toolUse) as ToolUseBlock | undefined;
      if (toolUse?.toolUseId) {
        const result = results.get(toolUse.toolUseId);
        const status: ToolCardStatus = !result ? "pending" : result.status === "error" ? "error" : "success";
        nodes.push(
          <ToolCard
            key={key}
            name={toolUse.name}
            status={status}
            input={toolUse.input}
            result={result ? formatToolResultContent(result.content) : undefined}
          />,
        );
      }
      // toolResult is rendered with its toolUse; reasoningContent and other blocks are hidden.
    });
    if (userTexts.length > 0) nodes.push(<UserText key={`${message.seq}-user`} text={userTexts.join("\n")} />);
  }
  return <>{nodes}</>;
}

const REASON_LABELS: Record<string, string> = { action: "操作", orderId: "注文番号", amount: "金額" };
const ACTION_LABELS: Record<string, string> = { issue_refund: "返金" };

function formatReasonValue(key: string, value: unknown): string {
  if (key === "amount" && typeof value === "number") return `${value.toLocaleString("ja-JP")} 円`;
  if (key === "action" && typeof value === "string") return ACTION_LABELS[value] ? `${ACTION_LABELS[value]} (${value})` : value;
  return typeof value === "string" ? value : formatJson(value);
}

export type ApprovalDecision = { approved: boolean; sending: boolean };

type ApprovalCardProps = {
  approval: PendingApproval;
  decision: ApprovalDecision | undefined;
  onDecide(approved: boolean): void;
};

export function ApprovalCard({ approval, decision, onDecide }: ApprovalCardProps) {
  const reason = approval.interrupt.reason;
  const fields = asRecord(reason);
  return (
    <div className="message assistant">
      <div className="approval-card">
        <div className="approval-title">承認が必要です</div>
        <p className="approval-lead">エージェントが次の操作の実行許可を求めています。</p>
        {fields ? (
          <dl className="approval-fields">
            {Object.entries(fields).map(([key, value]) => (
              <div key={key}>
                <dt>{REASON_LABELS[key] ?? key}</dt>
                <dd>{formatReasonValue(key, value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          reason !== undefined && <pre>{formatJson(reason)}</pre>
        )}
        {decision ? (
          <div className={`approval-result ${decision.approved ? "approved" : "rejected"}`}>
            {decision.sending ? "送信しています…" : decision.approved ? "承認しました" : "却下しました"}
          </div>
        ) : (
          <div className="approval-actions">
            <button className="button primary" onClick={() => onDecide(true)}>
              承認
            </button>
            <button className="button danger" onClick={() => onDecide(false)}>
              却下
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
