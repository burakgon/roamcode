import tseslint from "typescript-eslint";

export default tseslint.config(
  // Never lint build output (it is generated and gitignored): the app bundle (`dist`), the
  // screenshot-harness bundle (`dist-shot`), Vite's caches, and any coverage report.
  { ignores: ["**/dist/**", "**/dist-shot/**", "**/node_modules/**", "**/coverage/**", "**/.vite/**"] },
  ...tseslint.configs.recommended,
  // TYPE-AWARE LINT AT THE UNTRUSTED-CLI-JSON BOUNDARY (scoped on purpose). The `no-unsafe-*` family needs
  // type information (it is NOT in `recommended`, which is type-UN-checked here). Enabling it codebase-wide
  // surfaced ~100 findings + project-service churn across config files — the massive risky diff we avoid.
  // Instead we scope the type-checked program to ONLY the three files that parse/fold the untrusted CLI
  // JSON: where an `any` slipping through is exactly the class of bug (raw-XML leak / TypeError on a
  // malformed block) this batch hardens. These files are already clean (zero findings), so this is a pure
  // ratchet: any future `any` creeping into the boundary now fails lint. A full type-aware pass over the
  // rest of the codebase is deliberate follow-up, not in-scope here.
  {
    files: [
      "packages/protocol/src/parse.ts",
      "packages/server/src/transcript.ts",
      "packages/web/src/store/frame-reducer.ts",
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },
);
