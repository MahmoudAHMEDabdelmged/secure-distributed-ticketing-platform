"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  ApiClientError,
  ApiEnvelope,
  apiRequest,
  extractData,
  getApiGatewayUrl,
} from "@/src/lib/api-client";
import type { ApiRequestOptions } from "@/src/lib/api-client";
import { APP_NAME, APP_TAGLINE } from "@/src/lib/branding";
import { getCurrentRole, isAuthenticated } from "@/src/lib/auth";
import { canAccessRoute, getDefaultRouteForRole } from "@/src/lib/roles";

type JsonRecord = Record<string, unknown>;

type CoordinatorNode = {
  node_id: string;
  role: string;
  status: string;
  current_term?: number;
  voted_for?: string | null;
  last_heartbeat_at?: string | null;
  last_seen_at?: string | null;
};

type ClusterPayload = {
  local_node_id?: string;
  cluster_size?: number;
  quorum?: number;
  tolerated_faults?: number;
  current_term?: number;
  leader?: {
    node_id: string;
    term?: number;
    last_heartbeat_at?: string | null;
  } | null;
  nodes?: CoordinatorNode[];
};

type LeaderPayload = {
  healthy_leader?: boolean;
  leader?: {
    node_id: string;
    term?: number;
    last_heartbeat_at?: string | null;
  } | null;
  term?: number;
  explanation?: string;
};

type FaultPayload = {
  failure_model?: string;
  cluster_size?: number;
  quorum?: number;
  tolerated_faults?: number;
  crashed_nodes?: string[];
  healthy_nodes?: string[];
  safety_status?: string;
  liveness_status?: string;
  explanation?: string;
  nodes?: CoordinatorNode[];
};

type TopologyRow = {
  id?: string;
  service_name: string;
  service_type: string;
  replicas: number;
  database_name?: string | null;
  estimated_rps?: number;
  status?: string;
};

type InfrastructureSummary = {
  total_services?: number;
  total_databases?: number;
  coordinator_cluster_size?: number;
  quorum_size?: number;
  tolerated_crash_failures?: number;
  estimated_users?: number;
  peak_concurrent_users?: number;
  estimated_qr_validations_per_min?: number;
  estimated_booking_requests_per_min?: number;
  topology?: TopologyRow[];
};

type ReplicatedLog = {
  log_index: string;
  term: number;
  leader_id: string;
  rsm_id?: string | null;
  booking_id?: string | null;
  event_type: string;
  ordering_type: string;
  status: string;
  commit_quorum: number;
  ack_count: number;
  payload?: JsonRecord;
  created_at?: string;
  committed_at?: string | null;
};

type RsmInstance = {
  rsm_id: string;
  booking_id: string;
  current_state: string;
  version: number;
  status: string;
  created_at?: string;
  updated_at?: string;
};

type RsmTransition = {
  transition_id: string;
  rsm_id: string;
  log_index?: string | null;
  from_state: string;
  to_state: string;
  event_type: string;
  valid: boolean;
  rejection_reason?: string | null;
  term?: number | null;
  committed_by_leader?: string | null;
  created_at?: string;
};

type OutboxState = {
  counts?: Record<string, number>;
  items?: JsonRecord[];
};

const nextEventByState: Record<string, string> = {
  INIT: "BOOKING_CREATED",
  BOOKING_CREATED: "PAYMENT_PENDING",
  PAYMENT_PENDING: "PAYMENT_SUCCEEDED",
  PAYMENT_SUCCEEDED: "TICKET_ISSUED",
  TICKET_ISSUED: "NOTIFICATION_PENDING",
  NOTIFICATION_PENDING: "NOTIFICATION_SENT",
  NOTIFICATION_SENT: "COMPLETED",
};

