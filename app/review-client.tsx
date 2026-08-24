"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RuntimeSession = { api_base: string; session_token: string; initial_state?: unknown };
let runtimeSessionPromise: Promise<RuntimeSession> | null = null;

type ProposalStatus = "pending" | "applying" | "failed" | "approved" | "rejected" | "superseded";
type RecordShape = Record<string, string | number | boolean | null | undefined>;
type BusyOperation =
  | { kind: "pipeline" }
  | { kind: "refresh" }
  | { kind: "decision"; id: string; decision: "approve" | "reject" };

type Proposal = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  risk: string;
  status: ProposalStatus;
  location: null | {
    name: string;
    street: string;
    city: string;
    state: string;
    zip: string;
    care_offerings: string[];
    source_url: string;
  };
  account: null | RecordShape;
  related_account: null | RecordShape;
  match: null | {
    method: string;
    confidence: number;
    name_similarity: number;
    street_match: boolean;
    city_match: boolean;
    state_match: boolean;
    zip_match: boolean;
  };
  care_mapping?: null | {
    mode: string;
    website_offerings: string[];
    mapped_types: string[];
    crm_value: string | null;
  };
  application: {
    type: string;
    patch?: RecordShape;
    desired?: RecordShape;
    old_account_id?: string;
    current_account_id?: string;
  };
  decision?: null | {
    value: string;
    reviewer_note: string;
    reviewer_id?: string;
    decided_at: string;
  };
  application_result?: null | {
    error?: string;
    applied_at?: string;
    failed_at?: string;
    outcome?: string;
  };
};

type ReviewState = {
  updated_at: string;
  latest_run: null | {
    id: string;
    status?: string;
    completed_at: string;
    website_location_count: number;
    crm_account_count: number;
    proposed_count: number;
    pending_count: number;
  };
  last_pipeline_failure?: null | {
    completed_at: string;
    error: string;
  };
  counts: Record<string, number>;
  source: null | {
    website_location_count: number;
    homepage_claimed_count: number | null;
    directory_claimed_count: number;
    count_discrepancy: boolean;
  };
  proposals: Proposal[];
};

const FILTERS = [
  { id: "open", label: "Open review" },
  { id: "ownership", label: "Ownership / CHOW" },
  { id: "duplicate", label: "Duplicates" },
  { id: "create", label: "New accounts" },
  { id: "former", label: "Former listings" },
  { id: "history", label: "Decision history" },
] as const;

const FIELD_LABELS: Record<string, string> = {
  name: "Account name",
  parent_id: "Parent account",
  billing_street: "Street",
  billing_city: "City",
  billing_state: "State",
  billing_zip: "ZIP",
  care_type: "Care type",
  status: "Status",
  duplicate_of_account: "Duplicate of",
  chow_current_account: "Current CHOW account",
  note: "CRM note",
  phone: "Phone",
};

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class TransportError extends Error {
  outcomeUnknown: boolean;

  constructor(message: string, outcomeUnknown: boolean) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
  }
}

function isReviewState(value: unknown): value is ReviewState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReviewState>;
  return Array.isArray(candidate.proposals)
    && (candidate.source === null || typeof candidate.source === "object")
    && typeof candidate.counts === "object";
}

function invalidateRuntimeSession() {
  runtimeSessionPromise = null;
}

async function getRuntimeSession(): Promise<RuntimeSession> {
  runtimeSessionPromise ??= fetch("/api/review-runtime", {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({})) as Partial<RuntimeSession> & { error?: string };
    if (!response.ok) throw new Error(payload.error || "The local review session is unavailable. Restart the app.");
    const apiUrl = new URL(String(payload.api_base));
    if (apiUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(apiUrl.hostname)) {
      throw new Error("The local review service returned an unsafe API address.");
    }
    if (typeof payload.session_token !== "string" || payload.session_token.length < 32) {
      throw new Error("The local review session is invalid. Restart the app.");
    }
    return {
      api_base: apiUrl.toString().replace(/\/$/, ""),
      session_token: payload.session_token,
      initial_state: payload.initial_state,
    };
  }).catch((error) => {
    invalidateRuntimeSession();
    throw error;
  });
  return runtimeSessionPromise;
}

