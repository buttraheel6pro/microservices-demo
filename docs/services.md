# Services Reference

Deep-dive documentation for each of the four microservices: their responsibilities, business logic, event handling, and internal structure.

---

## Table of Contents

- [order-service](#order-service)
- [inventory-service](#inventory-service)
- [payment-service](#payment-service)
- [notification-service](#notification-service)
- [Shared Patterns](#shared-patterns)

---

## order-service

**Port:** `3001`  
**Database:** `order_db` (PostgreSQL, host port `5436`)  
**Container:** `order-service`

### Responsibilities

- Accepts new orders via HTTP API
- Persists orders with initial status `PENDING`
- Publishes `order.created` events to kick off the Saga
- Listens for payment outcomes and updates order status accordingly
- Publishes `order.completed` or `order.cancelled` to close the Saga

### Business Logic

The order-service has no payment or stock logic of its own. It only manages order state transitions based on events it receives:

| Event Received | Action Taken | Event Published |
| --- | --- | --- |
| — (HTTP POST) | Create order (PENDING) | `order.created` |
| `payment.success` | Update order → COMPLETED | `order.completed` |
| `payment.failed` | Update order → CANCELLED | `order.cancelled` |

### Order Status Lifecycle

```
         POST /orders
              │
              ▼
           PENDING ──────────────────────┐
              │                          │
    (inventory + payment succeed)        │  (payment fails)
              │                          │
              ▼                          ▼
          COMPLETED                  CANCELLED
```

> Note: The `RESERVED` status exists in the enum for completeness but is not set by the current implementation — the order goes directly from `PENDING` to `COMPLETED` or `CANCELLED`.

### SQS Queue

`order-queue` — subscribes to `payment-topic`

The consumer polls `order-queue` with long polling (20s wait). It handles:
- `payment.success` → mark COMPLETED, publish `order.completed`
- `payment.failed` → mark CANCELLED, publish `order.cancelled`
- All other event types are silently ignored (logged as debug)

### Key Files

```
services/order-service/src/
├── orders/
│   ├── orders.controller.ts      # POST /orders, GET /orders/:id
│   ├── orders.service.ts         # createOrder(), findById(), updateStatus()
│   └── dto/
│       └── create-order.dto.ts   # productId, quantity, amount validation
├── messaging/
│   ├── messaging.service.ts      # SNS publish + SQS consume + LocalStack connection
│   ├── order-consumer.service.ts # SQS polling loop, event handler switch
│   └── events.ts                 # Typed event constants and payload interfaces
└── prisma/
    └── prisma.service.ts         # Prisma connection with retry logic
```

---

## inventory-service

**Port:** `3003`  
**Database:** `inventory_db` (PostgreSQL, host port `5434`)  
**Container:** `inventory-service`

### Responsibilities

- Manages available and reserved stock per product
- Reserves stock when an order is created (if sufficient stock exists)
- Releases reserved stock when an order is cancelled (compensation)
- Publishes reservation/release/failure events

### Business Logic

#### Stock Reservation

When `order.created` is received:

```
1. Look up inventory record for productId
2. If product not found → publish inventory.failed
3. If availableStock < quantity → publish inventory.failed
4. Otherwise:
   availableStock -= quantity
   reservedStock  += quantity
   → publish inventory.reserved
```

#### Stock Release (Compensation)

When `order.cancelled` is received:

```
1. Receive the cancellation signal
2. Publish inventory.released
   (full implementation would track which order reserved which product)
```

> The current implementation publishes `inventory.released` as a signal; a production system would maintain a `reservations` table linking `orderId → productId + quantity` for precise reversal.

### Seed Data

On first startup, `prisma/seed.ts` seeds two products:

| productId | availableStock | reservedStock |
| --- | --- | --- |
| p1 | 10 | 0 |
| p2 | 5 | 0 |

### SQS Queue

`inventory-queue` — subscribes to `order-topic`

Handles:
- `order.created` → `reserveStock()`
- `order.cancelled` → `releaseStock()`
- Other events ignored

### Key Files

```
services/inventory-service/src/
├── inventory/
│   └── inventory.service.ts       # reserveStock(), releaseStock(), releaseStockForOrder()
├── messaging/
│   ├── messaging.service.ts       # SNS + SQS client
│   ├── inventory-consumer.service.ts  # SQS polling loop
│   └── events.ts                  # Event types
└── prisma/
    └── prisma.service.ts
```

---

## payment-service

**Port:** `3002`  
**Database:** `payment_db` (PostgreSQL, host port `5433`)  
**Container:** `payment-service`

### Responsibilities

- Processes payments triggered by inventory reservations
- Applies the payment threshold business rule
- Persists payment records with outcome status
- Publishes `payment.success` or `payment.failed`

### Business Logic

The core business rule is deliberately simple to make the failure path easy to trigger:

```
PAYMENT_FAIL_THRESHOLD = 500

if (amount > 500):
  payment.status = FAILED
  publish payment.failed
else:
  payment.status = SUCCESS
  publish payment.success
```

This means:
- `amount: 100` → succeeds
- `amount: 500` → succeeds (threshold is `>`, not `>=`)
- `amount: 501` → fails
- `amount: 600` → fails

### Payment Record

A `Payment` record is always created before the outcome is determined, so there is a full audit trail of every payment attempt regardless of success or failure.

### SQS Queue

`payment-queue` — subscribes to `inventory-topic`

Handles:
- `inventory.reserved` → `processPayment()`
- Other events ignored

### Key Files

```
services/payment-service/src/
├── payments/
│   └── payments.service.ts        # processPayment() — core business rule
├── messaging/
│   ├── messaging.service.ts       # SNS + SQS client
│   ├── payment-consumer.service.ts  # SQS polling loop
│   └── events.ts                  # Event types
└── prisma/
    └── prisma.service.ts
```

---

## notification-service

**Port:** `3004`  
**Database:** `notification_db` (PostgreSQL, host port `5435`)  
**Container:** `notification-service`

### Responsibilities

- Observes **all** events across the system
- Persists a log of every event as a `Notification` record
- Provides an HTTP endpoint to retrieve the full notification history

### Design

The notification-service is intentionally a **passive observer** — it publishes no events of its own. It is the only service that subscribes to all three SNS topics (via `notification-queue`).

In a real system this service would send emails, push notifications, SMS messages, or webhook calls. Here it logs to the database and console, providing full observability of the Saga lifecycle.

### Events Handled

| Event | Message Logged |
| --- | --- |
| `order.created` | `Order <id> created for product <productId>, qty: <n>, amount: <x>` |
| `order.completed` | `Order <id> has been completed successfully` |
| `order.cancelled` | `Order <id> has been cancelled. Reason: <reason>` |
| `inventory.reserved` | `Inventory reserved for order <id>: <qty> units of <productId>` |
| `inventory.released` | `Inventory released for order <id>` |
| `inventory.failed` | `Inventory failed for order <id>: <reason>` |
| `payment.success` | `Payment succeeded for order <id>, amount: <x>` |
| `payment.failed` | `Payment failed for order <id>, amount: <x>. Reason: <reason>` |

### Console Output Format

Each notification is printed to stdout in a clearly formatted block:

```
────────────────────────────────────────────────────────────
📣 NOTIFICATION [ORDER_CREATED]
   Message : Order abc-123 created for product p1, qty: 2, amount: 100
   ID      : <uuid>
   At      : 2026-03-04T17:30:00.000Z
────────────────────────────────────────────────────────────
```

### SQS Queue

`notification-queue` — subscribes to **all three** SNS topics:
- `order-topic`
- `inventory-topic`
- `payment-topic`

### Key Files

```
services/notification-service/src/
├── notifications/
│   ├── notifications.controller.ts  # GET /notifications
│   └── notifications.service.ts     # notify(), findAll()
├── messaging/
│   ├── messaging.service.ts          # SNS + SQS client
│   ├── notification-consumer.service.ts  # SQS polling loop
│   └── events.ts                     # Event types
└── prisma/
    └── prisma.service.ts
```

---

## Shared Patterns

All four services share the same internal patterns.

### MessagingService

Each service has its own `MessagingService` instance. It:
- Creates `SNSClient` and `SQSClient` pointed at `AWS_ENDPOINT` (LocalStack)
- Waits for LocalStack to be reachable before proceeding (`waitForLocalStack`)
- Provides `publish(topicName, event)` for publishing
- Provides `receiveMessages(queueName)` and `deleteMessage(queueName, receiptHandle)` for consuming
- Provides `parseEvent(messageBody)` which handles the SNS envelope wrapping

### SQS Message Envelope

When SNS delivers a message to SQS, the original message is wrapped in an SNS envelope:

```json
{
  "Type": "Notification",
  "MessageId": "...",
  "TopicArn": "arn:aws:sns:us-east-1:000000000000:order-topic",
  "Subject": "order.created",
  "Message": "{\"eventType\":\"order.created\",\"timestamp\":\"...\",\"payload\":{...}}",
  "Timestamp": "..."
}
```

`parseEvent()` unwraps this by checking for `outer.Message` and parsing it as the inner event.

### PrismaService

Each service has a `PrismaService` that:
- Extends `PrismaClient`
- Retries database connection up to 10 times with a 3-second delay
- Throws `Error: Could not connect to PostgreSQL` after all retries are exhausted

This retry loop handles the race condition where Docker starts the service container before the database is fully ready to accept connections, even after the `service_healthy` check passes.

### Consumer Services

Each consumer service (`OrderConsumerService`, `InventoryConsumerService`, etc.):
- Implements `OnModuleInit` to start polling after NestJS bootstraps
- Runs an infinite `while(isRunning)` polling loop
- Uses SQS long polling (`WaitTimeSeconds: 20`)
- Processes each message, then deletes it from the queue on success
- On handler error: logs the error but does **not** delete the message (allowing SQS retry → DLQ after 3 attempts)
- On poll error: waits 5 seconds before retrying
