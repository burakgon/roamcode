/** Privacy-light label for a paired browser. No full UA, hostname, IP, or unique fingerprint leaves it. */
export function defaultDeviceName(
  nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator,
): string {
  const ua = nav.userAgent ?? "";
  const platform = nav.platform ?? "";
  const kind =
    /iPad/.test(ua) || (/Mac/.test(platform) && nav.maxTouchPoints > 1)
      ? "iPad"
      : /iPhone|iPod/.test(ua)
        ? "iPhone"
        : /Android/.test(ua)
          ? "Android"
          : /Windows/.test(ua) || /Win/.test(platform)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Mac/.test(ua) || /Mac/.test(platform)
                ? "Mac"
                : /Linux/.test(ua) || /Linux/.test(platform)
                  ? "Linux"
                  : "browser";
  return `RoamCode on ${kind}`;
}