async function apiRequest<T>(pathname: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const method = String(init.method || "GET").toUpperCase();
  const safeRead = ["GET", "HEAD"].includes(method);

  for (let attempt = 0; attempt < (safeRead ? 2 : 1); attempt += 1) {
    let runtime: RuntimeSession;
    try {
      runtime = await getRuntimeSession();
    } catch (caught) {
      if (safeRead && attempt === 0) continue;
      throw caught;
    }
    if (safeRead && pathname === "/api/state" && runtime.initial_state !== undefined) {
      const initialState = runtime.initial_state;
      runtime.initial_state = undefined;
      if (isReviewState(initialState)) return initialState as T;
      invalidateRuntimeSession();
      if (attempt === 0) continue;
      throw new Error("The local review service returned an invalid initial state.");
    }
    if (!safeRead) runtime.initial_state = undefined;

    const headers = new Headers(init.headers);
    headers.set("x-review-session", runtime.session_token);
    let response: Response;
    try {
      response = await fetch(`${runtime.api_base}${pathname}`, {
        ...init,
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (caught) {
      invalidateRuntimeSession();
      if (safeRead && attempt === 0) continue;
      if (isTimeoutError(caught)) throw caught;
      throw new TransportError(
        safeRead
          ? "Could not reach the local review service after refreshing the local session."
          : "The connection changed before the local review service confirmed the operation.",
        !safeRead,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (caught) {
      invalidateRuntimeSession();
      if (safeRead && attempt === 0) continue;
      throw new TransportError(
        isTimeoutError(caught)
          ? "The local review request timed out before its response was confirmed."
          : "The connection changed before the local review service response was confirmed.",
        !safeRead,
      );
    }
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        invalidateRuntimeSession();
        if (safeRead && attempt === 0) continue;
        if (!safeRead) {
          throw new TransportError("The local review service returned an unreadable response, so the operation outcome is unknown.", true);
        }
        throw new ApiError(response.status, "The local review service returned an unreadable response.");
      }
    }
    if (!response.ok) {
      const message = typeof payload === "object" && payload && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `The local review service returned ${response.status}.`;
      if ([401, 403].includes(response.status)) {
        invalidateRuntimeSession();
        if (safeRead && attempt === 0) continue;
      }
      if (!safeRead && response.status >= 500) {
        throw new TransportError(message, true);
      }
      throw new ApiError(response.status, message);
    }
    return payload as T;
  }

  throw new Error("The local review request could not be completed.");
}

function displayValue(key: string, value: unknown, proposal: Proposal): string {
  if (key === "parent_id") {
    const resolved = value === proposal.account?.parent_id
      ? proposal.account?.parent_name || value || "No parent"
      : value ? "Bellhaven Senior Living (Parent Account)" : "No parent";
    return String(resolved);
  }
  if (value === "" || value === null || value === undefined) return "—";
  if (key === "duplicate_of_account" && value === proposal.related_account?.account_id) {
    return `${proposal.related_account?.name || "Related account"} (${value})`;
  }
  return String(value);
}

function textPart(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function proposalAddress(proposal: Proposal) {
  const city = textPart(proposal.location?.city ?? proposal.account?.billing_city);
  const state = textPart(proposal.location?.state ?? proposal.account?.billing_state);
  const zip = textPart(proposal.location?.zip ?? proposal.account?.billing_zip);
  const stateAndZip = [state, zip].filter(Boolean).join(" ");
  return [city, stateAndZip].filter(Boolean).join(", ") || "No locality";
}

function formatCurrency(value: unknown) {
  if (value === null || value === undefined || value === "") return "Amount unavailable";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Amount unavailable";
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatConfidence(value: unknown) {
  if (value === null || value === undefined || value === "") return "Confidence unavailable";
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "Confidence unavailable";
  return `${Math.round(confidence * 100)}% confidence`;
}

function formatDecisionTime(value: unknown) {
  const raw = textPart(value);
  if (!raw) return "Decision time unavailable";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "Decision time unavailable" : date.toLocaleString();
}

function safeSourceUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function riskLabel(proposal: Proposal) {
  if (proposal.risk === "billing_safeguard") return "CHOW safeguard";
  if (proposal.kind === "duplicate") return "Duplicate";
  if (proposal.kind === "former_affiliation") return "Needs confirmation";
  if (proposal.kind === "create") return "New account";
  return "Field correction";
}

function isReviewable(proposal: Proposal) {
  return ["pending", "failed"].includes(proposal.status);
}

function isOpen(proposal: Proposal) {
  return isReviewable(proposal) || proposal.status === "applying";
}

function hasUnknownApplicationOutcome(proposal: Proposal) {
  return proposal.status === "failed" && proposal.application_result?.outcome !== "no_write";
}

function filterProposal(proposal: Proposal, filter: string) {
  if (filter === "open") return isOpen(proposal);
  if (filter === "ownership") {
    return (isOpen(proposal) && ["chow", "link_chow"].includes(proposal.kind))
      || (isOpen(proposal) && Boolean(proposal.application.patch) && Object.hasOwn(proposal.application.patch ?? {}, "parent_id"));
  }
  if (filter === "duplicate") return isOpen(proposal) && proposal.kind === "duplicate";
  if (filter === "create") return isOpen(proposal) && proposal.kind === "create";
  if (filter === "former") return isOpen(proposal) && proposal.kind === "former_affiliation";
  if (filter === "history") return !isOpen(proposal);
  return true;
}

function isTimeoutError(error: unknown) {
  return error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name);
}

function isUnknownOutcomeError(error: unknown) {
  return isTimeoutError(error) || (error instanceof TransportError && error.outcomeUnknown);
}

function reconciledDecisionMessage(proposal: Proposal | undefined, decision: "approve" | "reject") {
  if (!proposal) return "The queue refreshed, but the proposal is no longer present. Do not retry the decision.";
  if (proposal.status === "approved") return "The queue refreshed and confirms that the proposal was approved.";
  if (proposal.status === "rejected") return "The queue refreshed and confirms that the proposal was rejected without CRM changes.";
  if (proposal.status === "applying") return "The queue refreshed and still shows the application in progress. Do not retry it.";
  if (proposal.status === "failed" && hasUnknownApplicationOutcome(proposal)) {
    return "The queue refreshed, but the prior CRM outcome remains unknown. Reject is unavailable; retry approval only to reconcile the durable CRM state.";
  }
  if (proposal.status === "failed" && proposal.application_result?.outcome === "no_write") {
    return "The queue refreshed and confirms that the CRM application failed without a write. You may retry approval or reject the proposal.";
  }
  if (proposal.status === "failed") return "The queue refreshed and reports that the CRM application failed. Review the recorded failure before retrying.";
  if (proposal.status === "superseded") return "The queue refreshed and shows that a newer scan superseded this proposal. Do not retry it.";
  return decision === "approve"
    ? "The queue refreshed but still shows the proposal pending, so the CRM outcome is not confirmed. Do not retry until the evidence is verified."
    : "The queue refreshed but still shows the proposal pending, so the rejection outcome is not confirmed. Review the proposal before retrying.";
}

function decisionHistorySummary(proposal: Proposal, scanFailed: boolean, refreshRequired: boolean) {
  if (refreshRequired && isReviewable(proposal)) {
    return "Decisions are paused until the durable queue refresh succeeds.";
  }
  if (scanFailed && isReviewable(proposal)) {
    return "Decisions are paused because the latest scan failed. Run a successful daily scan before approving or rejecting this proposal.";
  }
  if (proposal.status === "applying") return "Application in progress. Refresh before taking another action.";
  if (proposal.status === "approved") return "Approved. The recorded application result is shown above.";
  if (proposal.status === "rejected") return "Rejected. No CRM changes were applied for this proposal.";
  if (proposal.status === "superseded") return "Superseded by newer scan evidence; this proposal is no longer actionable.";
  return "This proposal is read-only decision history.";
}

export function ReviewApp() {
  const [state, setState] = useState<ReviewState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("open");
  const [query, setQuery] = useState("");
  const [reviewerNotes, setReviewerNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<BusyOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const acceptState = useCallback((nextState: ReviewState) => {
    setState(nextState);
    setRefreshRequired(false);
    setSelectedId((current) => {
      const currentProposal = nextState.proposals.find((proposal) => proposal.id === current);
      return currentProposal?.id
        ?? nextState.proposals.find(isReviewable)?.id
        ?? nextState.proposals.find((proposal) => proposal.status === "applying")?.id
        ?? nextState.proposals[0]?.id
        ?? null;
    });
  }, []);

  const loadState = useCallback(async () => {
    const nextState = await apiRequest<ReviewState>("/api/state");
    acceptState(nextState);
    return nextState;
  }, [acceptState]);

  useEffect(() => {
    let active = true;
    apiRequest<ReviewState>("/api/state")
      .then((nextState) => {
        if (active) acceptState(nextState);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [acceptState]);

  useEffect(() => {
    const invalidate = () => invalidateRuntimeSession();
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    window.addEventListener("online", invalidate);
    window.addEventListener("offline", invalidate);
    connection?.addEventListener("change", invalidate);
    return () => {
      window.removeEventListener("online", invalidate);
      window.removeEventListener("offline", invalidate);
      connection?.removeEventListener("change", invalidate);
    };
  }, []);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (state?.proposals ?? []).filter((proposal) => {
      if (!filterProposal(proposal, filter)) return false;
      if (!normalizedQuery) return true;
      return `${proposal.title} ${proposal.account?.name ?? ""} ${proposalAddress(proposal)}`.toLowerCase().includes(normalizedQuery);
    });
  }, [filter, query, state]);

  const selected = filtered.find((proposal) => proposal.id === selectedId)
    ?? filtered[0]
    ?? null;

  const reviewerNote = selected ? reviewerNotes[selected.id] ?? "" : "";

  const queueStats = useMemo(() => {
    const proposals = state?.proposals ?? [];
    const filterCounts = Object.fromEntries(FILTERS.map((item) => [
      item.id,
      proposals.filter((proposal) => filterProposal(proposal, item.id)).length,
    ])) as Record<(typeof FILTERS)[number]["id"], number>;
    return {
      reviewableCount: proposals.filter(isReviewable).length,
      applyingCount: proposals.filter((proposal) => proposal.status === "applying").length,
      safeguardCount: proposals.filter((proposal) => isReviewable(proposal) && proposal.risk === "billing_safeguard").length,
      filterCounts,
    };
  }, [state]);

  const focusQueueIndex = useCallback((index: number) => {
    if (!filtered.length) return;
    const boundedIndex = Math.max(0, Math.min(filtered.length - 1, index));
    const proposal = filtered[boundedIndex];
    setSelectedId(proposal.id);
    window.requestAnimationFrame(() => document.getElementById(`proposal-row-${proposal.id}`)?.focus());
  }, [filtered]);

  const queueRows = useMemo(() => filtered.map((proposal, index) => {
    const isSelected = proposal.id === selected?.id;
    return (
      <li key={proposal.id}>
        <button
          id={`proposal-row-${proposal.id}`}
          type="button"
          tabIndex={isSelected ? 0 : -1}
          aria-current={isSelected ? "true" : undefined}
          className={isSelected ? "proposal-row selected" : "proposal-row"}
          onClick={() => setSelectedId(proposal.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusQueueIndex(index + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusQueueIndex(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusQueueIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusQueueIndex(filtered.length - 1);
            }
          }}
        >
          <span className={`status-dot status-${proposal.status}`} aria-hidden="true" />
          <span><b>{proposal.title.replace(/^[^:]+:\s*/, "")}</b><small>{proposalAddress(proposal)}</small></span>
          <span className="proposal-meta">{proposal.kind.replaceAll("_", " ")} · {proposal.status}</span>
        </button>
      </li>
    );
  }), [filtered, focusQueueIndex, selected?.id]);

  const decide = useCallback(async (decision: "approve" | "reject") => {
    if (!selected || !isReviewable(selected) || busy || state?.last_pipeline_failure || refreshRequired) return;
    const unknownApplicationOutcome = hasUnknownApplicationOutcome(selected);
    if (decision === "reject" && unknownApplicationOutcome) return;
    const confirmed = window.confirm(decision === "approve"
      ? unknownApplicationOutcome
        ? `Retry approval for “${selected.title}” and reconcile it against the durable CRM state?`
        : `Approve “${selected.title}” and write the displayed change to the CRM?`
      : `Reject “${selected.title}”? This becomes read-only decision history, and an identical proposal stays suppressed unless its evidence changes. No CRM fields will be changed.`);
    if (!confirmed) return;
    setBusy({ kind: "decision", id: selected.id, decision });
    setError(null);
    setNotice(null);
    try {
      const payload = await apiRequest<{ proposal?: Proposal }>(`/api/proposals/${selected.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reviewer_note: reviewerNote }),
      }, 90_000);
      if (payload?.proposal?.id === selected.id) {
        setState((current) => current ? {
          ...current,
          proposals: current.proposals.map((proposal) => proposal.id === selected.id ? payload.proposal as Proposal : proposal),
        } : current);
      }
      setReviewerNotes((notes) => {
        const next = { ...notes };
        delete next[selected.id];
        return next;
      });
      const successMessage = decision === "approve"
        ? "Approved and verified in the CRM."
        : "Rejected; no CRM fields were changed.";
      setNotice(successMessage);
      try {
        await loadState();
      } catch (refreshCaught) {
        const refreshMessage = refreshCaught instanceof Error ? refreshCaught.message : String(refreshCaught);
        setRefreshRequired(true);
        setError(`${successMessage} The decision is confirmed, but the durable queue refresh failed: ${refreshMessage} Refresh the queue before another action; do not submit this decision again.`);
      }
      window.requestAnimationFrame(() => headingRef.current?.focus());
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const outcomeUnknown = isUnknownOutcomeError(caught);
      try {
        const refreshed = await loadState();
        const refreshedProposal = refreshed.proposals.find((proposal) => proposal.id === selected.id);
        setError(outcomeUnknown
          ? `${message} ${reconciledDecisionMessage(refreshedProposal, decision)}`
          : `${message} The queue refreshed; the proposal now shows ${refreshedProposal?.status ?? "unavailable"}.`);
        window.requestAnimationFrame(() => headingRef.current?.focus());
      } catch (refreshCaught) {
        const refreshMessage = refreshCaught instanceof Error ? refreshCaught.message : String(refreshCaught);
        if (outcomeUnknown) setRefreshRequired(true);
        setError(outcomeUnknown
          ? `${message} The outcome is unknown and the queue refresh also failed: ${refreshMessage} Do not retry until the service reconnects and the proposal state is verified.`
          : `${message} The queue refresh also failed: ${refreshMessage}`);
      }
    } finally {
      setBusy(null);
    }
  }, [busy, loadState, refreshRequired, reviewerNote, selected, state?.last_pipeline_failure]);

  async function runPipeline() {
    if (busy || refreshRequired) return;
    setBusy({ kind: "pipeline" });
    setError(null);
    setNotice(null);
    try {
      const payload = await apiRequest<{ run?: { proposed_count: number; pending_count: number } }>(
        "/api/pipeline/run",
        { method: "POST" },
        120_000,
      );
      const successMessage = payload?.run
        ? `Scan complete: ${payload.run.proposed_count} current findings, ${payload.run.pending_count} awaiting review.`
        : "Scan complete; summary counts were unavailable in the response.";
      setNotice(successMessage);
      try {
        await loadState();
      } catch (refreshCaught) {
        const refreshMessage = refreshCaught instanceof Error ? refreshCaught.message : String(refreshCaught);
        setRefreshRequired(true);
        setError(`${successMessage} The scan is confirmed, but the durable queue refresh failed: ${refreshMessage} Refresh the queue before another action; do not run the scan again.`);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const outcomeUnknown = isUnknownOutcomeError(caught);
      try {
        const refreshed = await loadState();
        if (outcomeUnknown) {
          setError(refreshed.last_pipeline_failure
            ? `${message} The queue refreshed and reports a failed scan: ${refreshed.last_pipeline_failure.error}`
            : `${message} The queue refreshed, but scan completion is not confirmed. Wait for the current attempt to settle before starting another.`);
        } else {
          setError(refreshed.last_pipeline_failure
            ? `${message} The queue refreshed and decisions remain paused until a successful scan.`
            : `${message} The queue refreshed successfully.`);
        }
      } catch (refreshCaught) {
        const refreshMessage = refreshCaught instanceof Error ? refreshCaught.message : String(refreshCaught);
        if (outcomeUnknown) setRefreshRequired(true);
        setError(outcomeUnknown
          ? `${message} The scan outcome is unknown and the queue refresh also failed: ${refreshMessage} Do not start another scan until the service reconnects.`
          : `${message} The queue refresh also failed: ${refreshMessage}`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function refreshQueue() {
    if (busy) return;
    setBusy({ kind: "refresh" });
    setError(null);
    setNotice(null);
    try {
      const refreshed = await loadState();
      setNotice("Queue refreshed from the latest durable state.");
      const refreshedProposal = selected ? refreshed.proposals.find((proposal) => proposal.id === selected.id) : null;
      if (selected?.status === "applying" && refreshedProposal?.status !== "applying") {
        window.requestAnimationFrame(() => headingRef.current?.focus());
      }
    } catch (caught) {
      setError(isTimeoutError(caught)
        ? "The refresh timed out. Confirm the local review service is running, then try again."
        : caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  if (!state) {
    return (
      <main className="loading-shell">
        <div role={error ? "alert" : "status"}>
          <span className="brand-mark" aria-hidden="true">BH</span>
          <h1>{error ? "Review service unavailable" : "Loading ownership review…"}</h1>
          <p>{error ?? "Reading the latest Bellhaven scan and decision history."}</p>
          {error && <button type="button" onClick={() => location.reload()}>Try again</button>}
        </div>
      </main>
    );
  }

  const { reviewableCount, applyingCount, safeguardCount, filterCounts } = queueStats;
  const index = filtered.findIndex((proposal) => proposal.id === selected?.id);
  const changes = selected?.application.patch ?? selected?.application.desired ?? {};
  const createsNewAccount = ["create", "chow_create"].includes(selected?.application.type ?? "");
  const scanFailed = Boolean(state.last_pipeline_failure);
  const decisionsPaused = scanFailed || refreshRequired;
  const canApprove = Boolean(selected && isReviewable(selected) && !decisionsPaused);
  const unknownApplicationOutcome = Boolean(selected && hasUnknownApplicationOutcome(selected));
  const canReject = canApprove && !unknownApplicationOutcome;
  const decisionBusy = busy?.kind === "decision" && busy.id === selected?.id ? busy : null;
  const sourceUrl = safeSourceUrl(selected?.location?.source_url);
  const currentColumnLabel = createsNewAccount ? "Before approval" : "Current CRM";
  const proposedColumnLabel = createsNewAccount ? "New account after approval" : "After approval";

  return (
    <main className="workspace-shell" aria-busy={Boolean(busy)}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">BH</span>
          <div>
            <p className="section-label">Revenue operations</p>
            <p className="brand-name">Bellhaven ownership desk</p>
          </div>
        </div>
        <div className="header-actions">
          <div className={`run-state${decisionsPaused ? " run-state-failed" : ""}`}>
            <span aria-hidden="true" />
            {refreshRequired ? "Queue unverified · decisions paused" : scanFailed ? "Scan failed · decisions paused" : reviewableCount ? `${reviewableCount} awaiting review` : applyingCount ? `${applyingCount} applying` : "Queue clear"}
          </div>
          <button className="scan-button" type="button" onClick={() => void (refreshRequired ? refreshQueue() : runPipeline())} disabled={Boolean(busy)}>
            {busy?.kind === "pipeline" ? "Scanning…" : busy?.kind === "refresh" ? "Refreshing…" : refreshRequired ? "Refresh queue" : "Run daily scan"}
          </button>
        </div>
      </header>

      {state.source?.count_discrepancy && (
        <div className="source-alert" role="note">
          <b>Source discrepancy</b>
          <span>The homepage claims {state.source.homepage_claimed_count ?? "an unavailable count"} communities; the paginated directory contains {state.source.directory_claimed_count}. This run uses all directory records.</span>
        </div>
      )}
      {refreshRequired ? (
        <div className="pipeline-alert" role="alert">
          <b>Durable queue refresh required · decisions paused</b>
          <span>The last operation completed or may still be settling, but the current queue could not be verified. Refresh the queue before another decision or scan.</span>
        </div>
      ) : state.last_pipeline_failure && (
        <div className="pipeline-alert" role="alert">
          <b>Last scan failed · decisions paused</b>
          <span>{state.last_pipeline_failure.error} Run a successful daily scan before approving or rejecting any proposal.</span>
        </div>
      )}
      {(error || notice) && <div className={error ? "toast error-toast" : "toast"} role={error ? "alert" : "status"}>{error ?? notice}</div>}

      <section className="dashboard-grid live-grid">
        <aside className="rail live-rail" aria-label="Review queue">
          <div className="rail-intro">
            <div>
              <h1>Decide what changes.</h1>
              <p className="intro">Evidence first. The CRM is read-only until you approve a specific proposal.</p>
            </div>
            <dl className="metrics">
              <div><dt>Website locations</dt><dd>{state.source?.website_location_count ?? 0}</dd></div>
              <div><dt>Awaiting review</dt><dd>{reviewableCount}</dd></div>
              <div><dt>Billing safeguards</dt><dd>{safeguardCount}</dd></div>
            </dl>
          </div>

          <nav className="queue-nav live-nav" aria-label="Proposal filters">
            {FILTERS.map((item) => {
              const count = filterCounts[item.id];
              return (
                <button
                  key={item.id}
                  className={filter === item.id ? "active" : ""}
                  type="button"
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  <span>{item.label}</span><b>{count}</b>
                </button>
              );
            })}
          </nav>

          <label className="search-box">
            <span className="sr-only">Search proposals</span>
            <input maxLength={200} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search facility or city" />
          </label>

          <p className="sr-only" id="queue-keyboard-hint">Use the Up and Down Arrow keys to move through proposals. Press Tab to move from the selected proposal to its details.</p>
          <ul className="proposal-list" aria-label={`${filtered.length} filtered proposals`} aria-describedby="queue-keyboard-hint">
            {queueRows}
            {!filtered.length && <li className="empty-list"><b>No proposals here.</b><span>{query ? "Clear the search or choose another filter." : "Choose another filter or run a new scan."}</span></li>}
          </ul>
        </aside>

        <section
          className="review-pane live-review"
          aria-labelledby={selected ? "proposal-heading" : "empty-proposal-heading"}
        >
          {selected ? (
            <>
              <div className="review-heading">
                <div>
                  <h2 id="proposal-heading" ref={headingRef} tabIndex={-1} aria-describedby="proposal-position">{selected.location?.name ?? String(selected.account?.name ?? selected.title)}</h2>
                  <p className="proposal-position" id="proposal-position">{index >= 0 ? `Proposal ${index + 1} of ${filtered.length}` : "Proposal detail"}</p>
                </div>
                <span className={`risk-badge risk-${selected.risk}`}>{riskLabel(selected)}</span>
              </div>

              <div className="evidence-strip">
                <div>
                  <span className="source-label">Bellhaven website</span>
                  {selected.location ? <>
                  <strong>{selected.location.street}</strong>
                  <small>{proposalAddress(selected)} · {selected.location.care_offerings.join(" · ") || "No care offering listed"}</small>
                </> : <>
                  <strong>Not found in current directory</strong>
                  <small>{state.source ? `All ${state.source.directory_claimed_count} paginated records checked` : "Directory count unavailable"}</small>
                </>}
                </div>
                <span className="match-arrow" aria-hidden="true" />
                <div>
                  <span className="source-label">CRM evidence</span>
                  <strong>{selected.account ? textPart(selected.account.name) || "Unnamed CRM account" : "No credible account match"}</strong>
                  <small>{selected.match ? `${formatConfidence(selected.match.confidence)} · ${selected.match.method.replaceAll("_", " ")}` : selected.kind === "create" ? "No reusable CRM account was selected" : `Account ${selected.account?.account_id || "unavailable"}`}</small>
                </div>
                {sourceUrl && <a className="source-link" href={sourceUrl} target="_blank" rel="noreferrer">Open source</a>}
              </div>

              <article className="change-card live-change-card">
                <div className="change-title">
                  <span className="change-icon" aria-hidden="true">CRM</span>
                  <div>
                    <h3>{selected.title}</h3>
                    <p>{selected.summary}</p>
                  </div>
                  <span className={`decision-status status-${selected.status}`}>{selected.status}</span>
                </div>

                {["chow", "link_chow"].includes(selected.kind) && (
                  <div className="safeguard-note prominent-note">
                    <b>{selected.kind === "chow" ? "Revenue + outstanding AR: preserve the historic account" : "Historic billing account: link, do not re-parent"}</b>
                    <span>{formatCurrency(selected.account?.lifetime_revenue)} lifetime revenue · {formatCurrency(selected.account?.outstanding_ar)} outstanding AR</span>
                    <p>{selected.kind === "chow" ? "Approval creates a separate current Bellhaven account. The historic account remains unchanged except for its CHOW link." : `Approval leaves the historic record unchanged except for its CHOW link to ${textPart(selected.related_account?.account_id) || "the selected current account"}.`}</p>
                  </div>
                )}

                {selected.care_mapping?.mode === "multiple_offerings_preserved_in_evidence" && (
                  <div className="care-note">
                    <b>Multiple care offerings</b>
                    <span>The website values remain in the evidence above; the CRM’s singular care_type is not guessed.</span>
                  </div>
                )}

                {/* A focusable scroll region lets keyboard users reach columns hidden by narrow viewports. */}
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
                <div className="change-table" role="region" aria-label="Proposed field changes" tabIndex={0}>
                  <table>
                    <caption className="sr-only">Proposed field changes</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">{currentColumnLabel}</th>
                        <th scope="col">{proposedColumnLabel}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(changes).map(([key, value]) => (
                        <tr key={key}>
                          <th scope="row">{FIELD_LABELS[key] ?? key}</th>
                          <td>
                            {createsNewAccount
                              ? selected.application.type === "chow_create" ? "No current account; historic record stays separate" : "No account"
                              : displayValue(key, selected.account?.[key], selected)}
                          </td>
                          <td><strong>{displayValue(key, value, selected)}</strong></td>
                        </tr>
                      ))}
                      {!Object.keys(changes).length && selected.application.type === "link_chow" && (
                        <tr>
                          <th scope="row">CHOW relationship</th>
                          <td>{String(selected.account?.chow_current_account || "None")}</td>
                          <td><strong>Link to {String(selected.related_account?.name || selected.application.current_account_id || "selected current Bellhaven account")}</strong></td>
                        </tr>
                      )}
                      {!Object.keys(changes).length && selected.application.type !== "link_chow" && (
                        <tr>
                          <th scope="row">No field changes</th>
                          <td colSpan={2}>This proposal does not contain a field-level application to compare.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {selected.application_result?.error && <div className="inline-error" role="alert"><b>Application failed</b><span>{selected.application_result.error}</span></div>}
                {unknownApplicationOutcome && (
                  <div className="reconciliation-note" role="note">
                    <b>Previous CRM outcome unconfirmed</b>
                    <span>The prior approval stopped before the CRM write could be confirmed. Reject is unavailable because the change may already exist. Retry approval to reconcile against durable CRM state.</span>
                  </div>
                )}
                {selected.decision && <div className={`decision-record decision-${selected.decision.value === "approve" ? "approved" : "rejected"}`}><b>{selected.decision.value === "approve" ? "Approved" : "Rejected"}</b><span>{formatDecisionTime(selected.decision.decided_at)}{selected.decision.reviewer_id ? ` by ${selected.decision.reviewer_id}` : ""}{selected.decision.reviewer_note ? ` · ${selected.decision.reviewer_note}` : ""}</span></div>}
              </article>

              {canApprove && (
                <label className="review-note">
                  <span>Reviewer note <small>optional</small></span>
                  <textarea
                    maxLength={2000}
                    value={reviewerNote}
                    onChange={(event) => {
                      if (!selected) return;
                      setReviewerNotes((notes) => ({ ...notes, [selected.id]: event.target.value }));
                    }}
                    placeholder="Add context for the audit trail"
                    rows={2}
                  />
                </label>
              )}

              {canApprove ? (
                <footer className={`decision-bar${unknownApplicationOutcome ? " decision-bar-reconcile" : ""}`}>
                  {canReject && (
                    <button className="reject-button" type="button" disabled={Boolean(busy)} onClick={() => void decide("reject")}>
                      {decisionBusy?.decision === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                  )}
                  <button className="approve-button" type="button" disabled={Boolean(busy)} onClick={() => void decide("approve")}>
                    {decisionBusy?.decision === "approve" ? "Approving…" : unknownApplicationOutcome ? "Retry & reconcile" : selected.status === "failed" ? "Retry approval" : "Approve & write"}
                  </button>
                </footer>
              ) : (
                <footer className="decision-summary-bar">
                  <span>{decisionHistorySummary(selected, scanFailed, refreshRequired)}</span>
                  {selected.status === "applying" && (
                    <button type="button" disabled={Boolean(busy)} onClick={() => void refreshQueue()}>
                      {busy?.kind === "refresh" ? "Refreshing…" : "Refresh queue"}
                    </button>
                  )}
                </footer>
              )}
            </>
          ) : (
            <div className="empty-review"><span aria-hidden="true">Done</span><h2 id="empty-proposal-heading" ref={headingRef} tabIndex={-1}>No proposals in this view</h2><p>{query ? "Clear the search or choose another filter." : "Choose another filter or run a new scan."}</p></div>
          )}
        </section>
      </section>
    </main>
  );
}
