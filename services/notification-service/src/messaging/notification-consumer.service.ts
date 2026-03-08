import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BaseEvent, Events } from './events';

@Injectable()
export class NotificationConsumerService implements OnModuleInit {
  private readonly logger = new Logger(NotificationConsumerService.name);
  private isRunning = false;

  constructor(
    private readonly messaging: MessagingService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async onModuleInit() {
    await new Promise((r) => setTimeout(r, 2000));
    this.startPolling();
  }

  startPolling(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('[notification-queue] Starting consumer...');
    this.poll();
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        const messages = await this.messaging.receiveMessages('notification-queue', 10, 20);

        for (const message of messages) {
          const event = this.messaging.parseEvent<unknown>(message.Body!);

          if (event) {
            this.logger.log(`[notification-queue] Received: ${event.eventType}`);
            try {
              await this.handleEvent(event);
              await this.messaging.deleteMessage('notification-queue', message.ReceiptHandle!);
            } catch (err) {
              this.logger.error(
                `[notification-queue] Handler error: ${(err as Error).message}`,
              );
            }
          } else {
            await this.messaging.deleteMessage('notification-queue', message.ReceiptHandle!);
          }
        }
      } catch (err) {
        if (this.isRunning) {
          this.logger.error(`[notification-queue] Poll error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  private async handleEvent(event: BaseEvent<unknown>): Promise<void> {
    const payload = event.payload as Record<string, any>;

    switch (event.eventType) {
      case Events.ORDER_CREATED:
        await this.notificationsService.notify(
          'ORDER_CREATED',
          `New order placed: ${payload.orderId} for product ${payload.productId} x${payload.quantity} ($${payload.amount})`,
        );
        break;

      case Events.ORDER_COMPLETED:
        await this.notificationsService.notify(
          'ORDER_COMPLETED',
          `Order ${payload.orderId} has been completed successfully!`,
        );
        break;

      case Events.ORDER_CANCELLED:
        await this.notificationsService.notify(
          'ORDER_CANCELLED',
          `Order ${payload.orderId} was cancelled. Reason: ${payload.reason}`,
        );
        break;

      case Events.PAYMENT_SUCCESS:
        await this.notificationsService.notify(
          'PAYMENT_SUCCESS',
          `Payment of $${payload.amount} succeeded for order ${payload.orderId} (payment: ${payload.paymentId})`,
        );
        break;

      case Events.PAYMENT_FAILED:
        await this.notificationsService.notify(
          'PAYMENT_FAILED',
          `Payment failed for order ${payload.orderId}: ${payload.reason}`,
        );
        break;

      case Events.INVENTORY_RESERVED:
        await this.notificationsService.notify(
          'INVENTORY_RESERVED',
          `Stock reserved for order ${payload.orderId}: ${payload.quantity} units of ${payload.productId}`,
        );
        break;

      case Events.INVENTORY_RELEASED:
        await this.notificationsService.notify(
          'INVENTORY_RELEASED',
          `Stock released for cancelled order ${payload.orderId}`,
        );
        break;

      case Events.INVENTORY_FAILED:
        await this.notificationsService.notify(
          'INVENTORY_FAILED',
          `Inventory reservation failed for order ${payload.orderId}: ${payload.reason}`,
        );
        break;

      default:
        this.logger.debug(`[notification-queue] Unknown event: ${event.eventType}`);
    }
  }
}
