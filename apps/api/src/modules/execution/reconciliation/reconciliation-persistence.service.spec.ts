import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationDiscrepancyType } from './reconciliation.enums';

describe('ReconciliationPersistenceService stale unknown provider positions', () => {
  it('resolves only UNKNOWN_PROVIDER_POSITION refs absent from a complete provider snapshot', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        [
          {
            id: 'disc-stale',
            discrepancy_type: ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
            internal_ref_id: null,
            provider_ref: 'stale-position',
          },
        ],
        1,
      ]);
    const dataSource = {
      transaction: jest.fn(async (fn: (manager: { query: jest.Mock }) => Promise<void>) =>
        fn({ query }),
      ),
    } as any;
    const service = new ReconciliationPersistenceService({} as any, {} as any, dataSource);
    const snapshotStartedAt = new Date('2026-10-10T10:00:00.000Z');

    const resolved = await service.resolveAbsentUnknownProviderPositions(
      'connection-1',
      ['still-open-position'],
      snapshotStartedAt,
    );

    expect(resolved).toEqual([
      {
        id: 'disc-stale',
        type: ReconciliationDiscrepancyType.UNKNOWN_PROVIDER_POSITION,
        internalRefId: null,
        providerRef: 'stale-position',
      },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("discrepancy_type = 'UNKNOWN_PROVIDER_POSITION'");
    expect(query.mock.calls[1][0]).toContain("status = 'OPEN'");
    expect(query.mock.calls[1][0]).toContain('provider_ref <> ALL');
    expect(query.mock.calls[1][0]).toContain('last_seen_at < $3');
    expect(query.mock.calls[1][1]).toEqual([
      'connection-1',
      ['still-open-position'],
      snapshotStartedAt,
    ]);
  });

  it('keeps all current unknown provider positions open when every ref is still present', async () => {
    const query = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce([[], 0]);
    const dataSource = {
      transaction: jest.fn(async (fn: (manager: { query: jest.Mock }) => Promise<void>) =>
        fn({ query }),
      ),
    } as any;
    const service = new ReconciliationPersistenceService({} as any, {} as any, dataSource);

    await expect(
      service.resolveAbsentUnknownProviderPositions(
        'connection-1',
        ['provider-position-1'],
        new Date('2026-10-10T10:00:00.000Z'),
      ),
    ).resolves.toEqual([]);
  });
});
