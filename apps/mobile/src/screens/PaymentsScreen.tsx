import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { PaymentProviderInfo } from '@irexpro/types';
import {
  ActionButton,
  ActionDialog,
  Banner,
  Card,
  SectionHeader,
  SkeletonBlock,
  StatusPill,
  palette,
} from '../components/ui';
import {
  api,
  type PerformanceFeeInvoiceView,
  type PerformanceFeeSummaryView,
} from '../lib/api';

function currencyMinorDigits(currency: string): number {
  const upper = currency.toUpperCase();
  if (['JPY', 'KRW'].includes(upper)) return 0;
  if (['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(upper)) return 3;
  return 2;
}

function formatMinor(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount == null || !currency) return '—';
  try {
    const value = BigInt(amount);
    const digits = currencyMinorDigits(currency);
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    if (digits === 0) return `${negative ? '-' : ''}${absolute.toString()} ${currency}`;
    const base = 10n ** BigInt(digits);
    const major = absolute / base;
    const minor = (absolute % base).toString().padStart(digits, '0');
    return `${negative ? '-' : ''}${major.toString()}.${minor} ${currency}`;
  } catch {
    return '—';
  }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function invoiceTone(status: PerformanceFeeInvoiceView['status']) {
  if (status === 'PAID') return 'positive' as const;
  if (status === 'OVERDUE') return 'danger' as const;
  if (status === 'ISSUED') return 'warning' as const;
  return 'neutral' as const;
}

export default function PaymentsScreen() {
  const [summary, setSummary] = useState<PerformanceFeeSummaryView | null>(null);
  const [invoices, setInvoices] = useState<PerformanceFeeInvoiceView[]>([]);
  const [providers, setProviders] = useState<PaymentProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<PerformanceFeeInvoiceView | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutStatus, setCheckoutStatus] = useState<
    { tone: 'success' | 'error' | 'info'; message: string } | null
  >(null);

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const [nextSummary, nextInvoices, nextProviders] = await Promise.all([
        api.getPerformanceFeeSummary(),
        api.listPerformanceFeeInvoices(),
        api.listPaymentProviders(),
      ]);
      setSummary(nextSummary);
      setInvoices(nextInvoices);
      setProviders(nextProviders);
    } catch {
      setError('Fees and payment information could not be loaded. Pull to refresh or try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const liveProviders = useMemo(() => providers.filter((provider) => provider.isLive), [providers]);
  const performance = summary?.performance ?? null;
  const latestAssessment = summary?.assessments?.[0] ?? null;
  const payableInvoices = useMemo(
    () => invoices.filter((invoice) => invoice.status === 'ISSUED' || invoice.status === 'OVERDUE'),
    [invoices],
  );

  async function confirmCheckout(): Promise<void> {
    if (!checkoutTarget || checkoutBusy) return;
    setCheckoutBusy(true);
    setCheckoutStatus(null);
    try {
      const result = await api.checkoutPerformanceFeeInvoice(checkoutTarget.invoiceId);
      if (!result.checkoutUrl) {
        setCheckoutStatus({
          tone: 'info',
          message: 'The payment session was created, but the provider did not return a browser checkout link.',
        });
        await load(true);
        return;
      }
      const supported = await Linking.canOpenURL(result.checkoutUrl);
      if (!supported) {
        setCheckoutStatus({
          tone: 'error',
          message: 'The provider checkout link cannot be opened on this device.',
        });
        return;
      }
      setCheckoutStatus({
        tone: 'success',
        message: `Secure checkout is opening with ${result.provider}. Payment remains pending until the server verifies the provider webhook.`,
      });
      await Linking.openURL(result.checkoutUrl);
      setCheckoutTarget(null);
      await load(true);
    } catch {
      setCheckoutStatus({
        tone: 'error',
        message:
          liveProviders.length === 0
            ? 'Online fee payment is not enabled yet. Your invoice remains unchanged.'
            : 'Checkout could not be started. No fee was marked paid; please retry.',
      });
    } finally {
      setCheckoutBusy(false);
    }
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor={palette.accent}
          />
        }
      >
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>BILLING & SETTLEMENT</Text>
          <Text style={styles.title}>Fees & Payments</Text>
          <Text style={styles.subtitle}>
            iRexPro uses a performance-fee model. Fees apply only to qualifying
            realised profit above the high-water mark. Deposits, paper trading,
            demo results and unrealised P&amp;L are not charged.
          </Text>
        </View>

        {error ? <Banner variant="error">{error}</Banner> : null}

        {loading ? (
          <>
            <Card>
              <SkeletonBlock height={22} />
              <SkeletonBlock height={46} style={styles.skeletonGap} />
            </Card>
            <Card>
              <SkeletonBlock height={22} />
              <SkeletonBlock height={72} style={styles.skeletonGap} />
            </Card>
          </>
        ) : (
          <>
            <View style={styles.metricsGrid}>
              <Card style={styles.metricCard}>
                <Text style={styles.metricLabel}>High-water mark</Text>
                <Text style={styles.metricValue}>
                  {formatMinor(performance?.currentHighWaterMark, performance?.currency)}
                </Text>
                <Text style={styles.metricHint}>Previously fee-settled profit threshold</Text>
              </Card>
              <Card style={styles.metricCard}>
                <Text style={styles.metricLabel}>Realised profit tracked</Text>
                <Text style={styles.metricValue}>
                  {formatMinor(performance?.totalRealisedProfit, performance?.currency)}
                </Text>
                <Text style={styles.metricHint}>Closed LIVE trades only</Text>
              </Card>
              <Card style={styles.metricCard}>
                <Text style={styles.metricLabel}>Fees settled</Text>
                <Text style={styles.metricValue}>
                  {formatMinor(performance?.totalFeesCharged, performance?.currency)}
                </Text>
                <Text style={styles.metricHint}>Webhook-confirmed payments</Text>
              </Card>
              <Card style={styles.metricCard}>
                <Text style={styles.metricLabel}>Current fee rate</Text>
                <Text style={styles.metricValue}>
                  {latestAssessment ? `${Number(latestAssessment.feePercent).toFixed(2)}%` : '—'}
                </Text>
                <Text style={styles.metricHint}>Server policy at assessment time</Text>
              </Card>
            </View>

            <Card>
              <SectionHeader
                title="How the performance fee works"
                description="You are never charged simply because money was deposited or because an open trade is temporarily profitable."
              />
              <View style={styles.explainerList}>
                <Text style={styles.explainer}>1. Only closed LIVE-trade profit is considered.</Text>
                <Text style={styles.explainer}>2. The system compares net realised profit with your high-water mark.</Text>
                <Text style={styles.explainer}>3. A fee is assessed only on new profit above that mark.</Text>
                <Text style={styles.explainer}>4. An invoice is created; there is no automatic broker withdrawal.</Text>
                <Text style={styles.explainer}>5. An invoice becomes paid only after a verified provider webhook.</Text>
              </View>
            </Card>

            <Card>
              <SectionHeader
                title="Payment availability"
                description="Checkout is enabled only when a production payment provider is active."
                right={
                  <StatusPill
                    status={liveProviders.length > 0 ? 'Online payment ready' : 'Checkout not enabled'}
                    tone={liveProviders.length > 0 ? 'positive' : 'warning'}
                  />
                }
              />
              {liveProviders.length > 0 ? (
                <View style={styles.providerList}>
                  {liveProviders.map((provider) => (
                    <View key={provider.id} style={styles.providerRow}>
                      <View style={styles.providerCopy}>
                        <Text style={styles.providerName}>{provider.displayName}</Text>
                        <Text style={styles.providerMeta}>
                          {provider.supportedCurrencies.join(', ')} · production
                        </Text>
                      </View>
                      <StatusPill status="Live" tone="positive" />
                    </View>
                  ))}
                </View>
              ) : (
                <Banner variant="info">
                  No production checkout provider is currently enabled. You can still review
                  fee calculations and invoices; no invoice will be marked paid locally.
                </Banner>
              )}
            </Card>

            <Card>
              <SectionHeader
                title="Outstanding invoices"
                description={
                  payableInvoices.length
                    ? 'Payable performance-fee invoices issued by the server.'
                    : 'There are no performance-fee invoices requiring payment.'
                }
                right={
                  payableInvoices.length ? (
                    <StatusPill status={`${payableInvoices.length} due`} tone="warning" />
                  ) : (
                    <StatusPill status="Clear" tone="positive" />
                  )
                }
              />
              {payableInvoices.map((invoice) => (
                <View key={invoice.invoiceId} style={styles.invoice}>
                  <View style={styles.invoiceHead}>
                    <View style={styles.providerCopy}>
                      <Text style={styles.invoiceNumber}>{invoice.invoiceNumber}</Text>
                      <Text style={styles.providerMeta}>Issued {formatDate(invoice.createdAt)}</Text>
                    </View>
                    <StatusPill status={invoice.status} tone={invoiceTone(invoice.status)} />
                  </View>
                  <Text style={styles.invoiceAmount}>
                    {formatMinor(invoice.totalAmount, invoice.currency)}
                  </Text>
                  <View style={styles.invoiceMetaGrid}>
                    <Text style={styles.invoiceMeta}>Due: {formatDate(invoice.dueDate)}</Text>
                    <Text style={styles.invoiceMeta}>Payment: {invoice.paymentStatus}</Text>
                    <Text style={styles.invoiceMeta}>
                      Provider: {invoice.provider ?? 'Not selected'}
                    </Text>
                  </View>
                  <ActionButton
                    label={invoice.paymentStatus === 'PROCESSING' ? 'Continue secure payment' : 'Pay securely'}
                    disabled={liveProviders.length === 0}
                    onPress={() => {
                      setCheckoutStatus(null);
                      setCheckoutTarget(invoice);
                    }}
                  />
                </View>
              ))}
            </Card>

            <Card>
              <SectionHeader
                title="Recent fee assessments"
                description="Server-calculated fee periods. Amounts are stored in minor currency units and displayed here in normal currency."
              />
              {(summary?.assessments ?? []).length === 0 ? (
                <Text style={styles.emptyText}>No performance-fee assessment has been created yet.</Text>
              ) : (
                summary!.assessments.slice(0, 5).map((assessment) => (
                  <View key={assessment.id} style={styles.assessmentRow}>
                    <View style={styles.providerCopy}>
                      <Text style={styles.providerName}>
                        {formatDate(assessment.periodStart)} – {formatDate(assessment.periodEnd)}
                      </Text>
                      <Text style={styles.providerMeta}>
                        Fee basis {formatMinor(assessment.realisedProfitForFee, assessment.currency)}
                        {' · '}
                        {Number(assessment.feePercent).toFixed(2)}%
                      </Text>
                    </View>
                    <View style={styles.assessmentAmountWrap}>
                      <Text style={styles.assessmentAmount}>
                        {formatMinor(assessment.feeAmount, assessment.currency)}
                      </Text>
                      <StatusPill
                        status={assessment.status}
                        tone={
                          assessment.status === 'PAID'
                            ? 'positive'
                            : assessment.status === 'INVOICED'
                              ? 'warning'
                              : 'neutral'
                        }
                      />
                    </View>
                  </View>
                ))
              )}
            </Card>

            <Card>
              <SectionHeader title="Payment history" description="Newest invoices first." />
              {invoices.length === 0 ? (
                <Text style={styles.emptyText}>No performance-fee invoices yet.</Text>
              ) : (
                invoices.slice(0, 10).map((invoice) => (
                  <View key={invoice.invoiceId} style={styles.historyRow}>
                    <View style={styles.providerCopy}>
                      <Text style={styles.providerName}>{invoice.invoiceNumber}</Text>
                      <Text style={styles.providerMeta}>
                        {formatDate(invoice.createdAt)} · {invoice.paymentStatus}
                      </Text>
                    </View>
                    <View style={styles.historyAmountWrap}>
                      <Text style={styles.historyAmount}>
                        {formatMinor(invoice.totalAmount, invoice.currency)}
                      </Text>
                      <StatusPill status={invoice.status} tone={invoiceTone(invoice.status)} />
                    </View>
                  </View>
                ))
              )}
            </Card>

            <ActionButton
              label="Refresh payment status"
              secondary
              busy={refreshing}
              busyLabel="Refreshing…"
              onPress={() => void load(true)}
            />
          </>
        )}
      </ScrollView>

      <ActionDialog
        visible={checkoutTarget != null}
        kicker="PERFORMANCE FEE"
        title="Open secure checkout?"
        message={
          checkoutTarget
            ? `You are about to pay invoice ${checkoutTarget.invoiceNumber} for ${formatMinor(
                checkoutTarget.totalAmount,
                checkoutTarget.currency,
              )}. The invoice will remain unpaid until iRexPro receives and verifies the provider webhook.`
            : ''
        }
        detailLines={[
          'No funds are withdrawn from your broker account by this action.',
          'The browser redirect alone never marks the invoice as paid.',
          'You can return here and refresh the payment status after checkout.',
        ]}
        confirmLabel="Open checkout"
        onConfirm={() => void confirmCheckout()}
        onCancel={() => {
          if (checkoutBusy) return;
          setCheckoutTarget(null);
          setCheckoutStatus(null);
        }}
        busy={checkoutBusy}
        status={checkoutStatus}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 18, paddingBottom: 32 },
  hero: { marginTop: 6, marginBottom: 16 },
  eyebrow: {
    color: palette.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
    marginBottom: 7,
  },
  title: { fontSize: 28, fontWeight: '900', color: palette.text, marginBottom: 8 },
  subtitle: { color: palette.bodySoft, fontSize: 14, lineHeight: 21 },
  skeletonGap: { marginTop: 12 },
  metricsGrid: { gap: 0 },
  metricCard: { marginBottom: 10 },
  metricLabel: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  metricValue: { color: palette.text, fontSize: 23, fontWeight: '900', marginTop: 6 },
  metricHint: { color: palette.helper, fontSize: 11, lineHeight: 16, marginTop: 4 },
  explainerList: { gap: 8, marginTop: 14 },
  explainer: { color: palette.bodySoft, fontSize: 13, lineHeight: 19 },
  providerList: { marginTop: 12 },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.cardBorder,
  },
  providerCopy: { flex: 1, minWidth: 0 },
  providerName: { color: palette.text, fontSize: 14, fontWeight: '800' },
  providerMeta: { color: palette.muted, fontSize: 11, lineHeight: 17, marginTop: 3 },
  invoice: {
    marginTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.cardBorder,
    paddingTop: 14,
  },
  invoiceHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  invoiceNumber: { color: palette.text, fontSize: 15, fontWeight: '900' },
  invoiceAmount: { color: palette.text, fontSize: 24, fontWeight: '900', marginTop: 12 },
  invoiceMetaGrid: { gap: 4, marginTop: 8 },
  invoiceMeta: { color: palette.muted, fontSize: 12 },
  assessmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.cardBorder,
  },
  assessmentAmountWrap: { alignItems: 'flex-end', gap: 6 },
  assessmentAmount: { color: palette.text, fontSize: 13, fontWeight: '800' },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.cardBorder,
  },
  historyAmountWrap: { alignItems: 'flex-end', gap: 6 },
  historyAmount: { color: palette.text, fontSize: 13, fontWeight: '800' },
  emptyText: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 12 },
});