async function coordinatorRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
) {
  const payload = await apiRequest<ApiEnvelope<T>>(
    `/api/coordinator${path}`,
    options,
  );
  return extractData(payload);
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Request failed";
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export default function DistributedSystemsPage() {
  const [cluster, setCluster] = useState<ClusterPayload | null>(null);
  const [leader, setLeader] = useState<LeaderPayload | null>(null);
  const [faultTolerance, setFaultTolerance] = useState<FaultPayload | null>(
    null,
  );
  const [infrastructure, setInfrastructure] =
    useState<InfrastructureSummary | null>(null);
  const [logs, setLogs] = useState<ReplicatedLog[]>([]);
  const [outbox, setOutbox] = useState<OutboxState | null>(null);
  const [rsmList, setRsmList] = useState<RsmInstance[]>([]);
  const [currentRsmId, setCurrentRsmId] = useState("");
  const [currentRsm, setCurrentRsm] = useState<RsmInstance | null>(null);
  const [transitions, setTransitions] = useState<RsmTransition[]>([]);
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [bookingId, setBookingId] = useState("booking-demo-1");

  const accessState = useMemo(() => {
    const authenticated = isAuthenticated();
    const role = getCurrentRole();

    return {
      checked: true,
      hasAccess: Boolean(
        authenticated && canAccessRoute(role, "/distributed-systems"),
      ),
      redirect: authenticated ? getDefaultRouteForRole(role) : "/login",
    };
  }, []);

  const nodes = useMemo(() => {
    return cluster?.nodes || faultTolerance?.nodes || [];
  }, [cluster, faultTolerance]);

  const nextRsmEvent = currentRsm
    ? nextEventByState[currentRsm.current_state]
    : "BOOKING_CREATED";

  const refreshDashboard = useCallback(
    async (rsmId = currentRsmId) => {
      const [
        infrastructurePayload,
        faultPayload,
        clusterPayload,
        leaderPayload,
        logPayload,
        outboxPayload,
        rsmPayload,
      ] = await Promise.all([
        coordinatorRequest<InfrastructureSummary>("/infrastructure/summary"),
        coordinatorRequest<FaultPayload>("/fault-tolerance"),
        coordinatorRequest<ClusterPayload>("/cluster"),
        coordinatorRequest<LeaderPayload>("/leader"),
        coordinatorRequest<ReplicatedLog[]>("/ordering/total/log", {
          query: { limit: 100 },
        }),
        coordinatorRequest<OutboxState>("/outbox", { query: { limit: 50 } }),
        coordinatorRequest<RsmInstance[]>("/rsm", { query: { limit: 20 } }),
      ]);

      setInfrastructure(infrastructurePayload);
      setFaultTolerance(faultPayload);
      setCluster(clusterPayload);
      setLeader(leaderPayload);
      setLogs(safeArray<ReplicatedLog>(logPayload));
      setOutbox(outboxPayload);

      const loadedRsmList = safeArray<RsmInstance>(rsmPayload);
      setRsmList(loadedRsmList);

      const selectedRsmId = rsmId || loadedRsmList[0]?.rsm_id || "";

      if (selectedRsmId) {
        const [rsm, rsmTransitions] = await Promise.all([
          coordinatorRequest<RsmInstance>(
            `/rsm/${encodeURIComponent(selectedRsmId)}`,
          ),
          coordinatorRequest<RsmTransition[]>(
            `/rsm/${encodeURIComponent(selectedRsmId)}/transitions`,
          ),
        ]);

        setCurrentRsmId(selectedRsmId);
        setCurrentRsm(rsm);
        setTransitions(safeArray<RsmTransition>(rsmTransitions));
      } else {
        setCurrentRsmId("");
        setCurrentRsm(null);
        setTransitions([]);
      }
    },
    [currentRsmId],
  );


  async function loadDashboardData() {
    await refreshDashboard();

    return {
      message:
        "Dashboard data loaded manually. No test, simulation, election, broadcast, RSM transition, node crash, or payment action was executed automatically.",
    };
  }

  async function runAction(
    label: string,
    action: () => Promise<unknown>,
    rsmIdToRefresh?: string,
  ) {
    setBusyAction(label);
    setError(null);

    try {
      const result = await action();
      setLastResult(result);
      await refreshDashboard(rsmIdToRefresh || currentRsmId);
    } catch (actionError) {
      setError(getErrorMessage(actionError));

      if (actionError instanceof ApiClientError) {
        setLastResult(actionError.payload);
      } else {
        setLastResult({ message: getErrorMessage(actionError) });
      }

      await refreshDashboard(rsmIdToRefresh || currentRsmId).catch(
        () => undefined,
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function startRsm() {
    const uniqueBookingId = `${bookingId || "booking-demo"}-${Date.now()}`;
    const rsm = await coordinatorRequest<RsmInstance>("/rsm/start", {
      method: "POST",
      body: {
        booking_id: uniqueBookingId,
      },
    });

    setCurrentRsmId(rsm.rsm_id);
    setBookingId(uniqueBookingId);

    return rsm;
  }

  async function applyNextRsmTransition() {
    if (!currentRsm) {
      const rsm = await startRsm();
      return coordinatorRequest(
        `/rsm/${encodeURIComponent(rsm.rsm_id)}/transition`,
        {
          method: "POST",
          body: {
            event_type: "BOOKING_CREATED",
            payload: {
              source: "dashboard",
            },
          },
        },
      );
    }

    if (!nextRsmEvent) {
      return {
        message: "RSM has no next valid transition",
        rsm: currentRsm,
      };
    }

    return coordinatorRequest(
      `/rsm/${encodeURIComponent(currentRsm.rsm_id)}/transition`,
      {
        method: "POST",
        body: {
          event_type: nextRsmEvent,
          payload: {
            source: "dashboard",
          },
        },
      },
    );
  }

  async function tryInvalidTransition() {
    const invalidRsm = await coordinatorRequest<RsmInstance>("/rsm/start", {
      method: "POST",
      body: {
        booking_id: `booking-invalid-${Date.now()}`,
      },
    });

    setCurrentRsmId(invalidRsm.rsm_id);

    return coordinatorRequest(
      `/rsm/${encodeURIComponent(invalidRsm.rsm_id)}/transition`,
      {
        method: "POST",
        body: {
          event_type: "TICKET_ISSUED",
          payload: {
            source: "dashboard",
            expected: "CAUSAL_ORDER_VIOLATION",
          },
        },
      },
    );
  }

  async function runMonitoringCheck() {
    return apiRequest("/api/monitoring/checks/run", {
      method: "POST",
    });
  }

  if (!accessState.checked) {
    return (
      <AccessState
        title="Checking access"
        message="Please wait while EZbook verifies your permissions."
      />
    );
  }

  if (!accessState.hasAccess) {
    return (
      <AccessState
        title="Access denied"
        message="You do not have permission to view the distributed systems control plane."
        actionHref={accessState.redirect}
        actionLabel="Go back"
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark">EZ</span>
          <span>
            <strong>{APP_NAME}</strong>
            <small>{APP_TAGLINE}</small>
          </span>
        </Link>
        <nav className="nav-list" aria-label="System administrator navigation">
          <Link href="/">Home</Link>
          <Link href="/admin">Admin</Link>
          <Link href="/security">Security</Link>
          <Link href="/monitoring">Monitoring</Link>
          <Link href="/distributed-systems">Distributed Systems</Link>
        </nav>
        <div className="sidebar-footer">
          <span
            className={`api-status ${getApiGatewayUrl() ? "ok" : "missing"}`}
          >
            {getApiGatewayUrl() ? "Gateway configured" : "Gateway missing"}
          </span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Consensus and coordination</p>
            <h1>Distributed Systems</h1>
          </div>
          <div className="topbar-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => void runAction("load-dashboard", loadDashboardData)}
              disabled={Boolean(busyAction)}
            >
              Load Dashboard Data
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void runAction("monitoring-check", runMonitoringCheck)}
              disabled={Boolean(busyAction)}
            >
              Run Monitoring Check
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction("election", () =>
                  coordinatorRequest("/election/start", { method: "POST" }),
                )
              }
              disabled={Boolean(busyAction)}
            >
              Start Election
            </button>
          </div>
        </header>

        <section className="content-stack">
          {error ? <div className="toast critical">{error}</div> : null}

          <article className="panel">
            <div className="section-header compact">
              <h3>Manual test control mode</h3>
              <StatusBadge value="manual only" />
            </div>
            <p>
              This dashboard does not start tests, simulations, leader elections,
              broadcasts, RSM transitions, node failures, payments, or ticket
              issuing automatically. Use the buttons on this page to run each
              action explicitly as a system administrator.
            </p>
          </article>

          <KpiGrid
            items={[
              ["Leader", leader?.leader?.node_id || "none"],
              [
                "Election term",
                String(leader?.term ?? cluster?.current_term ?? "n/a"),
              ],
              [
                "Quorum",
                String(faultTolerance?.quorum ?? cluster?.quorum ?? "n/a"),
              ],
              [
                "Tolerated faults",
                String(
                  faultTolerance?.tolerated_faults ??
                    cluster?.tolerated_faults ??
                    "n/a",
                ),
              ],
            ]}
          />

          <div className="detail-layout">
            <article className="panel">
              <div className="section-header compact">
                <h3>Fault Tolerance</h3>
                <StatusBadge
                  value={faultTolerance?.liveness_status || "unknown"}
                />
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Failure model</dt>
                  <dd>{faultTolerance?.failure_model || "n/a"}</dd>
                </div>
                <div>
                  <dt>Safety</dt>
                  <dd>
                    <StatusBadge
                      value={faultTolerance?.safety_status || "unknown"}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Liveness</dt>
                  <dd>
                    <StatusBadge
                      value={faultTolerance?.liveness_status || "unknown"}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Crashed nodes</dt>
                  <dd>{faultTolerance?.crashed_nodes?.join(", ") || "none"}</dd>
                </div>
              </dl>
              <p>
                {faultTolerance?.explanation ||
                  "Load fault tolerance state to inspect the cluster."}
              </p>
            </article>

            <article className="panel">
              <div className="section-header compact">
                <h3>Current Leader</h3>
                <StatusBadge
                  value={leader?.healthy_leader ? "healthy" : "missing"}
                />
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Leader</dt>
                  <dd>{leader?.leader?.node_id || "none"}</dd>
                </div>
                <div>
                  <dt>Term</dt>
                  <dd>{leader?.term ?? "n/a"}</dd>
                </div>
                <div>
                  <dt>Heartbeat</dt>
                  <dd>{formatValue(leader?.leader?.last_heartbeat_at)}</dd>
                </div>
                <div>
                  <dt>Local node</dt>
                  <dd>{cluster?.local_node_id || "n/a"}</dd>
                </div>
              </dl>
              <p>{leader?.explanation || "Start an election to create a leader."}</p>
              <div className="button-row">
                <button
                  type="button"
                  onClick={() =>
                    void runAction("heartbeat", () =>
                      coordinatorRequest("/election/heartbeat", {
                        method: "POST",
                      }),
                    )
                  }
                  disabled={Boolean(busyAction)}
                >
                  Send Heartbeat
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runAction("step-down", () =>
                      coordinatorRequest("/election/step-down", {
                        method: "POST",
                      }),
                    )
                  }
                  disabled={Boolean(busyAction)}
                >
                  Step Down
                </button>
              </div>
            </article>
          </div>

          <DataTable
            title="Coordinator Cluster"
            rows={nodes as unknown as JsonRecord[]}
            columns={[
              "node_id",
              "role",
              "status",
              "current_term",
              "voted_for",
              "last_heartbeat_at",
            ]}
            renderActions={(row) => {
              const nodeId = String(row.node_id || "");

              return (
                <div className="button-row">
                  <button
                    type="button"
                    onClick={() =>
                      void runAction(`crash-${nodeId}`, () =>
                        coordinatorRequest(
                          `/nodes/${encodeURIComponent(nodeId)}/crash`,
                          { method: "POST" },
                        ),
                      )
                    }
                    disabled={Boolean(busyAction)}
                  >
                    Crash
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runAction(`recover-${nodeId}`, () =>
                        coordinatorRequest(
                          `/nodes/${encodeURIComponent(nodeId)}/recover`,
                          { method: "POST" },
                        ),
                      )
                    }
                    disabled={Boolean(busyAction)}
                  >
                    Recover
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runAction(`catch-up-${nodeId}`, () =>
                        coordinatorRequest(
                          `/nodes/${encodeURIComponent(nodeId)}/catch-up`,
                          { method: "POST" },
                        ),
                      )
                    }
                    disabled={Boolean(busyAction)}
                  >
                    Catch Up
                  </button>
                </div>
              );
            }}
          />

          <section className="content-stack">
            <div className="section-header">
              <div>
                <p className="eyebrow">Infrastructure estimation</p>
                <h2>Infrastructure Topology</h2>
              </div>
              <StatusBadge
                value={`${infrastructure?.total_services ?? 0} services`}
              />
            </div>
            <KpiGrid
              items={[
                [
                  "Databases",
                  String(infrastructure?.total_databases ?? "n/a"),
                ],
                [
                  "Coordinator nodes",
                  String(infrastructure?.coordinator_cluster_size ?? "n/a"),
                ],
                [
                  "Peak users",
                  String(infrastructure?.peak_concurrent_users ?? "n/a"),
                ],
                [
                  "QR validations/min",
                  String(
                    infrastructure?.estimated_qr_validations_per_min ?? "n/a",
                  ),
                ],
              ]}
            />
            <DataTable
              title="Service Topology"
              rows={(infrastructure?.topology || []) as unknown as JsonRecord[]}
              columns={[
                "service_name",
                "service_type",
                "replicas",
                "database_name",
                "estimated_rps",
                "status",
              ]}
            />
          </section>

          <div className="detail-layout">
            <article className="panel form-stack">
              <div className="section-header compact">
                <h3>Sync Broadcast Demo</h3>
                <StatusBadge value="synchronous" />
              </div>
              <input
                value={bookingId}
                onChange={(event) => setBookingId(event.target.value)}
                aria-label="Booking id"
              />
              <button
                className="primary-button"
                type="button"
                onClick={() =>
                  void runAction("sync-broadcast", () =>
                    coordinatorRequest("/broadcast/sync", {
                      method: "POST",
                      body: {
                        event_type: "PAYMENT_SUCCEEDED",
                        booking_id: bookingId,
                        payload: {
                          source: "dashboard",
                        },
                      },
                    }),
                  )
                }
                disabled={Boolean(busyAction)}
              >
                Sync Broadcast
              </button>
            </article>

            <article className="panel form-stack">
              <div className="section-header compact">
                <h3>Async Broadcast Demo</h3>
                <StatusBadge value="asynchronous" />
              </div>
              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() =>
                    void runAction("async-broadcast", () =>
                      coordinatorRequest("/broadcast/async", {
                        method: "POST",
                        body: {
                          event_type: "PAYMENT_SUCCEEDED",
                          booking_id: bookingId,
                          payload: {
                            source: "dashboard",
                          },
                        },
                      }),
                    )
                  }
                  disabled={Boolean(busyAction)}
                >
                  Queue Async
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runAction("process-outbox", () =>
                      coordinatorRequest("/outbox/process", { method: "POST" }),
                    )
                  }
                  disabled={Boolean(busyAction)}
                >
                  Process Outbox
                </button>
              </div>
              <JsonPanel title="Outbox counts" value={outbox?.counts || {}} />
            </article>
          </div>

          <DataTable
            title="Consensus Outbox"
            rows={(outbox?.items || []) as JsonRecord[]}
            columns={[
              "id",
              "log_index",
              "target_node_id",
              "message_type",
              "status",
              "retry_count",
              "last_error",
            ]}
          />

          <DataTable
            title="Replicated Log"
            rows={logs as unknown as JsonRecord[]}
            columns={[
              "log_index",
              "term",
              "leader_id",
              "booking_id",
              "event_type",
              "ordering_type",
              "status",
              "ack_count",
              "commit_quorum",
            ]}
          />

          <section className="content-stack">
            <div className="section-header">
              <div>
                <p className="eyebrow">Replicated state machine</p>
                <h2>RSM Demo</h2>
              </div>
              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void runAction("start-rsm", startRsm)}
                  disabled={Boolean(busyAction)}
                >
                  Start RSM
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runAction(
                      "rsm-transition",
                      applyNextRsmTransition,
                      currentRsmId,
                    )
                  }
                  disabled={Boolean(busyAction)}
                >
                  Apply Next Valid
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void runAction("invalid-rsm", tryInvalidTransition)
                  }
                  disabled={Boolean(busyAction)}
                >
                  Try Invalid Transition
                </button>
              </div>
            </div>

            <div className="detail-layout">
              <article className="panel">
                <h3>Current State</h3>
                <dl className="detail-grid">
                  <div>
                    <dt>RSM</dt>
                    <dd className="breakable">{currentRsm?.rsm_id || "none"}</dd>
                  </div>
                  <div>
                    <dt>Booking</dt>
                    <dd className="breakable">
                      {currentRsm?.booking_id || "n/a"}
                    </dd>
                  </div>
                  <div>
                    <dt>State</dt>
                    <dd>
                      <StatusBadge
                        value={currentRsm?.current_state || "not started"}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Next event</dt>
                    <dd>{nextRsmEvent || "none"}</dd>
                  </div>
                </dl>
              </article>
              <article className="panel">
                <h3>RSM Instances</h3>
                <select
                  value={currentRsmId}
                  onChange={(event) => {
                    setCurrentRsmId(event.target.value);
                    void refreshDashboard(event.target.value);
                  }}
                >
                  <option value="">Select RSM</option>
                  {rsmList.map((rsm) => (
                    <option key={rsm.rsm_id} value={rsm.rsm_id}>
                      {rsm.booking_id} - {rsm.current_state}
                    </option>
                  ))}
                </select>
              </article>
            </div>

            <DataTable
              title="RSM Transitions"
              rows={transitions as unknown as JsonRecord[]}
              columns={[
                "from_state",
                "to_state",
                "event_type",
                "valid",
                "rejection_reason",
                "log_index",
                "term",
              ]}
            />
          </section>

          <JsonPanel
            title="Last API Result"
            value={lastResult || { status: "no action yet" }}
          />
        </section>
      </main>
    </div>
  );
}

