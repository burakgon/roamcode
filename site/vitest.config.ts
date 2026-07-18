import { defineConfig } from "vitest/config";
import { legalMarkdownPlugin } from "./legal-markdown-plugin";

export default defineConfig({
  plugins: [legalMarkdownPlugin()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
