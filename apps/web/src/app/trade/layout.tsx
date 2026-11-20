/**
 * Never prerender or long-cache the operator's trading cockpit shell.
 * The instrument tabs, trading-session authority, and AI monitoring state
 * change independently of release cycles; a previously static /trade HTML
 * response advertised a 1-year s-maxage and kept obsolete six-pair UI alive.
 * This segment is a SERVER layout so Next can apply route cache policy even
 * though the interactive trading page itself is a client component.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function TradingCockpitLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
