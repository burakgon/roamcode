/**
 * Keep browser zoom gestures out of the full-screen app shell. The viewport declaration covers mobile
 * browsers, while these guards cover WebKit gesture events and trackpad pinch gestures represented as
 * ctrl+wheel. App-owned touch behavior (including terminal two-finger scrollback) remains available.
 */
export function installAppGestureGuards(doc: Document = document): () => void {
  const listenerOptions: AddEventListenerOptions = { capture: true, passive: false };
  const preventGesture = (event: Event): void => {
    if (event.cancelable) event.preventDefault();
  };
  const preventPinchWheel = (event: WheelEvent): void => {
    if (event.ctrlKey && event.cancelable) event.preventDefault();
  };

  doc.addEventListener("gesturestart", preventGesture, listenerOptions);
  doc.addEventListener("gesturechange", preventGesture, listenerOptions);
  doc.addEventListener("gestureend", preventGesture, listenerOptions);
  doc.addEventListener("wheel", preventPinchWheel, listenerOptions);

  return () => {
    doc.removeEventListener("gesturestart", preventGesture, listenerOptions);
    doc.removeEventListener("gesturechange", preventGesture, listenerOptions);
    doc.removeEventListener("gestureend", preventGesture, listenerOptions);
    doc.removeEventListener("wheel", preventPinchWheel, listenerOptions);
  };
}
