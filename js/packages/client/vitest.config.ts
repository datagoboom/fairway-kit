import { defineConfig } from "vitest/config";
import path from "node:path";

// Resolve @fairway-kit/protocol to source so tests run without a prior build.
export default defineConfig({
  resolve: {
    alias: {
      "@fairway-kit/protocol": path.resolve(__dirname, "../protocol/src/index.ts"),
    },
  },
});
