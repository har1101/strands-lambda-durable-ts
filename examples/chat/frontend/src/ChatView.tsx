import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Api, ConversationWithMessages } from "./api";
import type { EventsClient } from "./events";
import {
  ApprovalCard,
  AssistantText,
  formatJson,
  HistoryMessages,
  ToolCard,
  UserText,
  type ApprovalDecision,
} from "./Messages";
import { isBusy, type LiveEvent, type PendingApproval, type ToolStatus } from "./types";

const SAMPLE_PROMPTS = ["A-1001 と B-2002 の注文状況をまとめて調べて", "注文 A-1001 に 3000 円を返金して", "123 と 456 を足して"];
const MAX_TEXT = 4000;
const POLL_MS = 3000;
const MAX_APPROVAL_POLL_MS = 30_000;

type LiveItem = { type: "text"; call: number } | { type: "tool"; toolUseId: string };

/** Provisional state of the current run, built from live events; replaced by GET once the run ends. */
type LiveRun = {
  runId?: string;
  userText?: string;
  items: LiveItem[];
  texts: Record<number, { attempt: string; text: string }>;
  tools: Record<string, { tool: string; status: ToolStatus; result?: unknown; text?: string }>;
  approval?: PendingApproval;
  error?: string;
};

const emptyRun = (runId?: string): LiveRun => ({ runId, items: [], texts: {}, tools: {} });

function applyEvent(live: LiveRun | undefined, event: LiveEvent): LiveRun {
  // Events of a different run than the one on screen start a fresh live state.
  const run = live && (!live.runId || live.runId === event.runId) ? { ...live, runId: event.runId } : emptyRun(event.runId);
  switch (event.kind) {
    case "model_start": {
      // A new attempt of a model call replaces whatever text the previous attempt streamed.
      const items = run.items.some(i => i.type === "text" && i.call === event.call)
        ? run.items
        : [...run.items, { type: "text" as const, call: event.call }];
      return { ...run, items, texts: { ...run.texts, [event.call]: { attempt: event.attempt, text: "" } } };
    }
    case "text": {
      const current = run.texts[event.call];
      if (current?.attempt !== event.attempt) return run; // stale attempt, or its model_start was missed
      return { ...run, texts: { ...run.texts, [event.call]: { ...current, text: current.text + event.text } } };
    }
    case "tool": {
      const items = run.items.some(i => i.type === "tool" && i.toolUseId === event.toolUseId)
        ? run.items
        : [...run.items, { type: "tool" as const, toolUseId: event.toolUseId }];
      const { tool, status, result, text } = event;
      return { ...run, items, tools: { ...run.tools, [event.toolUseId]: { tool, status, result, text } } };
    }
    case "approval":
      return { ...run, approval: { callbackId: event.callbackId, interrupt: event.interrupt } };
    default:
      return run;
  }
}

type Props = {
  api: Api;
  events: EventsClient;
  sub: string;
  conversationId: string;
  onChanged(): void;
};

