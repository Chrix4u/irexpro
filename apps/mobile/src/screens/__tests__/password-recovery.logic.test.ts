import {
  isValidPhoneResetCode,
  isValidResetPassword,
} from '../password-recovery.logic';

describe('mobile password recovery logic', () => {
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
