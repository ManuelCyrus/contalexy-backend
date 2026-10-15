/// O que se consegue dizer de um aparelho pelo "user agent" — o suficiente
/// para a pessoa reconhecer onde a conta foi usada ("app · Android").
export interface DeviceInfo {
  /// "app" (a app Contalexy) | "Chrome" | "Safari" | "Firefox" | "Edge" | null
  client: string | null;
  /// "Android" | "iOS" | "macOS" | "Windows" | "Linux" | null
  os: string | null;
}

export function deviceInfo(userAgent?: string | null): DeviceInfo {
  const ua = userAgent ?? '';
  if (!ua) return { client: null, os: null };
  const os = /android/i.test(ua)
    ? 'Android'
    : /iphone|ipad|ipod|\bios\b/i.test(ua)
      ? 'iOS'
      : /mac os|macos|macintosh|darwin/i.test(ua)
        ? 'macOS'
        : /windows/i.test(ua)
          ? 'Windows'
          : /linux/i.test(ua)
            ? 'Linux'
            : null;
  const client = /contalexy?\//i.test(ua) || /\bdart\//i.test(ua)
    ? 'app'
    : /edg\//i.test(ua)
      ? 'Edge'
      : /firefox\//i.test(ua)
        ? 'Firefox'
        : /chrome\//i.test(ua)
          ? 'Chrome'
          : /safari\//i.test(ua)
            ? 'Safari'
            : null;
  return { client, os };
}
