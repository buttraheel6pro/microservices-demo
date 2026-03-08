import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { OrdersService } from '../orders/orders.service';
import {
  BaseEvent,
  Events,
  PaymentSuccessPayload,
  PaymentFailedPayload,
} from './events';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class OrderConsumerService implements OnModuleInit {
  private readonly logger = new Logger(OrderConsumerService.name);
  private isRunning = false;

  constructor(
    private readonly messaging: MessagingService,
    private readonly ordersService: OrdersService,
  ) {}

  async onModuleInit() {
    // Brief delay to allow other services to initialize
    await new Promise((r) => setTimeout(r, 2000));
    this.startPolling();
  }

  startPolling(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('[order-queue] Starting consumer...');
    this.poll();
  }

  private async poll(): Promise<void> {
    while (this.isRunning) {
      try {
        const messages = await this.messaging.receiveMessages('order-queue', 10, 20);

        for (const message of messages) {
          const event = this.messaging.parseEvent<unknown>(message.Body!);

          if (event) {
            this.logger.log(`[order-queue] Received: ${event.eventType}`);
            try {
              await this.handleEvent(event);
              await this.messaging.deleteMessage('order-queue', message.ReceiptHandle!);
            } catch (err) {
              this.logger.error(
                `[order-queue] Handler error for ${event.eventType}: ${(err as Error).message}`,
              );
            }
          } else {
            await this.messaging.deleteMessage('order-queue', message.ReceiptHandle!);
          }
        }
      } catch (err) {
        if (this.isRunning) {
          this.logger.error(`[order-queue] Poll error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  private async handleEvent(event: BaseEvent<unknown>): Promise<void> {
    switch (event.eventType) {
      case Events.PAYMENT_SUCCESS:
        await this.handlePaymentSuccess(event as BaseEvent<PaymentSuccessPayload>);
        break;

      case Events.PAYMENT_FAILED:
        await this.handlePaymentFailed(event as BaseEvent<PaymentFailedPayload>);
        break;

      default:
        this.logger.debug(`[order-queue] Ignored event: ${event.eventType}`);
    }
  }

  private async handlePaymentSuccess(event: BaseEvent<PaymentSuccessPayload>): Promise<void> {
    const { orderId } = event.payload;
    this.logger.log(`[SAGA] Payment succeeded for order ${orderId} → marking COMPLETED`);

    await this.ordersService.updateStatus(orderId, OrderStatus.COMPLETED);

    await this.messaging.publish('order-topic', {
      eventType: Events.ORDER_COMPLETED,
      timestamp: new Date().toISOString(),
      payload: { orderId },
    });

    this.logger.log(`[SAGA] Published order.completed for order ${orderId}`);
  }

  private async handlePaymentFailed(event: BaseEvent<PaymentFailedPayload>): Promise<void> {
    const { orderId, reason } = event.payload;
    this.logger.warn(`[SAGA] Payment failed for order ${orderId}: ${reason} → CANCELLING`);

    await this.ordersService.updateStatus(orderId, OrderStatus.CANCELLED);

    await this.messaging.publish('order-topic', {
      eventType: Events.ORDER_CANCELLED,
      timestamp: new Date().toISOString(),
      payload: { orderId, reason },
    });

    this.logger.warn(`[SAGA] Published order.cancelled for order ${orderId}`);
  }
}
