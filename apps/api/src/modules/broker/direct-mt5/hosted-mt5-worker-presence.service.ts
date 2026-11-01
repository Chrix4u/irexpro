import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

const WORKER_FRESH_MS = 45_000;
const WORKER_REFRESH_MS = 10_000;

export interface HostedMt5WorkerPresenceInput {
  workerVersion: string;
  runtimeReady: boolean;
  maxSessions: number;
  activeSessions: number;
}

export type HostedMt5WorkerPoolReason =
  | 'READY'
  | 'NO_FRESH_WORKER'
  | 'NO_READY_WORKER'
  | 'NO_CAPACITY';

export interface HostedMt5WorkerPoolReadiness {
  ready: boolean;
  reason: HostedMt5WorkerPoolReason;
  freshWorkers: number;
  readyWorkers: number;
  availableWorkers: number;
  totalSpareSessions: number;
}

type WorkerPresence = HostedMt5WorkerPresenceInput & {
  workerId: string;
  lastSeenAtMs: number;
};

type WorkerPresenceRow = {
  worker_id: string;
  worker_version: string;
  runtime_ready: boolean;
  max_sessions: number;
  active_sessions: number;
  last_seen_at: Date | string;
};

@Injectable()
export class HostedMt5WorkerPresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly workers = new Map<string, WorkerPresence>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refreshFromDatabase();
    } catch {
      // Hosted readiness is an optional execution surface. If presence hydration
      // fails during API boot, stay fail-closed until a worker heartbeats again.
      this.workers.clear();
    }
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refreshFromDatabase().catch(() => {
        // Preserve the last in-memory snapshot; freshness still expires it
        // fail-closed if PostgreSQL remains unavailable.
      });
    }, WORKER_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async heartbeat(
    workerId: string,
    input: HostedMt5WorkerPresenceInput,
  ): Promise<{ workerId: string; accepted: true }> {
    this.validate(workerId, input);
    await this.dataSource.query(
      `
        INSERT INTO broker.hosted_mt5_workers (
          worker_id, worker_version, runtime_ready, max_sessions, active_sessions,
          last_seen_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, now(), now(), now())
        ON CONFLICT (worker_id) DO UPDATE SET
          worker_version = EXCLUDED.worker_version,
          runtime_ready = EXCLUDED.runtime_ready,
          max_sessions = EXCLUDED.max_sessions,
          active_sessions = EXCLUDED.active_sessions,
          last_seen_at = now(),
          updated_at = now()
      `,
      [workerId, input.workerVersion, input.runtimeReady, input.maxSessions, input.activeSessions],
    );
    this.workers.set(workerId, { ...input, workerId, lastSeenAtMs: Date.now() });
    return { workerId, accepted: true };
  }

  async refreshFromDatabase(): Promise<void> {
    const rows = (await this.dataSource.query(
      `
        SELECT worker_id, worker_version, runtime_ready, max_sessions, active_sessions, last_seen_at
        FROM broker.hosted_mt5_workers
        WHERE last_seen_at >= now() - interval '5 minutes'
      `,
    )) as WorkerPresenceRow[];
    this.workers.clear();
    for (const row of rows) {
      const lastSeenAtMs = new Date(row.last_seen_at).getTime();
      if (!Number.isFinite(lastSeenAtMs)) continue;
      this.workers.set(row.worker_id, {
        workerId: row.worker_id,
        workerVersion: row.worker_version,
        runtimeReady: row.runtime_ready,
        maxSessions: row.max_sessions,
        activeSessions: row.active_sessions,
        lastSeenAtMs,
      });
    }
  }

  getPoolReadiness(nowMs = Date.now()): HostedMt5WorkerPoolReadiness {
    const fresh = [...this.workers.values()].filter(
      (worker) =>
        nowMs - worker.lastSeenAtMs <= WORKER_FRESH_MS && nowMs >= worker.lastSeenAtMs - 5_000,
    );
    if (fresh.length === 0) {
      return this.snapshot(false, 'NO_FRESH_WORKER', fresh, []);
    }
    const ready = fresh.filter((worker) => worker.runtimeReady);
    if (ready.length === 0) {
      return this.snapshot(false, 'NO_READY_WORKER', fresh, ready);
    }
    const available = ready.filter((worker) => worker.activeSessions < worker.maxSessions);
    if (available.length === 0) {
      return this.snapshot(false, 'NO_CAPACITY', fresh, ready);
    }
    return this.snapshot(true, 'READY', fresh, ready);
  }

  private snapshot(
    isReady: boolean,
    reason: HostedMt5WorkerPoolReason,
    fresh: WorkerPresence[],
    ready: WorkerPresence[],
  ): HostedMt5WorkerPoolReadiness {
    const available = ready.filter((worker) => worker.activeSessions < worker.maxSessions);
    return {
      ready: isReady,
      reason,
      freshWorkers: fresh.length,
      readyWorkers: ready.length,
      availableWorkers: available.length,
      totalSpareSessions: available.reduce(
        (sum, worker) => sum + (worker.maxSessions - worker.activeSessions),
        0,
      ),
    };
  }

  private validate(workerId: string, input: HostedMt5WorkerPresenceInput): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workerId)) {
      throw new BadRequestException('Hosted MT5 worker id is invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/.test(input.workerVersion)) {
      throw new BadRequestException('Hosted MT5 worker version is invalid');
    }
    if (
      !Number.isInteger(input.maxSessions) ||
      input.maxSessions < 1 ||
      input.maxSessions > 256 ||
      !Number.isInteger(input.activeSessions) ||
      input.activeSessions < 0 ||
      input.activeSessions > input.maxSessions
    ) {
      throw new BadRequestException('Hosted MT5 worker capacity is invalid');
    }
  }
}
