import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  BaseEvent,
  Events,
  OrderCreatedPayload,
  OrderCancelledPayload,
} from './events';

@Injectable()
export class InventoryConsumerService implements OnModuleInit {
  private readonly logger = new Logger(InventoryConsumerService.name);
  private isRunning = false;

  constructor(
    private readonly messaging: MessagingService,
    private readonly inventoryService: InventoryService,
  ) {}

  async onModuleInit() {
    await new Promise((r) => setTimeout(r, 2000));
    this.startPolling();
  }

  startPolling(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('[inventory-queue] Starting consumer...');
    this.poll();
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        const messages = await this.messaging.receiveMessages('inventory-queue', 10, 20);

        for (const message of messages) {
          const event = this.messaging.parseEvent<unknown>(message.Body!);

          if (event) {
            this.logger.log(`[inventory-queue] Received: ${event.eventType}`);
            try {
              await this.handleEvent(event);
              await this.messaging.deleteMessage('inventory-queue', message.ReceiptHandle!);
            } catch (err) {
              this.logger.error(
                `[inventory-queue] Handler error: ${(err as Error).message}`,
              );
            }
          } else {
            await this.messaging.deleteMessage('inventory-queue', message.ReceiptHandle!);
          }
        }
      } catch (err) {
        if (this.isRunning) {
          this.logger.error(`[inventory-queue] Poll error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  private async handleEvent(event: BaseEvent<unknown>): Promise<void> {
    switch (event.eventType) {
      case Events.ORDER_CREATED:
        await this.inventoryService.reserveStock(event.payload as OrderCreatedPayload);
        break;

      case Events.ORDER_CANCELLED:
        await this.inventoryService.releaseStock(event.payload as OrderCancelledPayload);
        break;

      default:
        this.logger.debug(`[inventory-queue] Ignored event: ${event.eventType}`);
    }
  }
}
