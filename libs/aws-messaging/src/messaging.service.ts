import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  SNSClient,
  PublishCommand,
  CreateTopicCommand,
  ListTopicsCommand,
} from '@aws-sdk/client-sns';
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { BaseEvent, EventType } from './events';

export interface MessagingConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger(MessagingService.name);
  private snsClient: SNSClient;
  private sqsClient: SQSClient;
  private topicArns: Map<string, string> = new Map();
  private queueUrls: Map<string, string> = new Map();

  constructor(private readonly config: MessagingConfig) {
    const clientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    };

    this.snsClient = new SNSClient(clientConfig);
    this.sqsClient = new SQSClient(clientConfig);
  }

  async onModuleInit() {
    await this.waitForLocalStack();
  }

  private async waitForLocalStack(retries = 15, delayMs = 3000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.snsClient.send(new ListTopicsCommand({}));
        this.logger.log('Connected to LocalStack');
        return;
      } catch {
        this.logger.warn(
          `LocalStack not ready, retrying (${i + 1}/${retries})...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error('LocalStack did not become ready in time');
  }

  // ──────────────────────────────────────────
  // Topic management
  // ──────────────────────────────────────────

  async ensureTopic(topicName: string): Promise<string> {
    if (this.topicArns.has(topicName)) {
      return this.topicArns.get(topicName)!;
    }

    const result = await this.snsClient.send(
      new CreateTopicCommand({ Name: topicName }),
    );

    const arn = result.TopicArn!;
    this.topicArns.set(topicName, arn);
    this.logger.log(`[SNS] Topic ready: ${topicName} → ${arn}`);
    return arn;
  }

  async getTopicArn(topicName: string): Promise<string> {
    return this.ensureTopic(topicName);
  }

  // ──────────────────────────────────────────
  // Queue management
  // ──────────────────────────────────────────

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
      this.logger.log(`[SQS] Queue found: ${queueName} → ${url}`);
      return url;
    } catch {
      const result = await this.sqsClient.send(
        new CreateQueueCommand({ QueueName: queueName }),
      );
      const url = result.QueueUrl!;
      this.queueUrls.set(queueName, url);
      this.logger.log(`[SQS] Queue created: ${queueName} → ${url}`);
      return url;
    }
  }

  async getQueueArn(queueUrl: string): Promise<string> {
    const result = await this.sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    return result.Attributes!.QueueArn!;
  }

  async getQueueUrl(queueName: string): Promise<string> {
    return this.ensureQueue(queueName);
  }

  // ──────────────────────────────────────────
  // Publish
  // ──────────────────────────────────────────

  async publish<T>(topicName: string, event: BaseEvent<T>): Promise<void> {
    const topicArn = await this.ensureTopic(topicName);

    await this.snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(event),
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: event.eventType,
          },
        },
        Subject: event.eventType,
      }),
    );

    this.logger.log(
      `[SNS] Published ${event.eventType} to ${topicName}`,
    );
  }

  // ──────────────────────────────────────────
  // Consume
  // ──────────────────────────────────────────

  async receiveMessages(
    queueName: string,
    maxMessages = 10,
    waitTimeSeconds = 20,
  ) {
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
      // SNS wraps the message in an envelope when fan-out is used
      if (outer.Message) {
        return JSON.parse(outer.Message) as BaseEvent<T>;
      }
      return outer as BaseEvent<T>;
    } catch {
      this.logger.error(`Failed to parse message body: ${messageBody}`);
      return null;
    }
  }
}
