export type SessionOrder = "created" | "activity";

const KEY = "roamcode.session-order";

export function loadSessionOrder(): SessionOrder {
  try {
    return localStorage.getItem(KEY) === "activity" ? "activity" : "created";
  } catch {
    return "created";
  }
}

export function saveSessionOrder(order: SessionOrder): void {
  try {
    localStorage.setItem(KEY, order);
  } catch {
    /* browser storage is optional; the in-memory preference still applies */
  }
}
