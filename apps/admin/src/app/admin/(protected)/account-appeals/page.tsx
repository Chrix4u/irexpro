"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/context/auth-context";
import { api } from "@/lib/api";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import {
  formatEnumLabel,
  type AccountAppealAdminView,
  type AccountAppealDecision,
} from "@irexpro/types";

const REVIEW_DECISIONS: Array<{
  value: AccountAppealDecision;
  label: string;
  description: string;
}> = [
  {
    value: "REACTIVATE",
    label: "Reactivate account",
    description:
      "Restores account access and clears a prior soft-deletion state.",
  },
  {
    value: "PERMANENTLY_LOCK",
    label: "Permanently lock account",
    description:
      "Keeps the account inaccessible unless a later reviewed decision changes it.",
  },
  {
    value: "DELETE",
    label: "Soft-delete account",
    description:
      "Closes the account while retaining the record and audit history.",
  },
];

const APPEAL_PAGE_SIZE = 20;

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function appealContact(appeal: AccountAppealAdminView): string {
  const profile = appeal.user?.profile;
  const name = [profile?.firstName, profile?.lastName]
    .filter(Boolean)
    .join(" ");
  const identifier =
    appeal.user?.email ?? appeal.user?.phone ?? "No contact record";
  return name ? `${name} — ${identifier}` : identifier;
}

export default function AccountAppealsPage() {
  const { hasAdminRole } = useAuth();
  const [appeals, setAppeals] = useState<AccountAppealAdminView[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<AccountAppealDecision>("REACTIVATE");
  const [reviewerNote, setReviewerNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!hasAdminRole) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    (async () => {
      try {
        const response = await api.listAccountAppeals({
          status: "PENDING",
          page,
          limit: APPEAL_PAGE_SIZE,
        });
        if (cancelled) return;
        const canonicalPage =
          response.totalPages === 0 ? 1 : Math.min(page, response.totalPages);
        if (canonicalPage !== page) {
          setPage(canonicalPage);
          return;
        }
        setAppeals(response.items);
        setTotal(response.total);
        setTotalPages(response.totalPages);
      } catch (requestError) {
        if (!cancelled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to load account reviews.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasAdminRole, page, refreshKey]);

  const selectedAppeal =
    appeals.find((appeal) => appeal.id === selectedId) ?? null;
  const selectedDecision =
    REVIEW_DECISIONS.find((item) => item.value === decision) ??
    REVIEW_DECISIONS[0];

  function selectAppeal(appealId: string) {
    setSelectedId(appealId);
    setDecision("REACTIVATE");
    setReviewerNote("");
    setConfirmed(false);
    setError(null);
  }

  async function resolveAppeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAppeal) return;
    if (!confirmed) {
      setError(
        "Confirm the selected account-access decision before submitting it.",
      );
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await api.resolveAccountAppeal(selectedAppeal.id, {
        decision,
        ...(reviewerNote.trim() ? { reviewerNote: reviewerNote.trim() } : {}),
      });
      const nextTotal = Math.max(0, total - 1);
      const nextTotalPages =
        nextTotal === 0 ? 0 : Math.ceil(nextTotal / APPEAL_PAGE_SIZE);
      const nextPage =
        nextTotalPages === 0 ? 1 : Math.min(page, nextTotalPages);

      setAppeals((current) =>
        current.filter((appeal) => appeal.id !== selectedAppeal.id),
      );
      setTotal(nextTotal);
      setTotalPages(nextTotalPages);
      setSelectedId(null);
      setReviewerNote("");
      setConfirmed(false);

      if (nextPage !== page) {
        setPage(nextPage);
      } else {
        setRefreshKey((current) => current + 1);
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to submit the account review.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!hasAdminRole) {
    return (
      <>
        <h1>Access denied</h1>
        <Card title="Insufficient permissions">
          <Alert variant="error">
            Your account does not have admin access.
          </Alert>
        </Card>
      </>
    );
  }

  return (
    <>
      <h1>Account reviews</h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Review pending account-access requests. Each outcome is recorded in the
        audit log.
      </p>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="admin-appeals-grid">
        <Card title={`Pending requests (${total})`}>
          {loading ? (
            <p className="muted">Loading account reviews…</p>
          ) : appeals.length === 0 ? (
            <EmptyState
              icon="✓"
              title="No pending reviews"
              description="New account-access requests will appear here."
            />
          ) : (
            <div className="admin-appeals-list">
              {appeals.map((appeal) => {
                const selected = appeal.id === selectedId;
                return (
                  <button
                    key={appeal.id}
                    type="button"
                    className={`admin-appeal-card${selected ? " admin-appeal-card--selected" : ""}`}
                    aria-pressed={selected}
                    onClick={() => selectAppeal(appeal.id)}
                  >
                    <span className="admin-appeal-card__contact break-long">
                      {appealContact(appeal)}
                    </span>
                    <span className="admin-appeal-card__meta">
                      <Badge variant="warning">Pending</Badge>
                      <span>{formatDateTime(appeal.createdAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {totalPages > 1 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                marginTop: "1rem",
              }}
            >
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading || page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <span className="text-sm muted" aria-live="polite">
                Page {page} of {totalPages}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading || page >= totalPages}
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
              >
                Next
              </Button>
            </div>
          )}
        </Card>

        <Card title="Review decision" className="admin-appeals-detail-card">
          {!selectedAppeal ? (
            <EmptyState
              icon="📋"
              title="Select a request"
              description="Choose a pending request to review its submitted context."
            />
          ) : (
            <div className="admin-appeals-detail">
              <div>
                <p className="text-sm muted">Account</p>
                <p className="break-long">{appealContact(selectedAppeal)}</p>
                <p className="text-sm muted" style={{ marginTop: "0.5rem" }}>
                  Current status:{" "}
                  <Badge variant="warning">
                    {formatEnumLabel(selectedAppeal.user?.status ?? "UNKNOWN")}
                  </Badge>
                </p>
              </div>

              <div className="admin-appeals-detail__reason">
                <p className="text-sm muted">Submitted context</p>
                <p>{selectedAppeal.reason}</p>
              </div>

              <form onSubmit={resolveAppeal}>
                <div className="input-group">
                  <label className="input-label" htmlFor="appeal-decision">
                    Review outcome
                  </label>
                  <select
                    id="appeal-decision"
                    className="input"
                    value={decision}
                    disabled={submitting}
                    onChange={(event) => {
                      setDecision(event.target.value as AccountAppealDecision);
                      setConfirmed(false);
                    }}
                  >
                    {REVIEW_DECISIONS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-sm muted admin-account-access__action-help">
                    {selectedDecision.description}
                  </p>
                </div>

                <div className="input-group">
                  <label className="input-label" htmlFor="appeal-review-note">
                    Reviewer note (optional)
                  </label>
                  <textarea
                    id="appeal-review-note"
                    className="input admin-account-access__textarea"
                    value={reviewerNote}
                    onChange={(event) => setReviewerNote(event.target.value)}
                    disabled={submitting}
                    maxLength={2000}
                    rows={3}
                  />
                </div>

                <label className="admin-account-access__confirmation">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={submitting}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>I confirm this reviewed account-access decision.</span>
                </label>

                <div className="admin-account-access__actions">
                  <Button
                    type="submit"
                    variant={decision === "REACTIVATE" ? "primary" : "danger"}
                    loading={submitting}
                  >
                    {submitting ? "Saving…" : selectedDecision.label}
                  </Button>
                </div>
              </form>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
