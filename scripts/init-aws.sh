#!/bin/bash
# LocalStack initialization script
# Creates SNS topics, SQS queues, DLQs, and subscriptions

set -e

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

ENDPOINT="http://localhost:4566"
REGION="us-east-1"

echo "=========================================="
echo " Initializing LocalStack AWS Resources"
echo "=========================================="

# ──────────────────────────────────────────
# Helper: create SNS topic
# ──────────────────────────────────────────
create_topic() {
  local name=$1
  echo "[SNS] Creating topic: $name"
  aws --endpoint-url=$ENDPOINT --region=$REGION sns create-topic --name "$name" --output text --query 'TopicArn'
}

# ──────────────────────────────────────────
# Helper: create SQS queue (standard)
# ──────────────────────────────────────────
create_queue() {
  local name=$1
  echo "[SQS] Creating queue: $name"
  aws --endpoint-url=$ENDPOINT --region=$REGION sqs create-queue --queue-name "$name" --output text --query 'QueueUrl'
}

# ──────────────────────────────────────────
# Helper: create DLQ + main queue with redrive policy
# ──────────────────────────────────────────
create_queue_with_dlq() {
  local name=$1
  local dlq_name="${name}-dlq"
  local max_receive=3

  echo "[SQS] Creating DLQ: $dlq_name"
  DLQ_URL=$(aws --endpoint-url=$ENDPOINT --region=$REGION sqs create-queue \
    --queue-name "$dlq_name" \
    --output text --query 'QueueUrl')

  DLQ_ARN=$(aws --endpoint-url=$ENDPOINT --region=$REGION sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names QueueArn \
    --output text --query 'Attributes.QueueArn')

  echo "[SQS] DLQ ARN: $DLQ_ARN"

  REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"$max_receive\"}"

  echo "[SQS] Creating main queue with DLQ: $name"
  QUEUE_URL=$(aws --endpoint-url=$ENDPOINT --region=$REGION sqs create-queue \
    --queue-name "$name" \
    --attributes "RedrivePolicy=$REDRIVE_POLICY" \
    --output text --query 'QueueUrl')

  echo "[SQS] Queue URL: $QUEUE_URL"
  echo "$QUEUE_URL"
}

# ──────────────────────────────────────────
# Helper: subscribe SQS to SNS
# ──────────────────────────────────────────
subscribe_queue_to_topic() {
  local topic_arn=$1
  local queue_url=$2

  QUEUE_ARN=$(aws --endpoint-url=$ENDPOINT --region=$REGION sqs get-queue-attributes \
    --queue-url "$queue_url" \
    --attribute-names QueueArn \
    --output text --query 'Attributes.QueueArn')

  echo "[SNS->SQS] Subscribing $QUEUE_ARN to $topic_arn"
  aws --endpoint-url=$ENDPOINT --region=$REGION sns subscribe \
    --topic-arn "$topic_arn" \
    --protocol sqs \
    --notification-endpoint "$QUEUE_ARN" \
    --output text --query 'SubscriptionArn'

  # Allow SNS to send messages to SQS
  ACCOUNT_ID="000000000000"
  aws --endpoint-url=$ENDPOINT --region=$REGION sqs set-queue-attributes \
    --queue-url "$queue_url" \
    --attributes "{
      \"Policy\": \"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"sns.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"*\\\",\\\"Condition\\\":{\\\"ArnLike\\\":{\\\"aws:SourceArn\\\":\\\"$topic_arn\\\"}}}]}\"
    }" > /dev/null

  echo "[SNS->SQS] Subscription complete"
}

# ──────────────────────────────────────────
# Create SNS Topics
# ──────────────────────────────────────────
echo ""
echo "--- Creating SNS Topics ---"
ORDER_TOPIC_ARN=$(create_topic "order-topic")
PAYMENT_TOPIC_ARN=$(create_topic "payment-topic")
INVENTORY_TOPIC_ARN=$(create_topic "inventory-topic")

echo "order-topic ARN:     $ORDER_TOPIC_ARN"
echo "payment-topic ARN:   $PAYMENT_TOPIC_ARN"
echo "inventory-topic ARN: $INVENTORY_TOPIC_ARN"

# ──────────────────────────────────────────
# Create SQS Queues with DLQs
# ──────────────────────────────────────────
echo ""
echo "--- Creating SQS Queues with DLQs ---"
ORDER_QUEUE_URL=$(create_queue_with_dlq "order-queue")
PAYMENT_QUEUE_URL=$(create_queue_with_dlq "payment-queue")
INVENTORY_QUEUE_URL=$(create_queue_with_dlq "inventory-queue")
NOTIFICATION_QUEUE_URL=$(create_queue_with_dlq "notification-queue")

# ──────────────────────────────────────────
# Subscribe Queues to Topics (Fan-out)
# ──────────────────────────────────────────
echo ""
echo "--- Subscribing Queues to Topics ---"

# inventory-queue and notification-queue listen to order-topic
subscribe_queue_to_topic "$ORDER_TOPIC_ARN" "$INVENTORY_QUEUE_URL"
subscribe_queue_to_topic "$ORDER_TOPIC_ARN" "$NOTIFICATION_QUEUE_URL"

# payment-queue listens to inventory-topic
subscribe_queue_to_topic "$INVENTORY_TOPIC_ARN" "$PAYMENT_QUEUE_URL"

# order-queue and notification-queue listen to payment-topic
subscribe_queue_to_topic "$PAYMENT_TOPIC_ARN" "$ORDER_QUEUE_URL"
subscribe_queue_to_topic "$PAYMENT_TOPIC_ARN" "$NOTIFICATION_QUEUE_URL"

# notification-queue listens to inventory-topic (for stock release notifications)
subscribe_queue_to_topic "$INVENTORY_TOPIC_ARN" "$NOTIFICATION_QUEUE_URL"

# ──────────────────────────────────────────
# Summary
# ──────────────────────────────────────────
echo ""
echo "=========================================="
echo " LocalStack resources initialized!"
echo "=========================================="
echo ""
echo "SNS Topics:"
aws --endpoint-url=$ENDPOINT --region=$REGION sns list-topics --output table
echo ""
echo "SQS Queues:"
aws --endpoint-url=$ENDPOINT --region=$REGION sqs list-queues --output table
echo ""
echo "SNS Subscriptions:"
aws --endpoint-url=$ENDPOINT --region=$REGION sns list-subscriptions --output table
