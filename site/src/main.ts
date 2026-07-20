import { initPlayground } from "./playground";

const topbar = document.getElementById("topbar");
const syncTopbar = () => topbar?.classList.toggle("is-scrolled", window.scrollY > 16);
window.addEventListener("scroll", syncTopbar, { passive: true });
syncTopbar();

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  button.addEventListener("click", async () => {
    const label = button.querySelector<HTMLElement>(".command__copy");
    const copied = await copyText(button.dataset.copy ?? "");
    button.classList.toggle("is-copied", copied);
    if (label) label.textContent = copied ? "Copied" : "Select";
    window.setTimeout(() => {
      button.classList.remove("is-copied");
      if (label) label.textContent = "Copy";
    }, 1_700);
  });
}

function activateTabs(options: {
  tabs: NodeListOf<HTMLButtonElement>;
  panels: NodeListOf<HTMLElement>;
  tabValue: (tab: HTMLButtonElement) => string | undefined;
  panelValue: (panel: HTMLElement) => string | undefined;
  initial?: string;
}) {
  const tabs = [...options.tabs];
  const panels = [...options.panels];
  const select = (value: string, focus = false) => {
    for (const tab of tabs) {
      const active = options.tabValue(tab) === value;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const panel of panels) panel.hidden = options.panelValue(panel) !== value;
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const value = options.tabValue(tab);
      if (value) select(value);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = tabs.indexOf(tab);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(current + direction + tabs.length) % tabs.length];
      const value = next ? options.tabValue(next) : undefined;
      if (value) select(value, true);
    });
  }
  const selected =
    options.initial ??
    (() => {
      const selectedTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
      return selectedTab ? options.tabValue(selectedTab) : undefined;
    })();
  if (selected) select(selected);
}

const installTabs = document.querySelectorAll<HTMLButtonElement>("[data-install-tab]");
const installPanels = document.querySelectorAll<HTMLElement>("[data-install-panel]");
const preferredInstall = /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "macos" : "linux";
activateTabs({
  tabs: installTabs,
  panels: installPanels,
  tabValue: (tab) => tab.dataset.installTab,
  panelValue: (panel) => panel.dataset.installPanel,
  initial: preferredInstall,
});

initPlayground();
