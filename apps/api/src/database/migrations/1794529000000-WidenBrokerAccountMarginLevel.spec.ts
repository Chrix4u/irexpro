import type { QueryRunner } from 'typeorm';
import { WidenBrokerAccountMarginLevel1794529000000 } from './1794529000000-WidenBrokerAccountMarginLevel';

describe('broker margin-level decimal precision incident regression', () => {
  it('widens the legacy account projection to match authoritative snapshots', async () => {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (query: string) => { sql.push(query); return []; }),
    } as unknown as QueryRunner;
    const migration = new WidenBrokerAccountMarginLevel1794529000000();
    await migration.up(queryRunner);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('ALTER TABLE broker.broker_accounts');
    expect(sql[0]).toContain('margin_level TYPE numeric(20,8)');
    expect(sql[0]).not.toContain('UPDATE broker.');
  });

  it('guards rollback against 3.5-million-percent actual margin-level evidence', async () => {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (query: string) => { sql.push(query); return []; }),
    } as unknown as QueryRunner;
    const migration = new WidenBrokerAccountMarginLevel1794529000000();
    await migration.down(queryRunner);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('margin_level >= 1000000');
    expect(sql[0]).toContain('RAISE EXCEPTION');
    expect(sql[1]).toContain('margin_level TYPE numeric(10,4)');
  });
});
