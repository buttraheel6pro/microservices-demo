import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { PaymentsService } from '../payments/payments.service';
import { BaseEvent, Events, InventoryReservedPayload } from './events';

@Injectable()
export class PaymentConsumerService implements OnModuleInit {
  private readonly logger = new Logger(PaymentConsumerService.name);
  private isRunning = false;

  constructor(
    private readonly messaging: MessagingService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async onModuleInit() {
    await new Promise((r) => setTimeout(r, 2000));
    this.startPolling();
  }

  startPolling(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('[payment-queue] Starting consumer...');
    this.poll();
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        const messages = await this.messaging.receiveMessages('payment-queue', 10, 20);

        for (const message of messages) {
          const event = this.messaging.parseEvent<unknown>(message.Body!);

          if (event) {
            this.logger.log(`[payment-queue] Received: ${event.eventType}`);
            try {
              await this.handleEvent(event);
              await this.messaging.deleteMessage('payment-queue', message.ReceiptHandle!);
            } catch (err) {
              this.logger.error(
                `[payment-queue] Handler error: ${(err as Error).message}`,
              );
            }
          } else {
            await this.messaging.deleteMessage('payment-queue', message.ReceiptHandle!);
          }
        }
      } catch (err) {
        if (this.isRunning) {
          this.logger.error(`[payment-queue] Poll error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  private async handleEvent(event: BaseEvent<unknown>): Promise<void> {
    switch (event.eventType) {
      case Events.INVENTORY_RESERVED:
        await this.paymentsService.processPayment(
          event.payload as InventoryReservedPayload,
        );
        break;

      default:
        this.logger.debug(`[payment-queue] Ignored event: ${event.eventType}`);
    }
  }
}
