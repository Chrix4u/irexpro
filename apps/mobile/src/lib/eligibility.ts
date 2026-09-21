/**
 * Mobile eligibility/KYC client (production-LIVE completion round — audit P8:
 * "no KYC status surface").
 *
 * Reuses the SAME shared `createEligibilityApi` the web profile/onboarding
 * pages consume (GET /users/me/eligibility with frontend-safe contract
 * verification) — never a third independent client. Read-only usage: the
 * Account hub renders the KYC/jurisdiction/disclosures truth; submission and
 * reviews stay on the web workspace / admin surfaces.
 */
import {
  createEligibilityApi,
  type EligibilityApi,
} from "@irexpro/api-client/eligibility";
import { api } from "./api";

export const eligibility: EligibilityApi = createEligibilityApi(api);
