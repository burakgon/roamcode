import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DESTINATIONS,
  APP_DESTINATION_PATHS,
  currentAppDestination,
  destinationFromPathname,
  navigateToDestination,
  subscribeToDestinationChanges,
  type AppDestination,
} from "./app-route";

describe("app routes", () => {
  beforeEach(() => {
    window.history.replaceState({ test: true }, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes exactly the three product destinations and their canonical paths", () => {
    expect(APP_DESTINATIONS).toEqual(["sessions", "automations", "agents"]);
    expect(APP_DESTINATION_PATHS).toEqual({
      sessions: "/app/sessions",
      automations: "/app/automations",
      agents: "/app/agents",
    });
  });

  it.each<[string, AppDestination]>([
    ["/app/sessions", "sessions"],
    ["/app/sessions/", "sessions"],
    ["/app/automations", "automations"],
    ["/app/agents", "agents"],
    ["/", "sessions"],
    ["/unknown", "sessions"],
    ["/app/projects", "sessions"],
  ])("resolves %s to %s", (pathname, destination) => {
    expect(destinationFromPathname(pathname)).toBe(destination);
  });

  it("changes only the pathname and preserves session queries and pairing fragments", () => {
    window.history.replaceState({ operation: "keep" }, "", "/?session=session-42#pair");
    const pushState = vi.spyOn(window.history, "pushState");

    navigateToDestination("agents");

    expect(pushState).toHaveBeenCalledWith({ operation: "keep" }, "", "/app/agents?session=session-42#pair");
    expect(window.location.pathname).toBe("/app/agents");
    expect(window.location.search).toBe("?session=session-42");
    expect(window.location.hash).toBe("#pair");
  });

  it("reads the current destination and reports browser back/forward changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToDestinationChanges(listener);

    window.history.pushState({}, "", "/app/automations?session=session-7#pair");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(currentAppDestination()).toBe("automations");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("automations");

    unsubscribe();
    window.history.pushState({}, "", "/app/agents");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(listener).toHaveBeenCalledOnce();
  });
});
