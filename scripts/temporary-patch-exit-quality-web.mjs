import fs from 'node:fs';

function replaceOnce(path, oldText, newText, alreadyText) {
  let source = fs.readFileSync(path, 'utf8');
  if (alreadyText && source.includes(alreadyText)) return false;
  if (!source.includes(oldText)) throw new Error(`Anchor not found in ${path}`);
  source = source.replace(oldText, newText);
  fs.writeFileSync(path, source);
  return true;
}

replaceOnce(
  'apps/web/src/app/trade/history/profit-protection/page.tsx',
  "import { Alert, Button, DashboardShell, LoadingSpinner } from '@/components/ui';\n",
  "import { Alert, Button, DashboardShell, LoadingSpinner } from '@/components/ui';\nimport { useAuth } from '@/context/auth-context';\n",
  "import { useAuth } from '@/context/auth-context';",
);
replaceOnce(
  'apps/web/src/app/trade/history/profit-protection/page.tsx',
  "export default function ProfitProtectionExitQualityPage() {\n  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);",
  "export default function ProfitProtectionExitQualityPage() {\n  const { user, logout, restoring } = useAuth();\n  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);",
  'const { user, logout, restoring } = useAuth();',
);
replaceOnce(
  'apps/web/src/app/trade/history/profit-protection/page.tsx',
  "  const load = useCallback(async () => {\n    setLoading(true);",
  "  const load = useCallback(async () => {\n    if (!user) return;\n    setLoading(true);",
  '    if (!user) return;',
);
replaceOnce(
  'apps/web/src/app/trade/history/profit-protection/page.tsx',
  "  }, [query]);",
  "  }, [query, user]);",
  '  }, [query, user]);',
);
replaceOnce(
  'apps/web/src/app/trade/history/profit-protection/page.tsx',
  "  const summary = report?.summary;\n\n  return (\n    <DashboardShell>",
  "  if (restoring) {\n    return <div style={{ padding: '3rem' }}><LoadingSpinner text=\"Restoring exit-quality report…\" /></div>;\n  }\n\n  if (!user) {\n    return (\n      <div style={{ padding: '3rem', maxWidth: 680, margin: '0 auto' }}>\n        <p>Sign in to view Profit Protection exit-quality research.</p>\n        <Link href=\"/login\" className=\"btn btn--primary mt-4\">Go to login</Link>\n      </div>\n    );\n  }\n\n  const summary = report?.summary;\n\n  return (\n    <DashboardShell user={user} onLogout={logout} activeRoute=\"/trade/history\" title=\"Reports\">",
  '<DashboardShell user={user} onLogout={logout}',
);
replaceOnce(
  'apps/web/src/app/trade/history/profit-protection/page.spec.tsx',
  "jest.mock('@/components/ui', () => ({\n",
  "jest.mock('@/context/auth-context', () => ({\n  useAuth: () => ({ user: { id: 'user-1' }, logout: jest.fn(), restoring: false }),\n}));\n\njest.mock('@/components/ui', () => ({\n",
  "jest.mock('@/context/auth-context'",
);
replaceOnce(
  'apps/web/src/app/trade/history/page.tsx',
  '            <Link href="/trade" className="btn btn--ghost btn--sm">Back to AI Trading</Link>',
  '            <Link href="/trade/history/profit-protection" className="btn btn--secondary btn--sm">\n              Profit Protection Exit Quality\n            </Link>\n            <Link href="/trade" className="btn btn--ghost btn--sm">Back to AI Trading</Link>',
  'href="/trade/history/profit-protection"',
);
