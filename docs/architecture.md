# Architecture

This document covers the system design, architectural patterns, data models, and key design decisions.

---

## Table of Contents

- [System Overview](#system-overview)
- [Saga Choreography Pattern](#saga-choreography-pattern)
- [Service Boundaries](#service-boundaries)
- [Complete Event Flow](#complete-event-flow)
  - [Success Path](#success-path)
  - [Failure Path and Compensation](#failure-path-and-compensation)
- [Data Models](#data-models)
- [Docker Network Topology](#docker-network-topology)
- [Design Decisions](#design-decisions)

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                      Docker Network (bridge)                     │
│                                                                  │
│  ┌─────────────────┐         ┌──────────────────────────────┐    │
│  │  order-service  │ ──SNS──▶│         LocalStack           │    │
│  │     :3001       │◀──SQS── │   SNS Topics:                │    │
│  │   [order-db]    │         │    • order-topic             │    │
│  └─────────────────┘         │    • payment-topic           │    │
│                              │    • inventory-topic         │    │
│  ┌─────────────────┐         │                              │    │
│  │ payment-service │ ──SNS──▶│   SQS Queues (+DLQs):        │    │
│  │     :3002       │◀──SQS── │    • order-queue             │    │
│  │  [payment-db]   │         │    • payment-queue           │    │
│  └─────────────────┘         │    • inventory-queue         │    │
│                              │    • notification-queue      │    │
│  ┌─────────────────┐         │                              │    │
│  │inventory-service│ ──SNS──▶│   Fan-out (SNS→SQS):         │    │
│  │     :3003       │◀──SQS── │    order-topic →             │    │
│  │ [inventory-db]  │         │      inventory-queue         │    │
│  └─────────────────┘         │      notification-queue      │    │
│                              │    inventory-topic →         │    │
│  ┌─────────────────┐         │      payment-queue           │    │
│  │  notification-  │◀──SQS── │      notification-queue      │    │
│  │  service :3004  │         │    payment-topic →           │    │
│  │[notification-db]│         │      order-queue             │    │
│  └─────────────────┘         │      notification-queue      │    │
│                              └──────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

**Key property**: services never call each other directly over HTTP. Every coordination happens through events published to SNS topics and consumed from SQS queues.

---

## Saga Choreography Pattern

This system implements the **Choreography-based Saga** pattern for distributed transactions.

### What is a Saga?

A Saga is a sequence of local transactions where each step publishes an event that triggers the next step. If any step fails, compensating transactions are run in reverse to undo the effects of previous steps.

### Choreography vs. Orchestration

| | Choreography (this project) | Orchestration |
| --- | --- | --- |
| Control | Distributed — each service reacts to events | Centralised — a coordinator tells each service what to do |
| Coupling | Services only know about events, not each other | Services are coupled to the orchestrator |
| Complexity | Logic is spread across services | Logic is centralised in one place |
| Resilience | No single point of failure | Orchestrator is a bottleneck |

### How Choreography Works Here

Each service:
1. Subscribes to one or more SQS queues
2. Receives events, performs its local transaction
3. Publishes a result event to its SNS topic
4. The next service in the chain reacts to that event

No service knows which other service will handle its event. The routing is handled entirely by SNS-to-SQS subscriptions set up in `scripts/init-aws.sh`.

---

## Service Boundaries

Each service owns its domain completely — its own database, its own business logic, and its own event contracts.

| Service | Domain | Owns | Listens To | Publishes To |
| --- | --- | --- | --- | --- |
| order-service | Order lifecycle | `orders` table | `order-queue` (payment-topic events) | `order-topic` |
| inventory-service | Stock management | `inventory` table | `inventory-queue` (order-topic events) | `inventory-topic` |
| payment-service | Payment processing | `payments` table | `payment-queue` (inventory-topic events) | `payment-topic` |
| notification-service | Audit / notification log | `notifications` table | `notification-queue` (all topics) | — |

---

## Complete Event Flow

### Success Path

```
Client
  │
  │  POST /orders { productId: "p1", quantity: 2, amount: 100 }
  ▼
┌────────────────────────────────────────────────────────────┐
│ order-service                                              │
│  1. Creates Order record (status: PENDING)                 │
│  2. Publishes ──▶ order-topic                              │
│                   event: order.created                     │
│                   payload: { orderId, productId,           │
│                              quantity, amount }            │
└────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┴──────────────────┐
         ▼                                       ▼
┌──────────────────────┐             ┌──────────────────────┐
│  inventory-service   │             │ notification-service │
│  (inventory-queue)   │             │ (notification-queue) │
│                      │             │                      │
│  Receives:           │             │  Logs:               │
│    order.created     │             │    ORDER_CREATED      │
│                      │             └──────────────────────┘
│  Checks:             │
│    availableStock    │
│    >= quantity?      │
│                      │
│  Updates DB:         │
│    availableStock -= 2│
│    reservedStock  += 2│
│                      │
│  Publishes ──▶       │
│    inventory-topic   │
│    event:            │
│      inventory.      │
│      reserved        │
└──────────────────────┘
         │
         ├─────────────────────────────────────┐
         ▼                                     ▼
┌──────────────────────┐           ┌──────────────────────┐
│  payment-service     │           │ notification-service │
│  (payment-queue)     │           │                      │
│                      │           │  Logs:               │
│  Receives:           │           │    INVENTORY_RESERVED │
│    inventory.reserved│           └──────────────────────┘
│                      │
│  Creates Payment     │
│    record (PENDING)  │
│                      │
│  Checks:             │
│    amount (100)      │
│    <= 500? ✓         │
│                      │
│  Updates Payment:    │
│    status: SUCCESS   │
│                      │
│  Publishes ──▶       │
│    payment-topic     │
│    event:            │
│      payment.success │
└──────────────────────┘
         │
         ├─────────────────────────────────────┐
         ▼                                     ▼
┌──────────────────────┐           ┌──────────────────────┐
│  order-service       │           │ notification-service │
│  (order-queue)       │           │                      │
│                      │           │  Logs:               │
│  Receives:           │           │    PAYMENT_SUCCESS    │
│    payment.success   │           └──────────────────────┘
│                      │
│  Updates Order:      │
│    status: COMPLETED │
│                      │
│  Publishes ──▶       │
│    order-topic       │
│    event:            │
│      order.completed │
└──────────────────────┘
         │
         ▼
┌──────────────────────┐
│ notification-service │
│  Logs:               │
│    ORDER_COMPLETED   │
└──────────────────────┘

Final state:
  Order status:   COMPLETED
  Payment status: SUCCESS
  Inventory:      availableStock = 8, reservedStock = 2
```

### Failure Path and Compensation

```
Client
  │
  │  POST /orders { productId: "p1", quantity: 1, amount: 600 }
  ▼
order-service → order.created (same as success path)
      │
      ▼
inventory-service → inventory.reserved (same as success path)
      │
      ▼
┌────────────────────────────────────────────────────────────┐
│ payment-service                                            │
│  Receives: inventory.reserved                              │
│  Checks: amount (600) > 500? ✗ FAIL                       │
│  Updates Payment: status = FAILED                          │
│  Publishes ──▶ payment-topic                               │
│               event: payment.failed                        │
│               payload: { orderId, paymentId,               │
│                          amount, reason }                  │
└────────────────────────────────────────────────────────────┘
         │
         ├─────────────────────────────────────┐
         ▼                                     ▼
┌──────────────────────┐           ┌──────────────────────┐
│  order-service       │           │ notification-service │
│  (order-queue)       │           │  Logs: PAYMENT_FAILED │
│                      │           └──────────────────────┘
│  Receives:           │
│    payment.failed    │
│  Updates Order:      │
│    status: CANCELLED │
│  Publishes ──▶       │
│    order-topic       │
│    event:            │
│      order.cancelled │
└──────────────────────┘
         │
         ├─────────────────────────────────────┐
         ▼                                     ▼
┌──────────────────────┐           ┌──────────────────────┐
│  inventory-service   │           │ notification-service │
│  (inventory-queue)   │           │  Logs:               │
│                      │           │    ORDER_CANCELLED    │
│  Receives:           │           └──────────────────────┘
│    order.cancelled   │
│  ← COMPENSATION →    │
│  Releases stock back │
│  Publishes ──▶       │
│    inventory-topic   │
│    event:            │
│      inventory.      │
│      released        │
└──────────────────────┘
         │
         ▼
┌──────────────────────┐
│ notification-service │
│  Logs:               │
│    INVENTORY_RELEASED│
└──────────────────────┘

Final state:
  Order status:   CANCELLED
  Payment status: FAILED
  Inventory:      stock fully restored (compensation)
```

---

## Data Models

### order-service — `order_db`

```prisma
model Order {
  id        String      @id @default(uuid())
  productId String
  quantity  Int
  amount    Float
  status    OrderStatus @default(PENDING)
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
}

enum OrderStatus {
  PENDING     // Created, awaiting inventory reservation
  RESERVED    // (intermediate, set by inventory confirmation in full impl)
  COMPLETED   // Payment succeeded
  CANCELLED   // Payment failed, saga rolled back
}
```

### payment-service — `payment_db`

```prisma
model Payment {
  id        String        @id @default(uuid())
  orderId   String
  amount    Float
  status    PaymentStatus @default(PENDING)
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt
}

enum PaymentStatus {
  PENDING   // Payment record created, processing
  SUCCESS   // amount <= 500
  FAILED    // amount > 500
}
```

### inventory-service — `inventory_db`

```prisma
model Inventory {
  id             String   @id @default(uuid())
  productId      String   @unique
  availableStock Int      @default(0)
  reservedStock  Int      @default(0)
  updatedAt      DateTime @updatedAt
}
```

**Stock transition on reservation:**
```
availableStock -= quantity
reservedStock  += quantity
```

**Stock transition on release (compensation):**
```
availableStock += quantity
reservedStock  -= quantity
```

### notification-service — `notification_db`

```prisma
model Notification {
  id        String   @id @default(uuid())
  type      String   // e.g. "ORDER_CREATED", "PAYMENT_FAILED"
  message   String   // human-readable description
  createdAt DateTime @default(now())
}
```

---

## Docker Network Topology

All containers run on a single `bridge` network called `microservices-net`. Container DNS is used for service discovery — services refer to each other by container name, not IP.

```
Container name    → DNS hostname
──────────────────────────────
localstack        → localstack:4566
order-db          → order-db:5432
payment-db        → payment-db:5432
inventory-db      → inventory-db:5432
notification-db   → notification-db:5432
```

Services connect to LocalStack at `http://localstack:4566` inside the network, and at `http://localhost:4566` from the host machine.

### Startup Order (depends_on)

Each service waits for two health checks before starting:
1. Its own database (`service_healthy` condition on pg_isready)
2. LocalStack (`service_healthy` condition on curl health endpoint)

```
localstack ──────────────────────────────────┐
order-db ──────────────────────────────┐     │
payment-db ──────────────────────┐     │     │
inventory-db ──────────────┐     │     │     │
notification-db ──────┐    │     │     │     │
                      ▼    ▼     ▼     ▼     ▼
              notification payment inventory order
              -service   -service  -service  -service
```

---

## Design Decisions

### Why Choreography over Orchestration?

Choreography was chosen to demonstrate a fully decentralised architecture. There is no central coordinator that becomes a bottleneck or single point of failure. Each service is independently deployable and only knows about its own event contracts.

### Why each service gets its own database?

This enforces the **Database-per-Service** pattern, a core microservices principle. No service can read or write another service's data directly. All state sharing happens through events. This means:
- Services can use different DB schemas independently
- Migrations in one service don't affect others
- Services can be scaled or replaced independently

### Why LocalStack instead of real AWS?

LocalStack provides a fully local AWS emulator, making the project:
- **Zero cost** — no AWS bill
- **Offline capable** — works without internet
- **Fast** — no network latency to real AWS
- **Reproducible** — same environment for every developer

The code is 100% compatible with real AWS — changing `AWS_ENDPOINT` to a real AWS endpoint and using real credentials is all that's needed to deploy to production.

### Why Prisma?

Prisma provides type-safe database access with schema-first development. The `prisma/schema.prisma` file serves as the single source of truth for the database schema, and the generated client provides full TypeScript autocompletion.

### Why SQS Long Polling?

Each service's consumer uses SQS long polling (`WaitTimeSeconds: 20`). This means the consumer waits up to 20 seconds for a message before returning an empty response. This is far more efficient than short polling (which hammers the queue) and reduces costs on real AWS.
