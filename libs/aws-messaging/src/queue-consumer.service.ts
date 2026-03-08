import { Logger, OnModuleDestroy } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { BaseEvent } from './events';

export abstract class QueueConsumerService implements OnModuleDestroy {
  protected readonly logger: Logger;
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    protected readonly messagingService: MessagingService,
    protected readonly queueName: string,
    loggerContext: string,
  ) {
    this.logger = new Logger(loggerContext);
  }

  startPolling(intervalMs = 1000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log(`[${this.queueName}] Starting long-poll consumer`);
    this.poll();
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        const messages = await this.messagingService.receiveMessages(
          this.queueName,
          10,
          20,
        );

        for (const message of messages) {
          const event = this.messagingService.parseEvent(message.Body!);

          if (event) {
            this.logger.log(
              `[${this.queueName}] Received: ${event.eventType}`,
            );
            try {
              await this.handleEvent(event);
              await this.messagingService.deleteMessage(
                this.queueName,
                message.ReceiptHandle!,
              );
            } catch (err) {
              this.logger.error(
                `[${this.queueName}] Failed to process ${event.eventType}: ${(err as Error).message}`,
              );
              // Message visibility timeout will expire and it will be retried
              // After maxReceiveCount (3) retries, it goes to the DLQ
            }
          } else {
            // Delete unparseable messages
            await this.messagingService.deleteMessage(
              this.queueName,
              message.ReceiptHandle!,
            );
          }
        }
      } catch (err) {
        if (this.isRunning) {
          this.logger.error(
            `[${this.queueName}] Poll error: ${(err as Error).message}`,
          );
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  abstract handleEvent(event: BaseEvent<unknown>): Promise<void>;

  onModuleDestroy(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.logger.log(`[${this.queueName}] Consumer stopped`);
  }
}
