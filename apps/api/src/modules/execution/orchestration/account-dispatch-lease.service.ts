import { Injectable } from '@nestjs/common';

/**
 * AccountDispatchLeaseService (Round 6 live-execution completion §14) — the
 * per-account dispatch serialization lease.
 *
 * MANDATE: every provider-bound dispatch against ONE broker account (the
 * brokerConnectionId — the per-user stable account identity) runs through a
 * strictly serialized critical section. An entry (executeTrade), an AI exit
 * (§10 closeTrade), a SEMI_AUTO confirmation dispatch, and a reconciliation
 * repair can never interleave their reservation → gates → commitment →
 * provider-call chains on the SAME account: each awaits its predecessor
 * before running.
 *
 * CONCURRENCY MODEL (mirrors the BrokerAccountSnapshotService write lease):
 *   - IN-PROCESS tail-promise chain per account key — overlapping callers
 *     await their predecessor; the chain entry self-drains once idle so the
 *     map never grows without bound.
 *   - The lease does NOT replace the durable exactly-once surfaces — it
 *     complements them:
 *       · pg_advisory_xact_lock (order reservation, trade slot) guards the
 *         DB writes;
 *       · clientOrderId idempotency + unique indexes guard cross-PROCESS
 *         duplicates (two API replicas);
 *       · CAS discipline guards every state transition.
 *     The lease closes the remaining in-process gap: two dispatches on the
 *     same account racing the full critical section inside one replica.
 *   - Different accounts proceed concurrently (no global lock).
 *   - A rejected critical section releases the lease normally (finally) —
 *     one failed dispatch can never wedge an account.
 */
@Injectable()
export class AccountDispatchLeaseService {
  /** In-process per-account dispatch lease (tail promise chain per key). */
  private readonly accountChains = new Map<string, Promise<void>>();

  /**
   * Run `critical` under the account's dispatch lease. Resolves with
   * critical's value or rejects with its error — the lease is ALWAYS
   * released (finally), and the chain tail never rejects.
   */
  async withAccountDispatchLease<T>(
    accountKey: string,
    critical: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.accountChains.get(accountKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor ? predecessor.then(() => gate) : gate;
    this.accountChains.set(accountKey, tail);
    void tail.then(() => {
      if (this.accountChains.get(accountKey) === tail) {
        this.accountChains.delete(accountKey);
      }
    });

    try {
      if (predecessor) await predecessor;
      return await critical();
    } finally {
      release();
    }
  }

  /** Test/observability seam: active account keys currently holding chains. */
  activeAccountKeys(): string[] {
    return [...this.accountChains.keys()];
  }
}
