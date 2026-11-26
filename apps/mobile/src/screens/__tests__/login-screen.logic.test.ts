import type { AuthTokens, AuthUser } from '@irexpro/types';
import { establishLogin } from '../login-screen.logic';

const tokens = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' } as AuthTokens;
const user = { id: 'synthetic-user' } as AuthUser;
function fixture() {
  return {
    login: jest.fn().mockResolvedValue(tokens),
    me: jest.fn().mockResolvedValue(user),
    setAccessToken: jest.fn(),
    saveTokens: jest.fn().mockResolvedValue(undefined),
    clearTokens: jest.fn().mockResolvedValue(undefined),
  };
}

describe('establishLogin', () => {
  it('validates identity before persisting tokens', async () => {
    const d = fixture();
    await expect(establishLogin(d, '  user@example.invalid  ', ' synthetic ')).resolves.toEqual({
      user, accessToken: tokens.accessToken,
    });
    expect(d.login).toHaveBeenCalledWith({ identifier: 'user@example.invalid', password: ' synthetic ' });
    expect(d.me.mock.invocationCallOrder[0]).toBeLessThan(d.saveTokens.mock.invocationCallOrder[0]);
    expect(d.setAccessToken).toHaveBeenLastCalledWith(tokens.accessToken);
    expect(d.clearTokens).not.toHaveBeenCalled();
  });
  it('refuses empty credentials before making any request', async () => {
    const d = fixture();
    await expect(establishLogin(d, ' ', 'synthetic')).rejects.toThrow('MISSING_CREDENTIALS');
    expect(d.login).not.toHaveBeenCalled();
  });
  it('clears memory and does not persist an unvalidated token', async () => {
    const d = fixture();
    d.me.mockRejectedValue(new Error('identity unavailable'));
    await expect(establishLogin(d, 'user@example.invalid', 'synthetic')).rejects.toThrow('identity unavailable');
    expect(d.setAccessToken).toHaveBeenLastCalledWith(null);
    expect(d.saveTokens).not.toHaveBeenCalled();
  });
  it('attempts cleanup when credential persistence fails', async () => {
    const d = fixture();
    d.saveTokens.mockRejectedValue(new Error('storage unavailable'));
    await expect(establishLogin(d, 'user@example.invalid', 'synthetic')).rejects.toThrow('storage unavailable');
    expect(d.clearTokens).toHaveBeenCalledTimes(1);
    expect(d.setAccessToken).toHaveBeenLastCalledWith(null);
  });
  it('leaves no cached access token after a rejected login', async () => {
    const d = fixture();
    d.login.mockRejectedValue(new Error('login refused'));
    await expect(establishLogin(d, 'user@example.invalid', 'synthetic')).rejects.toThrow('login refused');
    expect(d.setAccessToken).toHaveBeenLastCalledWith(null);
    expect(d.me).not.toHaveBeenCalled();
    expect(d.saveTokens).not.toHaveBeenCalled();
  });
});
