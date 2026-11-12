import { AiTraderLoading } from "./ai-trader-loading";

// Next.js route-transition fallback, before the client terminal API initializes.
export default function Loading() {
  return <AiTraderLoading />;
}
