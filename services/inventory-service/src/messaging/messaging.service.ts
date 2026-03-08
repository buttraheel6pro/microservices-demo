import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  SNSClient,
  PublishCommand,
  CreateTopicCommand,
  ListTopicsCommand,
  SubscribeCommand,
  ListSubscriptionsByTopicCommand,
} from '@aws-sdk/client-sns';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { BaseEvent } from './events';

@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger(MessagingService.name);
  private snsClient: SNSClient;
  private sqsClient: SQSClient;
  private topicArns: Map<string, string> = new Map();
  private queueUrls: Map<string, string> = new Map();

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

  constructor() {
    this.snsClient = new SNSClient(this.awsConfig);
    this.sqsClient = new SQSClient(this.awsConfig);
  }

  async onModuleInit() {
    await this.waitForLocalStack();
    await this.setupSubscriptions();
  }

  private async setupSubscriptions(): Promise<void> {
    // inventory-service listens to order-topic via inventory-queue
    await this.ensureSubscription('inventory-queue', 'order-topic');
  }

  async ensureSubscription(queueName: string, topicName: string): Promise<void> {
    const topicArn = await this.ensureTopic(topicName);
    const queueUrl = await this.ensureQueue(queueName);

    const queueAttrs = await this.sqsClient.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
    );
    const queueArn = queueAttrs.Attributes!['QueueArn'];

    const existing = await this.snsClient.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
    );
    const alreadySubscribed = (existing.Subscriptions || []).some(
      (s) => s.Endpoint === queueArn,
    );

    if (!alreadySubscribed) {
      await this.snsClient.send(
        new SubscribeCommand({ TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn }),
      );
      this.logger.log(`[SNS→SQS] Subscribed ${queueName} to ${topicName}`);
    } else {
      this.logger.log(`[SNS→SQS] ${queueName} already subscribed to ${topicName}`);
    }
  }

  private async waitForLocalStack(retries = 20, delayMs = 3000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.snsClient.send(new ListTopicsCommand({}));
        this.logger.log('Connected to LocalStack successfully');
        return;
      } catch {
        this.logger.warn(`Waiting for LocalStack (${i + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error('LocalStack not available');
  }

  async ensureTopic(topicName: string): Promise<string> {
    if (this.topicArns.has(topicName)) {
      return this.topicArns.get(topicName)!;
    }
    const result = await this.snsClient.send(
      new CreateTopicCommand({ Name: topicName }),
    );
    const arn = result.TopicArn!;
    this.topicArns.set(topicName, arn);
    this.logger.log(`[SNS] Topic ready: ${topicName}`);
    return arn;
  }

  async ensureQueue(queueName: string): Promise<string> {
    if (this.queueUrls.has(queueName)) {
      return this.queueUrls.get(queueName)!;
    }
    try {
      const result = await this.sqsClient.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      const url = result.QueueUrl!;
      this.queueUrls.set(queueName, url);
      return url;
    } catch {
      const result = await this.sqsClient.send(
        new CreateQueueCommand({ QueueName: queueName }),
      );
      const url = result.QueueUrl!;
      this.queueUrls.set(queueName, url);
      this.logger.log(`[SQS] Queue created: ${queueName}`);
      return url;
    }
  }

  async publish<T>(topicName: string, event: BaseEvent<T>): Promise<void> {
    const topicArn = await this.ensureTopic(topicName);
    await this.snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(event),
        Subject: event.eventType,
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: event.eventType,
          },
        },
      }),
    );
    this.logger.log(`[SNS] Published: ${event.eventType} → ${topicName}`);
  }

  async receiveMessages(queueName: string, maxMessages = 10, waitTimeSeconds = 20) {
    const queueUrl = await this.ensureQueue(queueName);
    const result = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    return result.Messages || [];
  }

  async deleteMessage(queueName: string, receiptHandle: string): Promise<void> {
    const queueUrl = await this.ensureQueue(queueName);
    await this.sqsClient.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  parseEvent<T>(messageBody: string): BaseEvent<T> | null {
    try {
      const outer = JSON.parse(messageBody);
      if (outer.Message) {
        return JSON.parse(outer.Message) as BaseEvent<T>;
      }
      return outer as BaseEvent<T>;
    } catch {
      this.logger.error(`Failed to parse message: ${messageBody}`);
      return null;
    }
  }
}
