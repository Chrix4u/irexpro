import { AccountDispatchLeaseService } from './account-dispatch-lease.service';

/**
 * AccountDispatchLeaseService (Round 6 §14) — the per-account dispatch
 * serialization lease.
 *
 * Matrix:
 *   - work on the SAME account runs strictly one-at-a-time (no overlap)
 *   - work on DIFFERENT accounts proceeds concurrently
 *   - a rejected critical section releases the lease (later work proceeds)
 *   - the chain self-drains (activeAccountKeys empties once idle)
 *   - the lease tail never rejects (a failed work never wedges the account)
 */

describe('AccountDispatchLeaseService — the §14 per-account dispatch lease', () => {
  let lease: AccountDispatchLeaseService;

  beforeEach(() => {
    lease = new AccountDispatchLeaseService();
  });

  it('serializes work on the SAME account strictly one-at-a-time', async () => {
    const windows: Array<{ start: number; end: number }> = [];
    const work = async (): Promise<string> => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      const end = Date.now();
      windows.push({ start, end });
      return 'done';
    };

    const results = await Promise.all([
      lease.withAccountDispatchLease('conn-1', work),
      lease.withAccountDispatchLease('conn-1', work),
      lease.withAccountDispatchLease('conn-1', work),
    ]);

    expect(results).toEqual(['done', 'done', 'done']);
    expect(windows).toHaveLength(3);
    const ordered = [...windows].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].start).toBeGreaterThanOrEqual(ordered[i - 1].end);
    }
  });

  it('runs work on DIFFERENT accounts concurrently (no global lock)', async () => {
    const order: string[] = [];
    const work = (key: string) => async (): Promise<string> => {
      order.push(`start:${key}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${key}`);
      return key;
    };

    await Promise.all([
      lease.withAccountDispatchLease('conn-A', work('A')),
      lease.withAccountDispatchLease('conn-B', work('B')),
    ]);

    // B started before A ended → concurrent across accounts.
    expect(order.indexOf('start:B')).toBeLessThan(order.indexOf('end:A'));
  });

  it('releases the lease when the critical section REJECTS (later work proceeds)', async () => {
    const first = lease.withAccountDispatchLease('conn-1', async () => {
      throw new Error('provider exploded');
    });
    await expect(first).rejects.toThrow('provider exploded');

    const second = await lease.withAccountDispatchLease('conn-1', async () => 'recovered');
    expect(second).toBe('recovered');
  });

  it('propagates the critical section value', async () => {
    const value = await lease.withAccountDispatchLease('conn-1', async () => ({
      outcome: 'FILLED',
    }));
    expect(value).toEqual({ outcome: 'FILLED' });
  });

  it('self-drains: no account keys remain once all work settles', async () => {
    await Promise.all([
      lease.withAccountDispatchLease('conn-1', async () => 1),
      lease.withAccountDispatchLease('conn-2', async () => 2),
    ]);
    // Microtask drain for the tail cleanup.
    await new Promise((r) => setTimeout(r, 5));
    expect(lease.activeAccountKeys()).toEqual([]);
  });

  it('a rejected work never wedges the chain tail (subsequent queued work still runs)', async () => {
    const seen: string[] = [];
    const tasks = [
      lease
        .withAccountDispatchLease('conn-1', async () => {
          seen.push('first');
          throw new Error('boom');
        })
        .catch(() => undefined),
      lease.withAccountDispatchLease('conn-1', async () => {
        seen.push('second');
        return 'ok';
      }),
    ];
    await Promise.all(tasks);
    expect(seen).toEqual(['first', 'second']);
  });
});