export function ChatView({ api, events, sub, conversationId, onChanged }: Props) {
  const [data, setData] = useState<ConversationWithMessages>();
  const [loadError, setLoadError] = useState<string>();
  const [live, setLive] = useState<LiveRun>();
  const [decisions, setDecisions] = useState<Record<string, ApprovalDecision>>({});
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [text, setText] = useState("");

  // Bumped whenever local state gets ahead of the server, so older in-flight GETs are discarded.
  const loadGeneration = useRef(0);
  const lastEventAt = useRef(0);
  const finishedRuns = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composing = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const generation = loadGeneration.current;
    try {
      const result = await api.getConversation(conversationId);
      if (generation !== loadGeneration.current) return;
      setData(result);
      setLoadError(undefined);
      // Once the run is over, DynamoDB holds the full turn; drop the provisional live view.
      if (!isBusy(result.conversation.status)) setLive(undefined);
    } catch (error) {
      if (generation === loadGeneration.current) setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [api, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      events.subscribe(`/chat/${sub}/${conversationId}`, raw => {
        const event = raw as LiveEvent;
        if (typeof event?.runId !== "string" || finishedRuns.current.has(event.runId)) return;
        lastEventAt.current = Date.now();
        if (event.kind === "done" || event.kind === "failed") {
          finishedRuns.current.add(event.runId);
          if (event.kind === "failed") setLive(current => ({ ...(current ?? emptyRun(event.runId)), error: event.error }));
          void load();
          onChanged();
          return;
        }
        setLive(current => applyEvent(current, event));
      }),
    [events, sub, conversationId, load, onChanged],
  );

  const status = data?.conversation.status;
  const busy = isBusy(status);

  // Poll quickly during a run, but back off while waiting for a person to approve.
  useEffect(() => {
    if (!busy) return;
    const waitingApproval = status === "waiting_approval";
    let delay = POLL_MS;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      if (Date.now() - lastEventAt.current >= POLL_MS) await load();
      if (stopped) return;
      if (waitingApproval) delay = Math.min(delay * 2, MAX_APPROVAL_POLL_MS);
      timer = window.setTimeout(poll, delay);
    };
    timer = window.setTimeout(poll, delay);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [busy, status, data?.conversation.activeRunId, load]);

  const markRunning = (runId: string | undefined) => {
    loadGeneration.current += 1;
    lastEventAt.current = Date.now(); // give live events a head start before polling kicks in
    setData(current =>
      current && {
        ...current,
        conversation: { ...current.conversation, status: "running", activeRunId: runId ?? current.conversation.activeRunId, lastError: undefined },
      },
    );
  };

  const send = async (value: string) => {
    const prompt = value.trim();
    if (!prompt || prompt.length > MAX_TEXT || busy || sending) return;
    loadGeneration.current += 1;
    setSending(true);
    setActionError(undefined);
    setLive({ ...emptyRun(), userText: prompt });
    try {
      const { runId } = await api.sendMessage(conversationId, prompt);
      setLive(current => (current && !current.runId ? { ...current, runId } : current));
      markRunning(runId);
      setText("");
      onChanged();
    } catch (error) {
      setLive(undefined);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const decide = async (approval: PendingApproval, approved: boolean) => {
    setDecisions(current => ({ ...current, [approval.callbackId]: { approved, sending: true } }));
    setActionError(undefined);
    try {
      await api.sendApproval(conversationId, approval.callbackId, approved);
      setDecisions(current => ({ ...current, [approval.callbackId]: { approved, sending: false } }));
      // Keep the decided card on screen until the run finishes, even if GET no longer reports it as pending.
      setLive(current => ({ ...(current ?? emptyRun(data?.conversation.activeRunId)), approval }));
      markRunning(undefined);
      onChanged();
    } catch (error) {
      setDecisions(({ [approval.callbackId]: _, ...rest }) => rest);
      setActionError(error instanceof Error ? error.message : String(error));
      void load();
    }
  };

  const disabled = busy || sending;
  const loaded = data !== undefined;
  useEffect(() => {
    // Return focus to the composer when a run ends (desktop only, to avoid popping up mobile keyboards).
    if (loaded && !disabled && window.matchMedia("(pointer: fine)").matches) textareaRef.current?.focus();
  }, [loaded, disabled]);

  // Follow new content only while the reader is already at the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [data, live, decisions, sending]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline; ignore Enter that confirms an IME conversion.
    if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send(text);
  };

  if (!data) {
    return (
      <div className="chat-view">
        <div className="chat-center">
          {loadError ? <div className="banner error">{loadError}</div> : <div className="spinner" aria-label="読み込み中" />}
        </div>
      </div>
    );
  }

  const { conversation, messages } = data;
  const approval = live?.approval ?? conversation.pendingApproval;
  const decision = approval ? decisions[approval.callbackId] : undefined;
  const showApproval = approval && (status === "waiting_approval" || decision || live?.approval);
  const waitingForUser = status === "waiting_approval" && !decision;
  const thinking = (sending || busy) && !waitingForUser;
  const errorText = live?.error ?? (status === "failed" ? (conversation.lastError ?? "実行に失敗しました") : undefined);
  // The run saves its prompt as a message only when it completes; until then the server keeps it as pendingText.
  const pendingText = live?.userText ?? conversation.pendingText;
  const empty = messages.length === 0 && !live && !pendingText;

  return (
    <div className="chat-view">
      <div className="chat-header">
        <h2 className="chat-title">{conversation.title}</h2>
      </div>
      <div
        className="messages"
        ref={scrollRef}
        onScroll={event => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {empty && (
            <div className="chat-intro">
              <h3>何を手伝いましょうか？</h3>
              <p>注文の調査、承認付きの返金、計算ツールを試せます。</p>
            </div>
          )}
          <HistoryMessages messages={messages} />
          {pendingText && <UserText text={pendingText} />}
          {live?.items.map(item => {
            if (item.type === "text") {
              const entry = live.texts[item.call];
              return entry ? <AssistantText key={`text-${item.call}`} text={entry.text} /> : null;
            }
            const tool = live.tools[item.toolUseId];
            return (
              tool && (
                <ToolCard
                  key={`tool-${item.toolUseId}`}
                  name={tool.tool}
                  status={tool.status}
                  result={tool.result === undefined ? undefined : formatJson(tool.result)}
                  note={tool.text}
                />
              )
            );
          })}
          {showApproval && (
            <ApprovalCard approval={approval} decision={decision} onDecide={approved => void decide(approval, approved)} />
          )}
          {thinking && (
            <div className="message assistant">
              <div className="thinking" aria-label="応答を生成しています">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {errorText && <div className="banner error">エラー: {errorText}</div>}
        </div>
      </div>
      <div className="composer-area">
        {actionError && <div className="banner error">{actionError}</div>}
        {empty && (
          <div className="sample-prompts">
            {SAMPLE_PROMPTS.map(prompt => (
              <button key={prompt} className="chip" disabled={disabled} onClick={() => void send(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        )}
        <div className={`composer${disabled ? " disabled" : ""}`}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            maxLength={MAX_TEXT}
            disabled={disabled}
            placeholder={
              status === "waiting_approval"
                ? "承認待ちです。上のカードで承認または却下してください"
                : disabled
                  ? "エージェントが応答中です…"
                  : "メッセージを入力（Enter で送信、Shift+Enter で改行）"
            }
            onChange={event => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
          />
          <button className="button primary send-button" disabled={disabled || !text.trim()} onClick={() => void send(text)}>
            送信
          </button>
        </div>
        {text.length > MAX_TEXT - 500 && (
          <div className="composer-hint">
            {text.length} / {MAX_TEXT}
          </div>
        )}
      </div>
    </div>
  );
}
