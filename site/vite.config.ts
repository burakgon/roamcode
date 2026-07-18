import { defineConfig } from "vite";
import { legalMarkdownPlugin } from "./legal-markdown-plugin";

export default defineConfig({
  plugins: [legalMarkdownPlugin()],
  build: {
    // The canonical site build writes the hosted PWA to dist/terminal first. Keep that independently
    // built subtree while Vite emits the marketing/account shell beside it.
    emptyOutDir: false,
    target: "es2020",
    assetsInlineLimit: 2048, // keep woff2 as files (cacheable), inline only tiny assets
    rollupOptions: {
      output: {
        // xterm is lazy-imported by playground.ts — keep it in its own cacheable chunk
        manualChunks: (id) => (id.includes("@xterm") ? "xterm" : undefined),
      },
    },
  },
});
