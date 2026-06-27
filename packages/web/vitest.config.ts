import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Stub the build-time sha so __BUILD_SHA__ resolves under test (no git stamp runs here). "dev" makes
  // stale detection treat the bundle as unstamped → "can't decide", which the tests rely on.
  define: { __BUILD_SHA__: JSON.stringify("dev") },
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
