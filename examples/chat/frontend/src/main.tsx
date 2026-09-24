import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebStorageStateStore } from "oidc-client-ts";
import { AuthProvider } from "react-oidc-context";
import { App } from "./App";
import { APP_NAMES, type AppConfig } from "./types";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

try {
  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`/config.json: HTTP ${response.status}`);
  const config = (await response.json()) as AppConfig;
  document.title = APP_NAMES[config.engine];
  const origin = window.location.origin;
  root.render(
    <StrictMode>
      <AuthProvider
        authority={`https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`}
        client_id={config.userPoolClientId}
        redirect_uri={`${origin}/`}
        post_logout_redirect_uri={`${origin}/`}
        response_type="code"
        scope="openid email profile"
        // Cognito issues refresh tokens for the code flow; oidc-client-ts renews with them before expiry.
        automaticSilentRenew
        userStore={new WebStorageStateStore({ store: window.localStorage })}
        onSigninCallback={() => window.history.replaceState({}, document.title, window.location.pathname)}
      >
        <App config={config} />
      </AuthProvider>
    </StrictMode>,
  );
} catch (error) {
  root.render(
    <div className="landing">
      <div className="landing-card">
        <h1>Durable Chat</h1>
        <p className="error-text">設定を読み込めませんでした: {error instanceof Error ? error.message : String(error)}</p>
      </div>
    </div>,
  );
}
