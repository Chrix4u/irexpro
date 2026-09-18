export type MobileResetIntent =
  | { kind: 'email-token'; token: string }
  | { kind: 'phone-code'; identifier: string }
  | null;

export function parsePasswordResetDeepLink(url: string | null | undefined): MobileResetIntent {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.host.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');

  const isCustomScheme =
    protocol === 'irexpro:' &&
    (host === 'reset-password' || path === '/reset-password');

  if (!isCustomScheme) return null;

  const token = parsed.searchParams.get('token')?.trim() ?? '';
  if (!token || token.length > 512) return null;

  return { kind: 'email-token', token };
}

export function isValidResetPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    password.length <= 128 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

export function isValidPhoneResetCode(code: string): boolean {
  return /^\d{6}$/.test(code.trim());
}
