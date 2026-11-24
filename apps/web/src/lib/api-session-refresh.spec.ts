describe('browser session refresh single-flight', () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalBaseUrl === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = originalBaseUrl;
  });

  it('coalesces explicit restore and unauthorized recovery into one cookie rotation', async () => {
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = jest.fn(async () => {
      await refreshBlocked;
      return {
        ok: true,
        status: 200,
        json: async () => ({ accessToken: 'fresh-access-token' }),
      } as Response;
    });
    global.fetch = fetchMock as typeof fetch;

    const apiModule = require('./api') as Record<string, unknown>;
    const refreshBrowserSession = apiModule.refreshBrowserSession as
      | (() => Promise<boolean>)
      | undefined;

    expect(typeof refreshBrowserSession).toBe('function');
    const first = refreshBrowserSession!();
    const second = refreshBrowserSession!();
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { accessToken: 'fresh-access-token' },
      { accessToken: 'fresh-access-token' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/auth/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('drains a rejected refresh response before returning signed-out state', async () => {
    const json = jest.fn(async () => {
      throw new SyntaxError('non-JSON error body');
    });
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 404,
      json,
    } as unknown as Response));
    global.fetch = fetchMock as typeof fetch;

    const apiModule = require('./api') as Record<string, unknown>;
    const refreshBrowserSession = apiModule.refreshBrowserSession as
      | (() => Promise<unknown>)
      | undefined;

    expect(typeof refreshBrowserSession).toBe('function');
    await expect(refreshBrowserSession!()).resolves.toBeNull();
    expect(json).toHaveBeenCalledTimes(1);
  });

});

describe('authenticated browser session expiry', () => {
  const previousBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  beforeEach(() => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = previousBase;
  });
  function setup() {
    const client = require('./api') as typeof import('./api');
    client.setAccessToken('old-access');
    const observer = jest.fn();
    client.subscribeBrowserSession(observer);
    return { client, observer };
  }
  it.each([401, 403])('notifies the UI on confirmed refresh refusal %s', async status => {
    const { client, observer } = setup();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) });
    expect(await client.refreshBrowserSession()).toBeNull();
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith({ type: 'expired' });
    await client.verifyBrowserSession();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('updates React subscribers when a valid cookie renews the token', async () => {
    const { client, observer } = setup();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ accessToken: 'renewed' }) });
    expect(await client.refreshBrowserSession()).toEqual({ accessToken: 'renewed' });
    expect(observer).toHaveBeenCalledWith({ type: 'refreshed', accessToken: 'renewed' });
  });
  it('does not falsely expire a session on an outage or HTTP 503', async () => {
    const { client, observer } = setup();
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await client.refreshBrowserSession();
    await client.refreshBrowserSession();
    expect(observer).not.toHaveBeenCalled();
  });
  it('detects expiry during a session check without a page refresh', async () => {
    const { client, observer } = setup();
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ status: 401, text: async () => '' })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await client.verifyBrowserSession();
    expect(observer).toHaveBeenCalledWith({ type: 'expired' });
  });
  it('does not let a stale refresh overwrite a new login', async () => {
    const { client, observer } = setup();
    let release!: (response: unknown) => void;
    global.fetch = jest.fn().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const refresh = client.refreshBrowserSession();
    client.setAccessToken('new-login');
    release({ ok: false, status: 401, json: async () => ({}) });
    await refresh;
    expect(observer).not.toHaveBeenCalled();
  });
});
