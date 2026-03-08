# Event-Driven Microservices — NestJS + LocalStack

A fully local, production-style event-driven microservices system implementing the **Saga Choreography Pattern** using AWS SNS/SQS emulated by [LocalStack](https://localstack.cloud). No real AWS account required.

---

## What This Project Does

Four NestJS microservices communicate exclusively through asynchronous events (no direct HTTP calls between services). When an order is placed, a distributed transaction spans all four services via the Saga pattern — with automatic compensation (rollback) on failure.

```
POST /orders
     │
     ▼
 order-service ──(SNS)──▶ inventory-service ──(SNS)──▶ payment-service
                                                               │
     ◀────────────────────────────────────────────────(SNS)────┘
  (status update)                            notification-service
                                             (observes all events)
```

---

## Documentation


| Document                                   | Description                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| **[Architecture](docs/architecture.md)**   | System design, Saga pattern, data models, design decisions              |
| **[Services](docs/services.md)**           | Per-service deep-dive: responsibilities, business logic, event handling |
| **[Messaging](docs/messaging.md)**         | SNS topics, SQS queues, fan-out routing, DLQs, message format           |
| **[API Reference](docs/api.md)**           | Full HTTP endpoint reference with request/response examples             |
| **[LocalStack Guide](docs/localstack.md)** | LocalStack setup, resource inspection, debugging, troubleshooting       |


---

## Quick Start

### Prerequisites


| Tool           | Version | Notes                       |
| -------------- | ------- | --------------------------- |
| Docker Desktop | 4.x+    | Must be running             |
| Docker Compose | v2+     | Bundled with Docker Desktop |


No other tools required. Node.js, AWS CLI, and Prisma all run inside containers.

### 1. Clone and configure

```bash
git clone <repo-url>
cd microservices-localstack
```

No `.env` file is needed — all environment variables are set directly in `docker-compose.yml` for the containerised services.

### 2. Start the stack

```bash
docker compose up --build
```

This will:

1. Pull `postgres:15-alpine` and `localstack/localstack:3.0` images
2. Build all four NestJS service images (installing OpenSSL, npm deps, compiling TypeScript)
3. Start PostgreSQL databases for each service
4. Start LocalStack with SNS + SQS
5. Run `init-aws.sh` inside LocalStack to create all SNS topics, SQS queues, DLQs, and subscriptions
6. Run Prisma migrations and seed data for each service
7. Start all four NestJS services

> **First build takes 3–5 minutes.** Subsequent starts with `docker compose up` (no `--build`) take ~30 seconds.

### 3. Verify everything is running

Wait until you see all four services log `Connected to LocalStack successfully` and `Connected to PostgreSQL`.

```bash
# Check all containers are healthy
docker compose ps

# Quick health check on all services
curl http://localhost:3001/health   # order-service
curl http://localhost:3002/health   # payment-service
curl http://localhost:3003/health   # inventory-service
curl http://localhost:3004/health   # notification-service
```

All should return `{"status":"ok"}`.

---

## Test the Happy Path (amount ≤ 500)

```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p1","quantity":2,"amount":100}'
```

Watch the logs — events flow across all four services automatically:

```
order-service     | Order created: <id> | Status: PENDING
order-service     | [SNS] Published: order.created → order-topic
inventory-service | [SAGA] Stock reserved for order <id>: 2 units of p1
inventory-service | [SNS] Published: inventory.reserved → inventory-topic
payment-service   | [SAGA] Payment SUCCEEDED for order <id>, amount: 100
payment-service   | [SNS] Published: payment.success → payment-topic
order-service     | [SAGA] Payment succeeded for order <id> → marking COMPLETED
notification-service | 📣 NOTIFICATION [ORDER_CREATED]
notification-service | 📣 NOTIFICATION [INVENTORY_RESERVED]
notification-service | 📣 NOTIFICATION [PAYMENT_SUCCESS]
notification-service | 📣 NOTIFICATION [ORDER_COMPLETED]
```

## Test the Failure Path (amount > 500)

```bash
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p1","quantity":1,"amount":600}'
```

Payment fails, order is cancelled, and inventory stock is released (compensation):

```
payment-service   | [SAGA] Payment FAILED for order <id>: amount 600 > 500
payment-service   | [SNS] Published: payment.failed → payment-topic
order-service     | [SAGA] Payment failed for order <id> → CANCELLING
order-service     | [SNS] Published: order.cancelled → order-topic
inventory-service | [SAGA] Releasing reserved stock for cancelled order <id>
```

---

## Ports Reference


| Container            | Host Port | Purpose                      |
| -------------------- | --------- | ---------------------------- |
| order-service        | 3001      | HTTP API                     |
| payment-service      | 3002      | HTTP API                     |
| inventory-service    | 3003      | HTTP API                     |
| notification-service | 3004      | HTTP API                     |
| LocalStack           | 4566      | AWS SNS + SQS endpoint       |
| order-db             | 5436      | PostgreSQL (order_db)        |
| payment-db           | 5433      | PostgreSQL (payment_db)      |
| inventory-db         | 5434      | PostgreSQL (inventory_db)    |
| notification-db      | 5435      | PostgreSQL (notification_db) |


---

## Project Structure

```
microservices-localstack/
├── docker-compose.yml               # Full stack orchestration
├── .env.example                     # Environment variable reference
├── README.md                        # This file
│
├── docs/                            # Extended documentation
│   ├── architecture.md              # System design & data models
│   ├── services.md                  # Per-service reference
│   ├── messaging.md                 # SNS/SQS, events, DLQs
│   ├── api.md                       # HTTP API reference
│   └── localstack.md                # LocalStack guide & debugging
│
├── scripts/
│   └── init-aws.sh                  # LocalStack SNS/SQS bootstrap
│
└── services/
    ├── order-service/               # Port 3001 — accepts orders, tracks status
    │   ├── Dockerfile
    │   ├── package.json
    │   ├── prisma/schema.prisma     # Order, OrderStatus enum
    │   └── src/
    │       ├── orders/              # POST /orders, GET /orders/:id
    │       ├── messaging/           # SNS publisher + SQS consumer
    │       └── prisma/              # PrismaService
    │
    ├── payment-service/             # Port 3002 — processes payments
    │   ├── prisma/schema.prisma     # Payment, PaymentStatus enum
    │   └── src/
    │       ├── payments/            # Business rule: amount > 500 → FAIL
    │       └── messaging/           # Listens to inventory-reserved
    │
    ├── inventory-service/           # Port 3003 — manages stock
    │   ├── prisma/schema.prisma     # Inventory model
    │   ├── prisma/seed.ts           # Seeds p1 (10 units), p2 (5 units)
    │   └── src/
    │       ├── inventory/           # Reserve / release stock logic
    │       └── messaging/           # Listens to order.created, order.cancelled
    │
    └── notification-service/        # Port 3004 — logs all events
        ├── prisma/schema.prisma     # Notification log model
        └── src/
            ├── notifications/       # GET /notifications
            └── messaging/           # Listens to all event types
```

---

## Useful Commands

```bash
# Start (first time, with build)
docker compose up --build

# Start (subsequent runs, no rebuild)
docker compose up

# Start in background (detached)
docker compose up -d

# View logs for a specific service
docker compose logs -f order-service
docker compose logs -f inventory-service payment-service

# Restart a single service
docker compose restart inventory-service

# Stop everything, keep DB volumes
docker compose down

# Stop everything and wipe all data (fresh start)
docker compose down -v

# Rebuild a single service image
docker compose build order-service
docker compose up -d order-service
```

---

## Seed Data

The inventory service seeds the following products on first startup:


| Product ID | Available Stock | Reserved Stock |
| ---------- | --------------- | -------------- |
| p1         | 10              | 0              |
| p2         | 5               | 0              |


Use `productId: "p1"` or `productId: "p2"` when testing.

---

## Business Rules Summary


| Rule               | Detail                                            |
| ------------------ | ------------------------------------------------- |
| Payment threshold  | `amount > 500` → payment fails, saga rolls back   |
| DLQ retry policy   | 3 failed delivery attempts → message moved to DLQ |
| Order success path | PENDING → (RESERVED) → COMPLETED                  |
| Order failure path | PENDING → (RESERVED) → CANCELLED                  |
| Stock on failure   | Reserved stock is released back to available      |


