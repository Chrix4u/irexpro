/**
 * Round 7 (P1 — durable kill-switch flatten): the queue/job name constants
 * live in this LEAF file so the producer (imported by execution.service.ts)
 * never imports the worker job (which imports ExecutionService back) — that
 * cycle leaves ExecutionService's constructor-param design metadata
 * undefined at decoration time and breaks the full-graph DI compile
 * (bootstrap.spec: "Nest can't resolve dependencies of the
 * EmergencyFlattenJob (?)"). The trade-reconciliation pair avoids the same
 * shape only because its worker does not depend on a service that depends on
 * its producer.
 */
export const EMERGENCY_FLATTEN_QUEUE = 'emergency-flatten';
export const EMERGENCY_FLATTEN_JOB = 'emergency-flatten-user';
