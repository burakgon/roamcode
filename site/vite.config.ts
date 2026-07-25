import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    assetsInlineLimit: 2048, // keep woff2 as files (cacheable), inline only tiny assets
    rollupOptions: {
      output: {
        // Ghostty is lazy-imported by playground.ts — keep its JS bridge in a cacheable chunk.
        manualChunks: (id) => (id.includes("@roamcode.ai/ghostty-web") ? "ghostty-web" : undefined),
      },
    },
  },
});
