/**
 * Mobile execution client (October UAT hardening — WS1-MOBILE).
 *
 * Reuses the SAME shared `createExecutionApi` the web consumes (never a
 * third independent client), layered on the mobile `api` transport from
 * `src/lib/api.ts`. The single-position manual close is the only write this
 * surface performs: it routes through the server execution domain
 * (ownership checks, orchestrator gates, exactly-once close attempts,
 * reconciliation for unknown provider outcomes) — never a direct provider
 * call from the device.
 */
import {
  createExecutionApi,
  type ExecutionApi,
} from "@irexpro/api-client/execution";
import { api } from "./api";

export const execution: ExecutionApi = createExecutionApi(api);
