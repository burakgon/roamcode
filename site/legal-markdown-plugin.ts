import { readFileSync } from "node:fs";

import type { Plugin } from "vite";

export function legalMarkdownPlugin(): Plugin {
  return {
    name: "roamcode-legal-markdown",
    enforce: "pre",
    load(id) {
      const file = id.split("?", 1)[0];
      if (!file?.endsWith(".md")) return;
      return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
    },
  };
}
