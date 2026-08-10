import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The client lib is consumed straight from source — no build step, and changes
// to ../../js/src hot-reload into this app.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fairway/client/react/styles.css": path.resolve(__dirname, "../../../js/src/react/styles.css"),
      "@fairway/client/react/markdown": path.resolve(__dirname, "../../../js/src/react/markdown.tsx"),
      "@fairway/client/react": path.resolve(__dirname, "../../../js/src/react/index.ts"),
      "@fairway/client": path.resolve(__dirname, "../../../js/src/index.ts"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8500",
    },
  },
});
