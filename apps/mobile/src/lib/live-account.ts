/**
 * Mobile Live Account client (Sprint 51 PR-8 — Directive §AX M7/M8).
 *
 * Reuses the SAME shared `createLiveAccountApi` the web dashboard consumes
 * (Directive §AV: shared API contracts — never a third independent client),
 * layered on the mobile `api` transport from `src/lib/api.ts`.
 */
import { createLiveAccountApi, type LiveAccountApi } from "@irexpro/api-client";
import { api } from "./api";

export const liveAccount: LiveAccountApi = createLiveAccountApi(api);