function AccessState({
  title,
  message,
  actionHref,
  actionLabel,
}: {
  title: string;
  message: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <main className="min-h-screen bg-slate-950 px-6 py-16 text-white">
      <section className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center text-center">
        <span className="mb-5 access-logo" />
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.35em] text-cyan-300">
          {APP_NAME}
        </p>
        <h1 className="text-3xl font-black tracking-tight sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300 sm:text-base">
          {message}
        </p>
        {actionHref ? (
          <Link
            href={actionHref}
            className="mt-8 rounded-2xl bg-white px-5 py-3 text-sm font-bold text-slate-950 shadow-lg transition hover:-translate-y-0.5 hover:bg-cyan-100"
          >
            {actionLabel || "Continue"}
          </Link>
        ) : null}
      </section>
    </main>
  );
}

function StatusBadge({ value }: { value?: string | boolean | null }) {
  const rawValue = String(value ?? "unknown");
  const normalized = rawValue.toLowerCase();
  const tone = [
    "healthy",
    "maintained",
    "committed",
    "completed",
    "active",
    "true",
  ].includes(normalized)
    ? "success"
    : ["missing", "unavailable", "crashed", "rejected", "failed", "false"].includes(
          normalized,
        )
      ? "critical"
      : ["pending", "recovering", "degraded"].includes(normalized)
        ? "warning"
        : "info";

  return <span className={`status-badge ${tone}`}>{rawValue}</span>;
}

function KpiGrid({ items }: { items: Array<[string, string | number]> }) {
  return (
    <div className="kpi-grid">
      {items.map(([label, value]) => (
        <article className="kpi-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </div>
  );
}

function DataTable({
  title,
  rows,
  columns,
  renderActions,
}: {
  title: string;
  rows: JsonRecord[];
  columns: string[];
  renderActions?: (row: JsonRecord) => ReactNode;
}) {
  return (
    <section className="table-panel">
      <div className="section-header compact">
        <h3>{title}</h3>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
              {renderActions ? <th>actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (renderActions ? 1 : 0)}>
                  No records loaded.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={`${String(
                    row.id ||
                      row.node_id ||
                      row.rsm_id ||
                      row.log_index ||
                      row.transition_id ||
                      "row",
                  )}-${index}`}
                >
                  {columns.map((column) => (
                    <td key={column}>{formatValue(row[column])}</td>
                  ))}
                  {renderActions ? <td>{renderActions(row)}</td> : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <article className="json-panel">
      <h3>{title}</h3>
      <pre>{JSON.stringify(value || {}, null, 2)}</pre>
    </article>
  );
}

function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

