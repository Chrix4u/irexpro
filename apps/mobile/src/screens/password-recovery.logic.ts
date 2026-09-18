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
