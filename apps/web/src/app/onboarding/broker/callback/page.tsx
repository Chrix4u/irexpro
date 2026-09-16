import BrokerOAuthCallbackClient from './callback-client';

interface BrokerOAuthCallbackPageProps {
  searchParams: Promise<{
    code?: string | string[];
  }>;
}

/**
 * cTrader OAuth callback landing page (Sprint 56 correction round 1 /
 * audit point 6).
 *
 * Spotware redirects the user's browser here after the cTrader ID consent
 * screen, carrying the single-use authorization code as `?code=…` (cTrader's
 * OAuth supports no state parameter — server-side flowId correlation handles
 * it; the flowId was stashed in sessionStorage before the redirect).
 */
export default async function BrokerOAuthCallbackPage({
  searchParams,
}: BrokerOAuthCallbackPageProps) {
  const params = await searchParams;
  const code = Array.isArray(params.code) ? params.code[0] : params.code;

  return <BrokerOAuthCallbackClient code={code ?? null} />;
}
