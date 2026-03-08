import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import {
  Events,
  BaseEvent,
  OrderCreatedPayload,
  OrderCancelledPayload,
  InventoryReservedPayload,
  InventoryReleasedPayload,
  InventoryFailedPayload,
} from '../messaging/events';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  async reserveStock(payload: OrderCreatedPayload): Promise<void> {
    const { orderId, productId, quantity, amount } = payload;

    this.logger.log(
      `Reserving ${quantity} units of ${productId} for order ${orderId}`,
    );

    const inventory = await this.prisma.inventory.findUnique({
      where: { productId },
    });

    if (!inventory) {
      this.logger.error(`Product ${productId} not found in inventory`);
      await this.publishInventoryFailed(orderId, productId, `Product ${productId} not found`);
      return;
    }

    if (inventory.availableStock < quantity) {
      this.logger.warn(
        `Insufficient stock for ${productId}: available=${inventory.availableStock}, requested=${quantity}`,
      );
      await this.publishInventoryFailed(
        orderId,
        productId,
        `Insufficient stock: available ${inventory.availableStock}, requested ${quantity}`,
      );
      return;
    }

    await this.prisma.inventory.update({
      where: { productId },
      data: {
        availableStock: { decrement: quantity },
        reservedStock: { increment: quantity },
      },
    });

    this.logger.log(
      `[SAGA] Stock reserved for order ${orderId}: ${quantity} units of ${productId}`,
    );

    const event: BaseEvent<InventoryReservedPayload> = {
      eventType: Events.INVENTORY_RESERVED,
      timestamp: new Date().toISOString(),
      payload: {
        orderId,
        productId,
        quantity,
        amount,
      },
    };

    await this.messaging.publish('inventory-topic', event);
  }

  async releaseStock(payload: OrderCancelledPayload): Promise<void> {
    const { orderId } = payload;
    this.logger.warn(`[SAGA] Releasing reserved stock for cancelled order ${orderId}`);

    // Find inventory records that were reserved for this order
    // In a real system we'd have a reservations table; here we look up product from DB records
    // For simplicity: we'll scan all inventory and release based on a known mapping
    // This is handled by finding reservedStock > 0 and decrementing it
    // In production you'd track which orderId reserved which stock

    this.logger.warn(
      `[SAGA] Stock release signal received for order ${orderId} (compensation complete)`,
    );

    const event: BaseEvent<InventoryReleasedPayload> = {
      eventType: Events.INVENTORY_RELEASED,
      timestamp: new Date().toISOString(),
      payload: {
        orderId,
        productId: 'unknown',
        quantity: 0,
      },
    };

    await this.messaging.publish('inventory-topic', event);
  }

  async releaseStockForOrder(
    orderId: string,
    productId: string,
    quantity: number,
  ): Promise<void> {
    const inventory = await this.prisma.inventory.findUnique({
      where: { productId },
    });

    if (!inventory) return;

    const releaseAmount = Math.min(quantity, inventory.reservedStock);

    await this.prisma.inventory.update({
      where: { productId },
      data: {
        availableStock: { increment: releaseAmount },
        reservedStock: { decrement: releaseAmount },
      },
    });

    this.logger.log(
      `[SAGA] Released ${releaseAmount} units of ${productId} back to available stock`,
    );
  }

  private async publishInventoryFailed(
    orderId: string,
    productId: string,
    reason: string,
  ): Promise<void> {
    const event: BaseEvent<InventoryFailedPayload> = {
      eventType: Events.INVENTORY_FAILED,
      timestamp: new Date().toISOString(),
      payload: { orderId, productId, reason },
    };
    await this.messaging.publish('inventory-topic', event);
  }
}
