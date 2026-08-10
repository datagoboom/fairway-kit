import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The libraries are consumed straight from source — no build step, and edits to
// ../../js/packages/* hot-reload into this app.
const pkg = (p: string) => path.resolve(__dirname, "../../../js/packages", p);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fairway-kit/client/react/styles.css": pkg("client/src/react/styles.css"),
      "@fairway-kit/client/react/markdown": pkg("client/src/react/markdown.tsx"),
      "@fairway-kit/client/react": pkg("client/src/react/index.ts"),
      "@fairway-kit/client": pkg("client/src/index.ts"),
      "@fairway-kit/protocol": pkg("protocol/src/index.ts"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8500",
    },
  },
});
