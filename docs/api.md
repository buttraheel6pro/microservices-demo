# API Reference

Complete HTTP API documentation for all four services. All endpoints are available on `localhost` when the stack is running via `docker compose up`.

---

## Table of Contents

- [Base URLs](#base-urls)
- [order-service](#order-service-api)
- [notification-service](#notification-service-api)
- [Health Endpoints](#health-endpoints)
- [Error Responses](#error-responses)
- [Example Workflows](#example-workflows)

---

## Base URLs

| Service | Base URL |
| --- | --- |
| order-service | `http://localhost:3001` |
| payment-service | `http://localhost:3002` |
| inventory-service | `http://localhost:3003` |
| notification-service | `http://localhost:3004` |

> payment-service and inventory-service have no HTTP endpoints beyond `/health`. They are event-driven only.

---

## order-service API

### POST /orders

Creates a new order. This is the entry point for the entire Saga.

**URL:** `POST http://localhost:3001/orders`

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**

| Field | Type | Required | Constraints | Description |
| --- | --- | --- | --- | --- |
| `productId` | string | Yes | non-empty string | Product identifier (e.g. `"p1"`, `"p2"`) |
| `quantity` | integer | Yes | `>= 1` | Number of units to order |
| `amount` | number | Yes | `>= 0.01` | Total order value in currency units |

**Example — Success path (amount ≤ 500):**

```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "p1",
    "quantity": 2,
    "amount": 100
  }'
```

**Example — Failure path (amount > 500):**

```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "p1",
    "quantity": 1,
    "amount": 600
  }'
```

**Response — 201 Created:**

The response is the freshly created order record. At this point the status is always `PENDING` — the Saga has not yet completed.

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "productId": "p1",
  "quantity": 2,
  "amount": 100,
  "status": "PENDING",
  "createdAt": "2026-03-04T17:30:00.000Z",
  "updatedAt": "2026-03-04T17:30:00.000Z"
}
```

**Response fields:**

| Field | Type | Description |
| --- | --- | --- |
| `id` | UUID string | Order identifier — save this to poll status |
| `productId` | string | Product ordered |
| `quantity` | integer | Units ordered |
| `amount` | number | Order value |
| `status` | string | `PENDING` \| `COMPLETED` \| `CANCELLED` |
| `createdAt` | ISO 8601 string | Creation timestamp |
| `updatedAt` | ISO 8601 string | Last update timestamp |

**Response — 400 Bad Request (validation failure):**

```json
{
  "message": [
    "productId must be a string",
    "quantity must not be less than 1",
    "amount must not be less than 0.01"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

---

### GET /orders/:id

Retrieves a single order by ID. Use this to poll the final status after placing an order.

**URL:** `GET http://localhost:3001/orders/:id`

**Path Parameters:**

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | UUID string | Order ID returned by POST /orders |

**Example:**

```bash
curl http://localhost:3001/orders/550e8400-e29b-41d4-a716-446655440000
```

**Response — 200 OK:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "productId": "p1",
  "quantity": 2,
  "amount": 100,
  "status": "COMPLETED",
  "createdAt": "2026-03-04T17:30:00.000Z",
  "updatedAt": "2026-03-04T17:30:05.123Z"
}
```

**Status values and their meaning:**

| Status | Meaning |
| --- | --- |
| `PENDING` | Order created, Saga in progress |
| `COMPLETED` | Payment succeeded, order fulfilled |
| `CANCELLED` | Payment failed, saga rolled back |

**Response — 404 Not Found:**

```json
{
  "message": "Order 550e8400-e29b-41d4-a716-446655440000 not found",
  "error": "Not Found",
  "statusCode": 404
}
```

---

## notification-service API

### GET /notifications

Returns all notification records in reverse chronological order (newest first). This gives a full audit log of every event that passed through the system.

**URL:** `GET http://localhost:3004/notifications`

**Example:**

```bash
curl http://localhost:3004/notifications
```

**Response — 200 OK:**

```json
[
  {
    "id": "7a1b2c3d-...",
    "type": "order.completed",
    "message": "Order 550e8400-... has been completed successfully",
    "createdAt": "2026-03-04T17:30:05.500Z"
  },
  {
    "id": "6e9f0a1b-...",
    "type": "payment.success",
    "message": "Payment succeeded for order 550e8400-..., amount: 100",
    "createdAt": "2026-03-04T17:30:04.800Z"
  },
  {
    "id": "5d8e9f0a-...",
    "type": "inventory.reserved",
    "message": "Inventory reserved for order 550e8400-...: 2 units of p1",
    "createdAt": "2026-03-04T17:30:03.200Z"
  },
  {
    "id": "4c7d8e9f-...",
    "type": "order.created",
    "message": "Order 550e8400-... created for product p1, qty: 2, amount: 100",
    "createdAt": "2026-03-04T17:30:00.100Z"
  }
]
```

**Response fields:**

| Field | Type | Description |
| --- | --- | --- |
| `id` | UUID string | Notification record ID |
| `type` | string | Event type (e.g. `"order.created"`, `"payment.failed"`) |
| `message` | string | Human-readable description of the event |
| `createdAt` | ISO 8601 string | When the notification was recorded |

---

## Health Endpoints

All four services expose a `/health` endpoint for liveness checks.

**URL pattern:** `GET http://localhost:<PORT>/health`

```bash
curl http://localhost:3001/health   # order-service
curl http://localhost:3002/health   # payment-service
curl http://localhost:3003/health   # inventory-service
curl http://localhost:3004/health   # notification-service
```

**Response — 200 OK:**

```json
{ "status": "ok" }
```

These endpoints are also used by Docker Compose for the `service_healthy` condition, but each service's healthcheck is handled by Docker itself (via `pg_isready` and `curl` checks in `docker-compose.yml`), not this endpoint.

---

## Error Responses

### Validation Errors (400)

The order-service uses `class-validator` via `ValidationPipe`. Invalid request bodies return a 400 with a list of validation messages:

```json
{
  "message": ["quantity must be an integer number"],
  "error": "Bad Request",
  "statusCode": 400
}
```

### Not Found (404)

```json
{
  "message": "Order <id> not found",
  "error": "Not Found",
  "statusCode": 404
}
```

### Internal Server Error (500)

Unexpected errors return a 500. Check service logs with:

```bash
docker compose logs -f order-service
```

---

## Example Workflows

### Full success flow with status polling

```bash
# 1. Create order
ORDER=$(curl -s -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p1","quantity":2,"amount":100}')

echo $ORDER
# → { "id": "abc-123", "status": "PENDING", ... }

ORDER_ID=$(echo $ORDER | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

# 2. Wait for Saga to complete (~3-5 seconds)
sleep 5

# 3. Poll status
curl http://localhost:3001/orders/$ORDER_ID
# → { "id": "abc-123", "status": "COMPLETED", ... }

# 4. View all notifications generated
curl http://localhost:3004/notifications
```

### Full failure flow with compensation verification

```bash
# 1. Create failing order
ORDER=$(curl -s -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p1","quantity":1,"amount":600}')

ORDER_ID=$(echo $ORDER | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

sleep 5

# 2. Confirm order was cancelled
curl http://localhost:3001/orders/$ORDER_ID
# → { "status": "CANCELLED" }

# 3. Confirm notification log shows full compensation chain
curl http://localhost:3004/notifications
# Expect to see: order.created → inventory.reserved →
#                payment.failed → order.cancelled → inventory.released
```

### Test out-of-stock scenario

```bash
# Order all of p2's available stock (5 units) in one go
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p2","quantity":5,"amount":50}'

# Then try to order 1 more unit — inventory.failed should fire
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p2","quantity":1,"amount":10}'
```

### Check notification log for a specific event type

```bash
# Pipe through jq to filter
curl -s http://localhost:3004/notifications | \
  python3 -c "
import sys, json
notifs = json.load(sys.stdin)
for n in notifs:
    if 'payment' in n['type']:
        print(n['type'], '-', n['message'])
"
```
