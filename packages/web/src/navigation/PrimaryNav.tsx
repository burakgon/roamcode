import { Icon, type IconName } from "../ui/Icon";
import { APP_DESTINATION_PATHS, type AppDestination } from "./app-route";

export type PrimaryNavVariant = "vertical" | "compact" | "bottom";

export interface PrimaryNavProps {
  activeDestination: AppDestination;
  onDestinationChange: (destination: AppDestination) => void;
  variant?: PrimaryNavVariant;
  label?: string;
}

interface PrimaryNavItem {
  destination: AppDestination;
  label: string;
  icon: IconName;
}

const PRIMARY_NAV_ITEMS: readonly PrimaryNavItem[] = [
  { destination: "sessions", label: "Sessions", icon: "terminal" },
  { destination: "automations", label: "Automations", icon: "bolt" },
  { destination: "agents", label: "Agents", icon: "agent" },
];

export function PrimaryNav({
  activeDestination,
  onDestinationChange,
  variant = "vertical",
  label = "Primary navigation",
}: PrimaryNavProps) {
  return (
    <nav className={`rc-primary-nav rc-primary-nav--${variant}`} aria-label={label}>
      <ul className="rc-primary-nav__list">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const active = item.destination === activeDestination;
          return (
            <li key={item.destination} className="rc-primary-nav__item">
              <a
                className={`rc-primary-nav__link${active ? " rc-primary-nav__link--active" : ""}`}
                href={APP_DESTINATION_PATHS[item.destination]}
                aria-current={active ? "page" : undefined}
                aria-label={variant === "compact" ? item.label : undefined}
                title={variant === "compact" ? item.label : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onDestinationChange(item.destination);
                }}
              >
                <span className="rc-primary-nav__icon" aria-hidden="true">
                  <Icon name={item.icon} size={18} />
                </span>
                <span className="rc-primary-nav__label">{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <style>{primaryNavCss}</style>
    </nav>
  );
}

const primaryNavCss = `
.rc-primary-nav {
  color: var(--text-muted);
  font-size: var(--fs-sm);
  font-weight: 500;
}
.rc-primary-nav__list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.rc-primary-nav__item { min-width: 0; }
.rc-primary-nav__link {
  position: relative;
  min-height: var(--tap-min);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: inherit;
  text-decoration: none;
  transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
}
.rc-primary-nav__link:hover {
  color: var(--text);
  background: var(--surface-2);
}
.rc-primary-nav__link--active {
  color: var(--text);
  background: var(--surface-2);
  border-color: var(--border);
}
.rc-primary-nav__link--active::before {
  content: "";
  position: absolute;
  left: -1px;
  width: 2px;
  height: 18px;
  border-radius: var(--radius-pill);
  background: var(--accent);
}
.rc-primary-nav__icon {
  width: 20px;
  display: grid;
  flex: none;
  place-items: center;
  color: currentColor;
}
.rc-primary-nav__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-primary-nav--compact { width: var(--tap-min); }
.rc-primary-nav--compact .rc-primary-nav__context {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.rc-primary-nav--compact .rc-primary-nav__link {
  width: var(--tap-min);
  padding: 0;
  justify-content: center;
}
.rc-primary-nav--compact .rc-primary-nav__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.rc-primary-nav--bottom {
  width: 100%;
  padding: var(--sp-1) max(var(--sp-2), env(safe-area-inset-right)) max(var(--sp-1), env(safe-area-inset-bottom)) max(var(--sp-2), env(safe-area-inset-left));
  background: var(--glass-strong);
  border-top: 1px solid var(--border-strong);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow: var(--glass-shadow);
}
.rc-primary-nav--bottom .rc-primary-nav__context {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  margin: 0;
  padding: 2px var(--sp-2) 0;
  border: 0;
}
.rc-primary-nav--bottom .rc-primary-nav__context > span,
.rc-primary-nav--bottom .rc-primary-nav__context > strong {
  font-size: 10px;
}
.rc-primary-nav--bottom .rc-primary-nav__list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-1);
}
.rc-primary-nav--bottom .rc-primary-nav__link {
  min-height: 52px;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: var(--sp-1);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
}
.rc-primary-nav--bottom .rc-primary-nav__link--active::before {
  top: -1px;
  left: 50%;
  width: 18px;
  height: 2px;
  transform: translateX(-50%);
}
`;
