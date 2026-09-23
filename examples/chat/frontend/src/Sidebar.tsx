import { isBusy, type ConversationStatus, type ConversationSummary } from "./types";

const STATUS_BADGES: Partial<Record<ConversationStatus, string>> = {
  running: "実行中",
  waiting_approval: "承認待ち",
  failed: "失敗",
};

function relativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}時間前`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}日前`;
  return new Date(iso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

type Props = {
  conversations: ConversationSummary[] | undefined;
  selectedId: string | undefined;
  open: boolean;
  creating: boolean;
  error: string | undefined;
  onSelect(id: string): void;
  onCreate(): void;
  onDelete(id: string): void;
  onClose(): void;
};

export function Sidebar(props: Props) {
  const { conversations, selectedId } = props;
  return (
    <>
      <div className={`sidebar-backdrop${props.open ? " open" : ""}`} onClick={props.onClose} />
      <aside className={`sidebar${props.open ? " open" : ""}`}>
        <button className="button primary new-chat" disabled={props.creating} onClick={props.onCreate}>
          <span aria-hidden>＋</span> 新しいチャット
        </button>
        {props.error && <div className="sidebar-error">{props.error}</div>}
        <nav className="conversation-list">
          {conversations === undefined && <div className="sidebar-note">読み込み中…</div>}
          {conversations?.length === 0 && <div className="sidebar-note">まだ会話はありません</div>}
          {conversations?.map(c => {
            const badge = STATUS_BADGES[c.status];
            return (
              <div
                key={c.conversationId}
                className={`conversation-item${c.conversationId === selectedId ? " active" : ""}`}
                onClick={() => props.onSelect(c.conversationId)}
                onKeyDown={event => {
                  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    props.onSelect(c.conversationId);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-current={c.conversationId === selectedId ? "page" : undefined}
              >
                <div className="conversation-text">
                  <div className="conversation-title">{c.title}</div>
                  <div className="conversation-meta">
                    <span>{relativeTime(c.updatedAt)}</span>
                    {badge && <span className={`badge badge-${c.status}`}>{badge}</span>}
                  </div>
                </div>
                <button
                  className="icon-button delete-button"
                  aria-label="削除"
                  title={isBusy(c.status) ? "実行中の会話は削除できません" : "削除"}
                  disabled={isBusy(c.status)}
                  onClick={event => {
                    event.stopPropagation();
                    props.onDelete(c.conversationId);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
