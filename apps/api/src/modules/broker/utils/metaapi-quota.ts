export const METAAPI_PROVIDER_QUOTA_COOLDOWN_MS = 30 * 60_000;

export function isMetaApiQuotaError(error: unknown): boolean {
  const message = (error as Error)?.message?.toLowerCase?.() ?? String(error).toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('rate-limit') ||
    message.includes('too many requests') ||
    message.includes('cpu credits') ||
    message.includes('quota') ||
    message.includes('429')
  );
}
