# LocalStack Guide

Everything you need to know about the LocalStack setup, how to inspect resources, debug messaging, and troubleshoot common problems.

---

## Table of Contents

- [What is LocalStack?](#what-is-localstack)
- [Configuration](#configuration)
- [Init Script](#init-script)
- [Connecting to LocalStack](#connecting-to-localstack)
- [Inspecting Resources](#inspecting-resources)
- [Sending Test Messages](#sending-test-messages)
- [Debugging](#debugging)
- [Troubleshooting](#troubleshooting)

---

## What is LocalStack?

[LocalStack](https://localstack.cloud) is a fully local AWS cloud emulator. It runs as a single Docker container and exposes AWS service APIs on port `4566`. Services interact with it using the standard AWS SDK, but pointed at `http://localstack:4566` (inside Docker) or `http://localhost:4566` (from the host machine) instead of real AWS endpoints.

**This project uses LocalStack for:**
- SNS (Simple Notification Service) — publish/subscribe topics
- SQS (Simple Queue Service) — message queues with Dead Letter Queue support

No real AWS account, no internet access, and no billing required.

---

## Configuration

LocalStack is configured in `docker-compose.yml`:

```yaml
localstack:
  image: localstack/localstack:3.0
  container_name: localstack
  ports:
    - "4566:4566"
  environment:
    - SERVICES=sns,sqs      # Only enable the services we need
    - DEFAULT_REGION=us-east-1
    - AWS_DEFAULT_REGION=us-east-1
    - EDGE_PORT=4566
    - DEBUG=1               # Verbose logging
  volumes:
    - ./scripts/init-aws.sh:/etc/localstack/init/ready.d/init-aws.sh
```

### Key settings

| Setting | Value | Reason |
| --- | --- | --- |
| `SERVICES=sns,sqs` | Only SNS and SQS | Keeps LocalStack fast and lightweight; other services (S3, DynamoDB, etc.) are not started |
| `DEBUG=1` | Enabled | Shows detailed request logs in `docker compose logs localstack` |
| `init-aws.sh` in `ready.d/` | Auto-runs on startup | LocalStack executes all scripts in `ready.d/` once it's fully initialised |

### AWS Credentials

LocalStack accepts any credential values. The project uses:

```
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
AWS_REGION=us-east-1
```

These same values are set in all service containers via `docker-compose.yml`.

---

## Init Script

`scripts/init-aws.sh` runs automatically inside LocalStack after it starts. It creates all SNS topics, SQS queues, DLQs, and subscriptions.

### What it creates

**SNS Topics:**
- `order-topic`
- `payment-topic`
- `inventory-topic`

**SQS Queues (each with a DLQ, maxReceiveCount: 3):**
- `order-queue` + `order-queue-dlq`
- `payment-queue` + `payment-queue-dlq`
- `inventory-queue` + `inventory-queue-dlq`
- `notification-queue` + `notification-queue-dlq`

**SNS → SQS subscriptions:**
- `order-topic` → `inventory-queue`, `notification-queue`
- `inventory-topic` → `payment-queue`, `notification-queue`
- `payment-topic` → `order-queue`, `notification-queue`

### Watching the init script run

```bash
docker compose logs localstack | grep -E "(Creating|Subscribing|initialized)"
```

You should see output like:

```
[SNS] Creating topic: order-topic
[SQS] Creating DLQ: order-queue-dlq
[SQS] Creating main queue with DLQ: order-queue
[SNS->SQS] Subscribing arn:aws:sqs:...inventory-queue to arn:aws:sns:...order-topic
LocalStack resources initialized!
```

---

## Connecting to LocalStack

### From inside Docker (service containers)

Services connect at: `http://localstack:4566`

```typescript
// In each service's MessagingService
private get awsConfig() {
  return {
    endpoint: process.env.AWS_ENDPOINT || 'http://localstack:4566',
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
    },
    forcePathStyle: true,
  };
}
```

### From the host machine (CLI / testing)

LocalStack is exposed at: `http://localhost:4566`

You can use either the AWS CLI with `--endpoint-url`, or the `awslocal` wrapper (available inside the LocalStack container):

```bash
# Using AWS CLI from host (requires aws CLI installed)
aws --endpoint-url=http://localhost:4566 \
    --region us-east-1 \
    sns list-topics

# Using awslocal from inside the container (no flags needed)
docker exec -it localstack awslocal sns list-topics
```

---

## Inspecting Resources

### List all SNS topics

```bash
# From host
aws --endpoint-url=http://localhost:4566 --region us-east-1 sns list-topics

# From inside container
docker exec -it localstack awslocal sns list-topics
```

Expected output:

```json
{
    "Topics": [
        { "TopicArn": "arn:aws:sns:us-east-1:000000000000:order-topic" },
        { "TopicArn": "arn:aws:sns:us-east-1:000000000000:payment-topic" },
        { "TopicArn": "arn:aws:sns:us-east-1:000000000000:inventory-topic" }
    ]
}
```

### List all SQS queues

```bash
docker exec -it localstack awslocal sqs list-queues
```

Expected output:

```json
{
    "QueueUrls": [
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/order-queue",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/order-queue-dlq",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/payment-queue",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/payment-queue-dlq",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/inventory-queue",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/inventory-queue-dlq",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/notification-queue",
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/notification-queue-dlq"
    ]
}
```

### List SNS subscriptions

```bash
docker exec -it localstack awslocal sns list-subscriptions
```

This shows all SNS-to-SQS subscription mappings.

### Get queue attributes (message count, DLQ config)

```bash
docker exec -it localstack awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/order-queue \
  --attribute-names All
```

Key attributes:

| Attribute | Meaning |
| --- | --- |
| `ApproximateNumberOfMessages` | Messages waiting to be consumed |
| `ApproximateNumberOfMessagesNotVisible` | Messages in-flight (being processed) |
| `RedrivePolicy` | DLQ configuration (target ARN + max receive count) |

### Peek at messages in a queue (non-destructive)

```bash
docker exec -it localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/order-queue \
  --max-number-of-messages 5 \
  --visibility-timeout 0
```

> `--visibility-timeout 0` means the message becomes visible again immediately and will still be delivered to the real consumer. Without this, peeking would hide the message for 30 seconds by default.

### Check a DLQ for failed messages

```bash
docker exec -it localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/payment-queue-dlq \
  --max-number-of-messages 10
```

---

## Sending Test Messages

You can publish events directly to SNS from the command line to test service behaviour without going through the HTTP API.

### Publish a test order.created event

```bash
docker exec -it localstack awslocal sns publish \
  --topic-arn arn:aws:sns:us-east-1:000000000000:order-topic \
  --message '{"eventType":"order.created","timestamp":"2026-03-04T17:00:00.000Z","payload":{"orderId":"test-order-1","productId":"p1","quantity":1,"amount":50}}' \
  --subject "order.created"
```

This will be fanned out to `inventory-queue` and `notification-queue` automatically.

### Send a message directly to a SQS queue (bypassing SNS)

```bash
docker exec -it localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/payment-queue \
  --message-body '{"eventType":"inventory.reserved","timestamp":"2026-03-04T17:00:00.000Z","payload":{"orderId":"test-order-1","productId":"p1","quantity":1,"amount":50}}'
```

> Note: when sending directly to SQS (not via SNS), the message is not wrapped in the SNS envelope, so the consumer's `parseEvent()` will handle it via the fallback path.

---

## Debugging

### View LocalStack request logs

```bash
docker compose logs -f localstack
```

With `DEBUG=1` enabled, every AWS API call is logged:

```
INFO  AWS sns.Publish => 200
INFO  AWS sqs.SendMessage => 200
INFO  AWS sqs.ReceiveMessage => 200
INFO  AWS sqs.DeleteMessage => 200
```

### View all service logs together

```bash
docker compose logs -f
```

### View a single service's logs

```bash
docker compose logs -f order-service
docker compose logs -f inventory-service
docker compose logs -f payment-service
docker compose logs -f notification-service
```

### Check LocalStack health

```bash
curl http://localhost:4566/_localstack/health
```

Response includes which services are running:

```json
{
  "services": {
    "sns": "running",
    "sqs": "running"
  },
  "version": "3.0.0"
}
```

### Connect to a service's database directly

```bash
# order-db (host port 5436)
docker exec -it order-db psql -U order_user -d order_db

# List orders
SELECT id, product_id, status, created_at FROM "Order" ORDER BY created_at DESC LIMIT 10;

# inventory-db (host port 5434)
docker exec -it inventory-db psql -U inventory_user -d inventory_db

# Check stock levels
SELECT "productId", "availableStock", "reservedStock" FROM "Inventory";
```

---

## Troubleshooting

### `Service 's3' is not enabled`

```
NotImplementedError: Service 's3' is not enabled.
```

This appears in LocalStack logs if something tries to call the S3 API. The `SERVICES=sns,sqs` config intentionally excludes S3. If no S3 functionality is needed this can be safely ignored. To enable S3, add it to the `SERVICES` env var:

```yaml
- SERVICES=sns,sqs,s3
```

### `Prisma failed to detect the libssl/openssl version`

```
prisma:warn Prisma failed to detect the libssl/openssl version to use
```

This warning appears because the `node:20-alpine` Docker image is minimal and Prisma uses OpenSSL for its query engine. All Dockerfiles have `RUN apk add --no-cache openssl` to resolve this. If you see this warning, ensure the image was rebuilt after that line was added:

```bash
docker compose build --no-cache
docker compose up
```

### `FATAL: database "<username>" does not exist`

This happens when `pg_isready` is called without specifying `-d <dbname>`, so it tries to connect to a database named after the user. All healthchecks in `docker-compose.yml` should use:

```yaml
test: ["CMD-SHELL", "pg_isready -U order_user -d order_db"]
```

### Services fail to connect to PostgreSQL after DB user changes

If you change `POSTGRES_USER` in `docker-compose.yml`, the existing Docker volume still has data from the old user. You must wipe the volumes:

```bash
docker compose down -v   # -v removes named volumes
docker compose up --build
```

### `Container name already in use` on startup

Stale containers from a previous failed shutdown. Clean them up:

```bash
docker compose down --remove-orphans
docker network prune -f
docker compose up -d
```

### LocalStack resources not created (init script didn't run)

The init script runs once when LocalStack first starts. If it failed silently, re-run the stack:

```bash
docker compose restart localstack
```

Or check if the script ran:

```bash
docker compose logs localstack | grep "Initializing LocalStack"
```

If it didn't run, verify the script has execute permissions:

```bash
ls -la scripts/init-aws.sh
# should show -rwxr-xr-x
chmod +x scripts/init-aws.sh
```

### Messages stuck in queue / not being consumed

1. Check if the consumer service is running: `docker compose ps`
2. Check service logs for errors: `docker compose logs -f inventory-service`
3. Check if the queue has messages: `docker exec -it localstack awslocal sqs get-queue-attributes --queue-url ... --attribute-names ApproximateNumberOfMessages`
4. Check if the subscription exists: `docker exec -it localstack awslocal sns list-subscriptions`

### Reset to clean state

To completely reset all data and restart fresh:

```bash
docker compose down -v          # Stop containers, remove volumes
docker compose up --build -d    # Rebuild images, start fresh
```
