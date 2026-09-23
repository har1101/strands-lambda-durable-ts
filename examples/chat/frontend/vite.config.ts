import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// `VITE_DEV_API_ORIGIN=https://dxxxx.cloudfront.net npm run dev` proxies /api and /config.json to a deployed stack.
export default defineConfig(({ mode }) => {
  const origin = loadEnv(mode, process.cwd(), "VITE_").VITE_DEV_API_ORIGIN;
  const target = { target: origin, changeOrigin: true, secure: true };
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: origin ? { "/api": target, "/config.json": target } : undefined,
    },
  };
});
