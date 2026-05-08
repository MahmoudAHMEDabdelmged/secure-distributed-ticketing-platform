# Coordinator Demo Script

Set the gateway base once:

```powershell
$Gateway = "http://localhost:4000/api/coordinator"
```

1. Check cluster:

```powershell
curl.exe "$Gateway/cluster"
```

2. Check fault tolerance:

```powershell
curl.exe "$Gateway/fault-tolerance"
```

3. Start election:

```powershell
curl.exe -X POST "$Gateway/election/start" -H "Content-Type: application/json" -d "{}"
```

4. Crash leader:

```powershell
curl.exe "$Gateway/leader"
curl.exe -X POST "$Gateway/nodes/coordinator-node-1/crash" -H "Content-Type: application/json" -d "{}"
```

If a different node is leader, replace `coordinator-node-1` with that leader id.

5. Start new election:

```powershell
curl.exe -X POST "$Gateway/election/start" -H "Content-Type: application/json" -d "{\"candidate_id\":\"coordinator-node-2\"}"
```

6. Recover crashed node:

```powershell
curl.exe -X POST "$Gateway/nodes/coordinator-node-1/recover" -H "Content-Type: application/json" -d "{}"
```

7. Start RSM:

```powershell
curl.exe -X POST "$Gateway/rsm/start" -H "Content-Type: application/json" -d "{\"booking_id\":\"booking-demo-1\"}"
```

Save the returned `rsm_id` as `$RsmId`:

```powershell
$RsmId = "PUT_RETURNED_RSM_ID_HERE"
```

8. Apply valid transitions:

```powershell
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"BOOKING_CREATED\",\"payload\":{}}"
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"PAYMENT_PENDING\",\"payload\":{}}"
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"PAYMENT_SUCCEEDED\",\"payload\":{}}"
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"TICKET_ISSUED\",\"payload\":{}}"
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"NOTIFICATION_PENDING\",\"payload\":{}}"
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"NOTIFICATION_SENT\",\"payload\":{}}"
curl.exe -X POST "$Gateway/rsm/$RsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"COMPLETED\",\"payload\":{}}"
```

9. Try invalid transition:

```powershell
curl.exe -X POST "$Gateway/rsm/start" -H "Content-Type: application/json" -d "{\"booking_id\":\"booking-invalid-1\"}"
$InvalidRsmId = "PUT_RETURNED_INVALID_RSM_ID_HERE"
curl.exe -X POST "$Gateway/rsm/$InvalidRsmId/transition" -H "Content-Type: application/json" -d "{\"event_type\":\"TICKET_ISSUED\",\"payload\":{}}"
```

Expected: HTTP `409` with `CAUSAL_ORDER_VIOLATION`.

10. Sync broadcast demo:

```powershell
curl.exe -X POST "$Gateway/broadcast/sync" -H "Content-Type: application/json" -d "{\"event_type\":\"PAYMENT_SUCCEEDED\",\"booking_id\":\"booking-demo-1\",\"payload\":{}}"
```

11. Async broadcast demo:

```powershell
curl.exe -X POST "$Gateway/broadcast/async" -H "Content-Type: application/json" -d "{\"event_type\":\"PAYMENT_SUCCEEDED\",\"booking_id\":\"booking-demo-1\",\"payload\":{}}"
curl.exe "$Gateway/outbox"
curl.exe -X POST "$Gateway/outbox/process" -H "Content-Type: application/json" -d "{}"
```

12. Crash node, broadcast, recover, catch up:

```powershell
curl.exe -X POST "$Gateway/nodes/coordinator-node-3/crash" -H "Content-Type: application/json" -d "{}"
curl.exe -X POST "$Gateway/broadcast/async" -H "Content-Type: application/json" -d "{\"event_type\":\"PAYMENT_SUCCEEDED\",\"booking_id\":\"booking-catchup-1\",\"payload\":{}}"
curl.exe -X POST "$Gateway/outbox/process" -H "Content-Type: application/json" -d "{}"
curl.exe -X POST "$Gateway/nodes/coordinator-node-3/recover" -H "Content-Type: application/json" -d "{}"
curl.exe -X POST "$Gateway/nodes/coordinator-node-3/catch-up" -H "Content-Type: application/json" -d "{}"
curl.exe "$Gateway/ordering/total/log"
```
