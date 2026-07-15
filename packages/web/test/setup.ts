import "@testing-library/jest-dom/vitest";

// Node 25 ships a native global `localStorage` (experimental Web Storage) that shadows jsdom's
// implementation. Without `--localstorage-file`, the native instance has no working methods
// (`getItem`/`setItem`/etc. are undefined), which breaks any test that touches storage. When we
// detect that broken native object, replace it with a small in-memory, spec-shaped Storage so
// jsdom-environment tests behave like a real browser. Harmless on engines where storage works.
function installMemoryStorage(name: "localStorage" | "sessionStorage"): void {
  const existing = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (existing && typeof existing.getItem === "function") return; // already functional

  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
  }
}

installMemoryStorage("localStorage");
installMemoryStorage("sessionStorage");

// jsdom exposes scrollTo but reports every call as "not implemented". Product code intentionally
// calls it while healing mobile viewport shifts, so make the test browser's no-op behavior explicit.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "scrollTo", { value: () => {}, configurable: true, writable: true });
}
