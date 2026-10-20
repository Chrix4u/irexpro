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
});
