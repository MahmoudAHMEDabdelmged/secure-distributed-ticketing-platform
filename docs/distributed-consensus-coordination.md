# Distributed Consensus & Coordination Engine

This phase adds a real `coordinator-service` and `coordinator-db` for the course distributed systems requirements. It is not documentation-only: every concept is backed by tables, service endpoints, API Gateway routes, and the `/distributed-systems` dashboard.

## How To Run

1. Apply `database/coordinator-db/migrations/001_create_coordinator_tables.sql` to a new PostgreSQL database named `coordinator-db` or to a Neon database dedicated to the coordinator.
2. Copy `services/coordinator-service/.env.example` to `services/coordinator-service/.env` and set `COORDINATOR_DATABASE_URL`.
3. Install and start the service:

```powershell
cd services\coordinator-service
npm install
$env:NODE_ID="coordinator-node-1"; $env:PORT="4010"; npm start
```

For the 3-node demo, start three terminals:

```powershell
$env:NODE_ID="coordinator-node-1"; $env:PORT="4010"; npm start
$env:NODE_ID="coordinator-node-2"; $env:PORT="4011"; npm start
$env:NODE_ID="coordinator-node-3"; $env:PORT="4012"; npm start
```

Point the API Gateway at node 1:

```env
COORDINATOR_SERVICE_URL=http://localhost:4010
```

The gateway exposes the service at `/api/coordinator/...`. These routes are intentionally unauthenticated for the course demo, matching the existing demo-style internal routes. Add admin JWT/RBAC before using them outside a controlled environment.

## Requirement Mapping

Infrastructure estimation is implemented by `infrastructure_topology` and:

- `GET /api/coordinator/infrastructure/topology`
- `GET /api/coordinator/infrastructure/capacity`
- `GET /api/coordinator/infrastructure/summary`

Fault tolerance is implemented with a crash-recovery model in `coordinator_nodes` and `fault_injection_events`:

- `GET /api/coordinator/fault-tolerance`
- `POST /api/coordinator/nodes/:nodeId/crash`
- `POST /api/coordinator/nodes/:nodeId/recover`
- `POST /api/coordinator/nodes/:nodeId/catch-up`

Leader election is simplified Raft-style and persisted in `leader_terms`, `leader_votes`, `heartbeats`, and `coordinator_nodes`:

- `GET /api/coordinator/cluster`
- `GET /api/coordinator/leader`
- `POST /api/coordinator/election/start`
- `POST /api/coordinator/election/heartbeat`
- `POST /api/coordinator/election/step-down`

Message ordering is stored in `replicated_log`, `log_replication_acks`, `rsm_instances`, and `rsm_transitions`:

- FIFO: `POST /api/coordinator/ordering/fifo/demo`
- Causal: `POST /api/coordinator/ordering/causal/validate`
- Total: `GET /api/coordinator/ordering/total/log`

Broadcast protocols use `broadcast_messages`, `broadcast_acks`, `replicated_log`, `log_replication_acks`, and `consensus_outbox`:

- `POST /api/coordinator/broadcast/sync`
- `POST /api/coordinator/broadcast/async`
- `GET /api/coordinator/outbox`
- `POST /api/coordinator/outbox/process`

The replicated state machine is implemented by:

- `POST /api/coordinator/rsm/start`
- `POST /api/coordinator/rsm/:rsmId/transition`
- `GET /api/coordinator/rsm/:rsmId`
- `GET /api/coordinator/rsm`
- `GET /api/coordinator/rsm/:rsmId/transitions`

## Fault Tolerance Math

The coordinator cluster follows the majority rule:

```text
n = 2f + 1
f = floor((n - 1) / 2)
quorum = floor(n / 2) + 1
```

For the default `n = 3`, the system tolerates `f = 1` crash failure. Safety is maintained even below quorum because new transitions are not committed without a majority. Liveness is unavailable below quorum because the cluster cannot commit new replicated log entries.

## Message Ordering

FIFO ordering is demonstrated per booking by writing ordered `replicated_log` entries with `ordering_type = 'fifo'` and payload `sequence_number`.

Causal ordering is enforced by the RSM transition map:

```text
INIT -> BOOKING_CREATED
BOOKING_CREATED -> PAYMENT_PENDING
PAYMENT_PENDING -> PAYMENT_SUCCEEDED
PAYMENT_PENDING -> PAYMENT_FAILED
PAYMENT_PENDING -> PAYMENT_SUSPICIOUS
PAYMENT_SUCCEEDED -> TICKET_ISSUED
TICKET_ISSUED -> NOTIFICATION_PENDING
NOTIFICATION_PENDING -> NOTIFICATION_SENT
NOTIFICATION_SENT -> COMPLETED
PAYMENT_FAILED -> COMPENSATED
PAYMENT_SUSPICIOUS -> COMPENSATED
```

Invalid transitions, such as `INIT -> TICKET_ISSUED`, return `409` with `CAUSAL_ORDER_VIOLATION` and are logged.

Total ordering is the monotonic `replicated_log.log_index`. Committed sync and async broadcasts record ACKs for the same `log_index` across coordinator nodes.

## Broadcast Protocols

Synchronous broadcast waits for ACKs or timeouts in the request. Healthy nodes ACK, crashed nodes timeout, and the log commits only when `received_acks >= quorum`.

Asynchronous broadcast writes the leader append immediately, creates `consensus_outbox` messages for followers, and commits when later outbox processing or catch-up reaches quorum. Crashed targets remain `retrying` until recovery.

## Leader Election

`POST /api/coordinator/election/start` increments the term, lets the candidate vote for itself, records healthy-node votes, and elects the candidate when votes reach quorum. If the leader crashes, `GET /api/coordinator/leader` reports no healthy leader and a new election can elect another healthy node.

## Replicated State Machine

`rsm_instances` stores the current booking workflow state. `rsm_transitions` stores accepted and rejected transitions. A valid transition appends to `replicated_log`, synchronously broadcasts to the cluster, commits only with quorum, and then advances the RSM state.

The dashboard at `/distributed-systems` exposes cluster state, safety/liveness status, crash/recover controls, election controls, sync/async broadcast demos, the replicated log, and the RSM demo.
