import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "react-oidc-context";
import { createApi } from "./api";
import { ChatView } from "./ChatView";
import { EventsClient, type ConnectionState } from "./events";
import { Sidebar } from "./Sidebar";
import { isBusy, type AppConfig, type ConversationSummary } from "./types";

export function App({ config }: { config: AppConfig }) {
  const auth = useAuth();
  if (auth.isLoading || auth.activeNavigator) {
    return (
      <div className="landing">
        <div className="spinner" aria-label="読み込み中" />
      </div>
    );
  }
  if (!auth.isAuthenticated || !auth.user) {
    return (
      <div className="landing">
        <div className="landing-card">
          <h1>Durable Strands Chat</h1>
          <p>
            AWS Lambda durable functions 上で動く Strands Agents のデモです。途中で中断しても再開でき、返金などの操作は人の承認を待ちます。
          </p>
          {auth.error && <p className="error-text">ログインに失敗しました: {auth.error.message}</p>}
          <button className="button primary large" onClick={() => void auth.signinRedirect()}>
            ログイン
          </button>
        </div>
      </div>
    );
  }
  return <ChatApp config={config} />;
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connected: "リアルタイム接続中",
  connecting: "接続しています",
  disconnected: "未接続",
};

const conversationFromHash = (): string | undefined => /^#\/c\/(.+)$/.exec(window.location.hash)?.[1];

function ChatApp({ config }: { config: AppConfig }) {
  const auth = useAuth();
  const user = auth.user!;
  // Read at call time so API calls and WebSocket (re)connects always use the latest renewed ID token.
  const tokenRef = useRef(user.id_token);
  tokenRef.current = user.id_token;

  const api = useMemo(() => createApi(config.apiBaseUrl, () => tokenRef.current), [config]);
  const events = useMemo(
    () => new EventsClient(config.eventsHttpDomain, config.eventsRealtimeDomain, () => tokenRef.current),
    [config],
  );
  useEffect(() => () => events.close(), [events]);
  const connection = useSyncExternalStore(events.onStateChange, events.getState);

  const [conversations, setConversations] = useState<ConversationSummary[]>();
  const [listError, setListError] = useState<string>();
  const [selectedId, setSelectedId] = useState(conversationFromHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const refreshList = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
      setListError(undefined);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  }, [api]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Keep sidebar badges fresh while any conversation is still working.
  const anyBusy = conversations?.some(c => isBusy(c.status)) ?? false;
  useEffect(() => {
    if (!anyBusy) return;
    const timer = setInterval(() => void refreshList(), 5000);
    return () => clearInterval(timer);
  }, [anyBusy, refreshList]);

  useEffect(() => {
    const onPop = () => setSelectedId(conversationFromHash());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = (id: string | undefined) => {
    window.history.pushState(null, "", id ? `#/c/${id}` : window.location.pathname);
    setSelectedId(id);
    setSidebarOpen(false);
  };

  const createConversation = async () => {
    setCreating(true);
    try {
      const created = await api.createConversation();
      setConversations(list => [created, ...(list ?? [])]);
      select(created.conversationId);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  };

  const deleteConversation = async (id: string) => {
    if (!window.confirm("この会話を削除しますか？この操作は取り消せません。")) return;
    try {
      await api.deleteConversation(id);
      if (id === selectedId) select(undefined);
      setConversations(list => list?.filter(c => c.conversationId !== id));
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
    void refreshList();
  };

  const signOut = async () => {
    events.close();
    await auth.removeUser();
    const logoutUri = encodeURIComponent(`${window.location.origin}/`);
    window.location.href = `${config.cognitoDomain}/logout?client_id=${encodeURIComponent(config.userPoolClientId)}&logout_uri=${logoutUri}`;
  };

  return (
    <div className="app">
      <header className="app-header">
        <button className="icon-button menu-button" aria-label="会話一覧" onClick={() => setSidebarOpen(open => !open)}>
          <span className="menu-icon" />
        </button>
        <div className="brand">Durable Strands Chat</div>
        <div className={`connection connection-${connection}`} title={CONNECTION_LABELS[connection]}>
          <span className="connection-dot" />
          <span className="connection-label">{CONNECTION_LABELS[connection]}</span>
        </div>
        <div className="header-spacer" />
        <span className="user-email">{user.profile.email ?? user.profile.sub}</span>
        <button className="button ghost" onClick={() => void signOut()}>
          ログアウト
        </button>
      </header>
      <div className="app-body">
        <Sidebar
          conversations={conversations}
          selectedId={selectedId}
          open={sidebarOpen}
          creating={creating}
          error={listError}
          onSelect={select}
          onCreate={() => void createConversation()}
          onDelete={id => void deleteConversation(id)}
          onClose={() => setSidebarOpen(false)}
        />
        <main className="main-pane">
          {selectedId ? (
            <ChatView
              key={selectedId}
              api={api}
              events={events}
              sub={user.profile.sub}
              conversationId={selectedId}
              onChanged={refreshList}
            />
          ) : (
            <div className="empty-state">
              <h2>会話を選択してください</h2>
              <p>左の一覧から会話を選ぶか、新しいチャットを始めましょう。</p>
              <button className="button primary" disabled={creating} onClick={() => void createConversation()}>
                新しいチャット
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
