import { defineConfig } from "vite";

export default defineConfig({
  build: {
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
