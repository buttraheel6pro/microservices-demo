# Messaging — SNS, SQS, Events, and DLQs

This document covers the messaging infrastructure: how SNS topics and SQS queues are structured, the complete event catalogue, the fan-out routing map, Dead Letter Queue behaviour, and the message format.

---

## Table of Contents

- [Overview](#overview)
- [SNS Topics](#sns-topics)
- [SQS Queues and DLQs](#sqs-queues-and-dlqs)
- [Fan-out Routing Map](#fan-out-routing-map)
- [Event Catalogue](#event-catalogue)
- [Message Format](#message-format)
- [Dead Letter Queue Behaviour](#dead-letter-queue-behaviour)
- [LocalStack Init Script](#localstack-init-script)

---

## Overview

The system uses the **SNS fan-out to SQS** pattern. Each service publishes events to an SNS topic. SNS delivers a copy of each message to every SQS queue that is subscribed to that topic. Each service independently consumes from its own queue — no service receives messages intended for another.

```
Service A publishes to SNS Topic
        │
        ├──▶ SQS Queue X  (consumed by Service B)
        └──▶ SQS Queue Y  (consumed by Service C)
```

This decouples publishers from consumers entirely. Service A does not know how many services are listening or which services they are.

---

## SNS Topics

Three SNS topics are created by `scripts/init-aws.sh` on LocalStack startup:

| Topic Name | ARN (LocalStack) | Published By |
| --- | --- | --- |
| `order-topic` | `arn:aws:sns:us-east-1:000000000000:order-topic` | order-service |
| `inventory-topic` | `arn:aws:sns:us-east-1:000000000000:inventory-topic` | inventory-service |
| `payment-topic` | `arn:aws:sns:us-east-1:000000000000:payment-topic` | payment-service |

> The account ID `000000000000` is LocalStack's default fake account ID.

---

## SQS Queues and DLQs

Each service has one main queue and one Dead Letter Queue. The DLQ is configured with `maxReceiveCount: 3` — after 3 failed delivery attempts, the message is automatically moved to the DLQ.

| Main Queue | DLQ | Consumed By |
| --- | --- | --- |
| `order-queue` | `order-queue-dlq` | order-service |
| `payment-queue` | `payment-queue-dlq` | payment-service |
| `inventory-queue` | `inventory-queue-dlq` | inventory-service |
| `notification-queue` | `notification-queue-dlq` | notification-service |

### Queue URLs (LocalStack)

```
http://localhost:4566/000000000000/order-queue
http://localhost:4566/000000000000/order-queue-dlq
http://localhost:4566/000000000000/payment-queue
http://localhost:4566/000000000000/payment-queue-dlq
http://localhost:4566/000000000000/inventory-queue
http://localhost:4566/000000000000/inventory-queue-dlq
http://localhost:4566/000000000000/notification-queue
http://localhost:4566/000000000000/notification-queue-dlq
```

---

## Fan-out Routing Map

This is the complete subscription matrix — which queue receives messages from which topic:

```
order-topic (SNS)
  ├──▶ inventory-queue    → inventory-service processes: order.created, order.cancelled
  └──▶ notification-queue → notification-service logs all

inventory-topic (SNS)
  ├──▶ payment-queue      → payment-service processes: inventory.reserved
  └──▶ notification-queue → notification-service logs all

payment-topic (SNS)
  ├──▶ order-queue        → order-service processes: payment.success, payment.failed
  └──▶ notification-queue → notification-service logs all
```

As a table:

| SNS Topic | SQS Queue | Subscriber |
| --- | --- | --- |
| order-topic | inventory-queue | inventory-service |
| order-topic | notification-queue | notification-service |
| inventory-topic | payment-queue | payment-service |
| inventory-topic | notification-queue | notification-service |
| payment-topic | order-queue | order-service |
| payment-topic | notification-queue | notification-service |

---

## Event Catalogue

All event types are defined as constants in each service's `src/messaging/events.ts`:

```typescript
export const Events = {
  ORDER_CREATED:       'order.created',
  ORDER_COMPLETED:     'order.completed',
  ORDER_CANCELLED:     'order.cancelled',
  INVENTORY_RESERVED:  'inventory.reserved',
  INVENTORY_RELEASED:  'inventory.released',
  INVENTORY_FAILED:    'inventory.failed',
  PAYMENT_SUCCESS:     'payment.success',
  PAYMENT_FAILED:      'payment.failed',
} as const;
```

### order.created

Published by **order-service** when a new order is accepted.

```typescript
interface OrderCreatedPayload {
  orderId:   string;   // UUID of the new order
  productId: string;   // e.g. "p1"
  quantity:  number;   // units requested
  amount:    number;   // total order value
}
```

Triggers: `inventory-service` to reserve stock.

---

### order.completed

Published by **order-service** when payment succeeds.

```typescript
interface OrderCompletedPayload {
  orderId: string;
}
```

Triggers: `notification-service` to log the completion.

---

### order.cancelled

Published by **order-service** when payment fails.

```typescript
interface OrderCancelledPayload {
  orderId: string;
  reason:  string;   // propagated from payment failure reason
}
```

Triggers: `inventory-service` to release reserved stock (compensation).

---

### inventory.reserved

Published by **inventory-service** when stock is successfully reserved.

```typescript
interface InventoryReservedPayload {
  orderId:   string;
  productId: string;
  quantity:  number;
  amount:    number;   // passed through from order.created for payment processing
}
```

Triggers: `payment-service` to process the payment.

---

### inventory.released

Published by **inventory-service** after releasing reserved stock following an order cancellation.

```typescript
interface InventoryReleasedPayload {
  orderId:   string;
  productId: string;
  quantity:  number;
}
```

Triggers: `notification-service` to log the release.

---

### inventory.failed

Published by **inventory-service** when stock cannot be reserved (product not found or insufficient stock).

```typescript
interface InventoryFailedPayload {
  orderId:   string;
  productId: string;
  reason:    string;
}
```

Note: the current implementation does not yet wire a handler in order-service for this event — adding it would allow the order to be cancelled when inventory is unavailable.

---

### payment.success

Published by **payment-service** when `amount <= 500`.

```typescript
interface PaymentSuccessPayload {
  orderId:   string;
  paymentId: string;
  amount:    number;
}
```

Triggers: `order-service` to mark the order COMPLETED.

---

### payment.failed

Published by **payment-service** when `amount > 500`.

```typescript
interface PaymentFailedPayload {
  orderId:   string;
  paymentId: string;
  amount:    number;
  reason:    string;   // e.g. "Amount 600 exceeds maximum allowed 500"
}
```

Triggers: `order-service` to mark the order CANCELLED and start compensation.

---

## Message Format

### Published Event Structure

When a service publishes an event, it sends this JSON structure as the SNS message body:

```json
{
  "eventType": "order.created",
  "timestamp": "2026-03-04T17:30:00.000Z",
  "payload": {
    "orderId": "550e8400-e29b-41d4-a716-446655440000",
    "productId": "p1",
    "quantity": 2,
    "amount": 100
  }
}
```

### SNS-to-SQS Envelope

When SNS delivers a message to an SQS queue, it wraps the original message in an SNS notification envelope:

```json
{
  "Type": "Notification",
  "MessageId": "abc-123",
  "TopicArn": "arn:aws:sns:us-east-1:000000000000:order-topic",
  "Subject": "order.created",
  "Message": "{\"eventType\":\"order.created\",\"timestamp\":\"...\",\"payload\":{...}}",
  "Timestamp": "2026-03-04T17:30:00.123Z",
  "MessageAttributes": {
    "eventType": {
      "Type": "String",
      "Value": "order.created"
    }
  }
}
```

The `Message` field contains the original event as a JSON string (double-encoded). The `parseEvent()` method in each service's `MessagingService` handles the unwrapping:

```typescript
parseEvent<T>(messageBody: string): BaseEvent<T> | null {
  const outer = JSON.parse(messageBody);
  if (outer.Message) {
    return JSON.parse(outer.Message) as BaseEvent<T>;  // SNS envelope
  }
  return outer as BaseEvent<T>;  // direct SQS message
}
```

### MessageAttributes

Each published message includes a `MessageAttributes` field with `eventType`. This allows for future SNS message filtering — you could configure a subscription to only deliver messages with a specific `eventType` to a queue, rather than filtering in application code.

---

## Dead Letter Queue Behaviour

### Configuration

Each SQS queue is created with a redrive policy:

```json
{
  "deadLetterTargetArn": "arn:aws:sqs:us-east-1:000000000000:order-queue-dlq",
  "maxReceiveCount": "3"
}
```

### How Messages End Up in the DLQ

1. A message arrives in `order-queue`
2. A consumer receives the message (the `ReceiveCount` increments)
3. If the consumer fails to process it and does **not** call `deleteMessage`, the message becomes visible again after the visibility timeout
4. After 3 receive attempts, SQS automatically moves the message to `order-queue-dlq`

In this codebase, a message is only deleted after successful processing:

```typescript
await this.handleEvent(event);
await this.messaging.deleteMessage('order-queue', message.ReceiptHandle!);
```

If `handleEvent` throws, the message is not deleted and will be retried.

### Inspecting the DLQ

```bash
# From the host machine
aws --endpoint-url=http://localhost:4566 \
    --region us-east-1 \
    sqs receive-message \
    --queue-url http://localhost:4566/000000000000/order-queue-dlq \
    --max-number-of-messages 10

# From inside the LocalStack container
docker exec -it localstack bash
awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/order-queue-dlq \
  --max-number-of-messages 10
```

### Triggering a DLQ Scenario

To test DLQ behaviour:

```bash
# 1. Stop a service
docker compose stop payment-service

# 2. Send an order — message will sit in payment-queue
curl -X POST http://localhost:3001/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"p1","quantity":1,"amount":100}'

# 3. Restart the service with a deliberate crash
#    (e.g. temporarily throw in payment-consumer.service.ts)
#    After 3 receive attempts the message moves to payment-queue-dlq

# 4. Check the DLQ
docker exec -it localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/payment-queue-dlq \
  --max-number-of-messages 5
```

---

## LocalStack Init Script

`scripts/init-aws.sh` runs automatically inside the LocalStack container on startup (via the `ready.d` hook). It creates all resources using the `aws` CLI:

```bash
# Creates SNS topic, returns ARN
create_topic "order-topic"

# Creates DLQ, then main queue with redrive policy pointing to the DLQ
create_queue_with_dlq "order-queue"

# Subscribes a queue to a topic (SNS fan-out)
subscribe_queue_to_topic "$ORDER_TOPIC_ARN" "$INVENTORY_QUEUE_URL"
```

The script is idempotent-safe for SNS topic and SQS queue creation (both `CreateTopic` and `CreateQueue` return existing resources if they already exist).

At the end, the script prints a summary table of all created topics, queues, and subscriptions.
