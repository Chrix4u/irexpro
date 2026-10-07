/**
 * Mobile execution-read client.
 *
 * Reuses the shared execution contract so Android/iOS and web consume the
 * same server-authoritative open/recent/closed execution endpoints.
 */
import {
  createExecutionApi,
  type ExecutionApi,
} from "@irexpro/api-client/execution";
import { api } from "./api";

export const execution: ExecutionApi = createExecutionApi(api);
