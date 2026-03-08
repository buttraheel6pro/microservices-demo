import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import {
  Events,
  BaseEvent,
  InventoryReservedPayload,
  PaymentSuccessPayload,
  PaymentFailedPayload,
} from '../messaging/events';
import { PaymentStatus } from '@prisma/client';

// ─────────────────────────────────────────
// Business Rule: amount > 500 → FAIL
// ─────────────────────────────────────────
const PAYMENT_FAIL_THRESHOLD = 500;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  async processPayment(payload: InventoryReservedPayload): Promise<void> {
    const { orderId, amount } = payload;

    this.logger.log(`Processing payment for order ${orderId}, amount: ${amount}`);

    const payment = await this.prisma.payment.create({
      data: {
        orderId,
        amount,
        status: PaymentStatus.PENDING,
      },
    });

    const shouldFail = amount > PAYMENT_FAIL_THRESHOLD;

    if (shouldFail) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED },
      });

      this.logger.warn(
        `[SAGA] Payment FAILED for order ${orderId}: amount ${amount} > ${PAYMENT_FAIL_THRESHOLD}`,
      );

      const failEvent: BaseEvent<PaymentFailedPayload> = {
        eventType: Events.PAYMENT_FAILED,
        timestamp: new Date().toISOString(),
        payload: {
          orderId,
          paymentId: payment.id,
          amount,
          reason: `Amount ${amount} exceeds maximum allowed ${PAYMENT_FAIL_THRESHOLD}`,
        },
      };

      await this.messaging.publish('payment-topic', failEvent);
    } else {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCESS },
      });

      this.logger.log(
        `[SAGA] Payment SUCCEEDED for order ${orderId}, amount: ${amount}`,
      );

      const successEvent: BaseEvent<PaymentSuccessPayload> = {
        eventType: Events.PAYMENT_SUCCESS,
        timestamp: new Date().toISOString(),
        payload: {
          orderId,
          paymentId: payment.id,
          amount,
        },
      };

      await this.messaging.publish('payment-topic', successEvent);
    }
  }
}
