import {
  isValidPhoneResetCode,
  isValidResetPassword,
  parsePasswordResetDeepLink,
} from '../password-recovery.logic';

describe('mobile password recovery logic', () => {
  it('accepts the iRexPro reset-password deep link with a bounded token', () => {
    expect(
      parsePasswordResetDeepLink('irexpro://reset-password?token=abc123'),
    ).toEqual({ kind: 'email-token', token: 'abc123' });
  });

  it('rejects unrelated or malformed deep links', () => {
    expect(parsePasswordResetDeepLink('irexpro://broker-oauth?token=abc')).toBeNull();
    expect(parsePasswordResetDeepLink('https://example.com/reset-password?token=abc')).toBeNull();
    expect(parsePasswordResetDeepLink('not a url')).toBeNull();
    expect(parsePasswordResetDeepLink(null)).toBeNull();
  });

  it('rejects missing and oversized reset tokens', () => {
    expect(parsePasswordResetDeepLink('irexpro://reset-password')).toBeNull();
    expect(
      parsePasswordResetDeepLink(
        `irexpro://reset-password?token=${'a'.repeat(513)}`,
      ),
    ).toBeNull();
  });

  it('mirrors the server password requirements', () => {
    expect(isValidResetPassword('StrongPassword123!')).toBe(true);
    expect(isValidResetPassword('short1')).toBe(false);
    expect(isValidResetPassword('123456789012')).toBe(false);
    expect(isValidResetPassword('abcdefghijkl')).toBe(false);
  });

  it('requires exactly six numeric digits for phone reset codes', () => {
    expect(isValidPhoneResetCode('123456')).toBe(true);
    expect(isValidPhoneResetCode('12345')).toBe(false);
    expect(isValidPhoneResetCode('12345a')).toBe(false);
  });
});
