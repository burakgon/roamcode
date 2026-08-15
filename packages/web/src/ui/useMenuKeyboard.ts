import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * The keyboard half of a `role="menu"` popover.
 *
 * The header's three menus declared menu semantics but implemented none of them: focus never entered the
 * menu, arrow keys did nothing, two of them could only be dismissed by clicking somewhere else, and closing
 * one stranded focus on `<body>`. Announcing a menu to assistive tech and then leaving it keyboard-inert is
 * worse than not announcing it at all.
 *
 * Adds, for as long as `open` is true:
 *  - focus into the first item on open, and back to the trigger on close;
 *  - ArrowDown / ArrowUp with wrap, Home / End;
 *  - Escape to close;
 *  - an outside click to close (the behaviour these menus already had).
 *
 * The pattern mirrors {@link ../ui/SegmentedToggle}, which already does roving focus correctly.
 */
export function useMenuKeyboard(
  open: boolean,
  close: () => void,
  menuRef: RefObject<HTMLElement | null>,
  triggerRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const trigger = triggerRef?.current ?? (document.activeElement as HTMLElement | null);

    const items = (): HTMLElement[] =>
      Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"], button:not([disabled])') ?? []);

    // Focus the first item so the menu is immediately operable from the keyboard.
    items()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      const move = (index: number): void => {
        event.preventDefault();
        list[(index + list.length) % list.length]?.focus();
      };
      if (event.key === "ArrowDown") move(current + 1);
      else if (event.key === "ArrowUp") move(current <= 0 ? list.length - 1 : current - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(list.length - 1);
    };

    const onOutsideClick = (): void => close();

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onOutsideClick);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onOutsideClick);
      // Closing a menu must not strand focus on <body>: hand it back to whatever opened the menu.
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, [open, close, menuRef, triggerRef]);
}
