"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/auth-context";
import { api } from "@/lib/api";
import { mapApiError } from "@/lib/error-mapping";
import { useNotification } from "@/hooks/useNotification";
import {
  Alert,
  Badge,
  Card,
  DashboardShell,
  LoadingSpinner,
} from "@/components/ui";
import { ConfirmDialog } from "@/components/notifications/ConfirmDialog";

type BillingFrequency = "MONTHLY" | "QUARTERLY" | "ANNUAL" | "ON_PROFIT_EVENT";

interface PerformanceFeePolicyView {
  id: string;
  name: string;
  feePercent: string;
  billingFrequency: BillingFrequency;
  calculationMode: "HIGH_WATER_MARK";
  appliesTo: "REALISED_PROFIT_ONLY";
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  createdAt: string;
}

const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
  ON_PROFIT_EVENT: "On profit event",
};

export default function PerformanceFeeAdminPage() {
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();
  const [policies, setPolicies] = useState<PerformanceFeePolicyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [name, setName] = useState("Global performance fee");
  const [feePercent, setFeePercent] = useState("20");
  const [billingFrequency, setBillingFrequency] =
    useState<BillingFrequency>("MONTHLY");

  const isAdmin =
    user?.roles?.some((role) => role === "ADMIN" || role === "SUPER_ADMIN") ??
    false;
  const activePolicy = useMemo(
    () => policies.find((policy) => policy.isActive) ?? null,
    [policies],
  );

  const loadPolicies = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.request<PerformanceFeePolicyView[]>(
        "/performance-fees/policies",
      );
      setPolicies(result);
      const active = result.find((policy) => policy.isActive);
      if (active) {
        setName(active.name);
        setFeePercent(Number(active.feePercent).toString());
        setBillingFrequency(active.billingFrequency);
      }
    } catch (error) {
      notify.error(mapApiError(error).message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (user && isAdmin) void loadPolicies();
  }, [user, isAdmin, loadPolicies]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const rate = Number(feePercent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      notify.error("Performance fee must be between 0% and 100%.");
      return;
    }
    if (!name.trim()) {
      notify.error("Policy name is required.");
      return;
    }
    setConfirmOpen(true);
  }

  async function savePolicy() {
    setConfirmOpen(false);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        feePercent: Number(feePercent),
        billingFrequency,
      };
      const endpoint = activePolicy
        ? "/performance-fees/policies/replace"
        : "/performance-fees/policies";
      await api.request<PerformanceFeePolicyView>(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      notify.success(
        activePolicy
          ? "Performance fee updated to " + Number(feePercent).toFixed(2) + "%."
          : "Performance fee policy created at " +
              Number(feePercent).toFixed(2) +
              "%.",
      );
      await loadPolicies();
    } catch (error) {
      notify.error(mapApiError(error).message);
    } finally {
      setSaving(false);
    }
  }

  if (restoring) {
    return (
      <div style={{ padding: "3rem" }}>
        <LoadingSpinner text="Restoring session…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: "3rem", maxWidth: 620, margin: "0 auto" }}>
        <Card title="Not signed in">
          <Alert variant="warning">
            Sign in with an owner/admin account to manage performance fees.
          </Alert>
        </Card>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <DashboardShell
        user={user}
        onLogout={logout}
        activeRoute="/admin/performance-fees"
      >
        <main className="workspace-page">
          <Card title="Admin access required">
            <Alert variant="error">
              Only ADMIN or SUPER_ADMIN accounts can change performance-fee
              policy.
            </Alert>
          </Card>
        </main>
      </DashboardShell>
    );
  }

  const proposedRate = Number(feePercent);
  const currentRate = activePolicy ? Number(activePolicy.feePercent) : null;

  return (
    <DashboardShell
      user={user}
      onLogout={logout}
      activeRoute="/admin/performance-fees"
    >
      <main
        className="workspace-page"
        aria-labelledby="performance-fee-admin-title"
      >
        <section className="workspace-hero">
          <div className="workspace-hero__copy">
            <p className="workspace-hero__eyebrow">Owner administration</p>
            <h1
              id="performance-fee-admin-title"
              className="workspace-hero__title"
            >
              Performance fee policy
            </h1>
            <p className="workspace-hero__description">
              Set the fee charged on qualifying realised LIVE-trading profit
              above each account&apos;s high-water mark. Policy changes create a
              new version and never rewrite already calculated assessments.
            </p>
          </div>
          <div className="workspace-hero__actions">
            <Badge variant={activePolicy ? "success" : "warning"}>
              {activePolicy
                ? "Active · v" + activePolicy.version
                : "No active policy"}
            </Badge>
          </div>
        </section>

        <section
          className="workspace-stat-grid"
          aria-label="Performance fee policy summary"
        >
          <Card>
            <h2 className="card__title">Current fee</h2>
            <div className="performance-fee-admin__metric">
              {activePolicy
                ? Number(activePolicy.feePercent).toFixed(2) + "%"
                : "—"}
            </div>
            <p className="text-sm muted">
              Applied only to eligible realised profit above the high-water
              mark.
            </p>
          </Card>
          <Card>
            <h2 className="card__title">Billing frequency</h2>
            <div className="performance-fee-admin__metric performance-fee-admin__metric--text">
              {activePolicy
                ? FREQUENCY_LABELS[activePolicy.billingFrequency]
                : "Not configured"}
            </div>
            <p className="text-sm muted">
              The configured cycle controls when fee assessments are generated.
            </p>
          </Card>
          <Card>
            <h2 className="card__title">Historical safety</h2>
            <div className="performance-fee-admin__metric performance-fee-admin__metric--text">
              Versioned
            </div>
            <p className="text-sm muted">
              Old assessments retain the fee percentage and policy version used
              at calculation time.
            </p>
          </Card>
        </section>

        <Card
          title={
            activePolicy
              ? "Change performance fee"
              : "Create performance fee policy"
          }
          subtitle="Changes take effect for future assessments. Existing assessments are never recalculated."
        >
          <form onSubmit={submit} className="performance-fee-admin__form">
            <label className="form-field">
              <span className="form-label">Policy name</span>
              <input
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
              />
            </label>

            <label className="form-field">
              <span className="form-label">Performance fee (%)</span>
              <input
                className="form-input"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={feePercent}
                onChange={(e) => setFeePercent(e.target.value)}
                required
              />
              <span className="text-sm muted">
                Example: 20 means 20% of qualifying realised profit above the
                high-water mark.
              </span>
            </label>

            <label className="form-field">
              <span className="form-label">Billing frequency</span>
              <select
                className="form-input"
                value={billingFrequency}
                onChange={(e) =>
                  setBillingFrequency(e.target.value as BillingFrequency)
                }
              >
                {Object.entries(FREQUENCY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <Alert variant="info">
              PAPER, DEMO and backtest results are excluded. Only qualifying
              realised LIVE-trading profit is eligible.
            </Alert>
            <div className="performance-fee-admin__actions">
              <button
                className="btn btn--primary"
                type="submit"
                disabled={saving}
              >
                {saving
                  ? "Saving…"
                  : activePolicy
                    ? "Update policy"
                    : "Create policy"}
              </button>
            </div>
          </form>
        </Card>

        <Card
          title="Policy history"
          subtitle="Immutable history of owner-admin fee changes."
        >
          {loading ? (
            <LoadingSpinner text="Loading policy history…" />
          ) : policies.length === 0 ? (
            <p className="muted">
              No performance-fee policy has been configured yet.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Policy</th>
                    <th>Rate</th>
                    <th>Frequency</th>
                    <th>Effective from</th>
                    <th>Effective to</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => (
                    <tr key={policy.id}>
                      <td>v{policy.version}</td>
                      <td>{policy.name}</td>
                      <td>{Number(policy.feePercent).toFixed(2)}%</td>
                      <td>{FREQUENCY_LABELS[policy.billingFrequency]}</td>
                      <td>{new Date(policy.effectiveFrom).toLocaleString()}</td>
                      <td>
                        {policy.effectiveTo
                          ? new Date(policy.effectiveTo).toLocaleString()
                          : "—"}
                      </td>
                      <td>
                        <Badge variant={policy.isActive ? "success" : "info"}>
                          {policy.isActive ? "Active" : "Superseded"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <ConfirmDialog
          open={confirmOpen}
          title={
            activePolicy
              ? "Change performance fee?"
              : "Create performance fee policy?"
          }
          description={
            activePolicy
              ? "The active fee will change from " +
                currentRate?.toFixed(2) +
                "% to " +
                proposedRate.toFixed(2) +
                "%. The old policy remains in history and already calculated assessments will not change."
              : "Create the global performance fee at " +
                proposedRate.toFixed(2) +
                "%? This will apply to future qualifying LIVE-trading assessments."
          }
          confirmLabel={activePolicy ? "Apply new fee" : "Create policy"}
          tone="warning"
          onConfirm={() => void savePolicy()}
          onCancel={() => setConfirmOpen(false)}
        />
      </main>
    </DashboardShell>
  );
}