import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { Events, BaseEvent, OrderCreatedPayload } from '../messaging/events';
import { OrderStatus } from '@prisma/client';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
  ) {}

  async createOrder(dto: CreateOrderDto) {
    const order = await this.prisma.order.create({
      data: {
        productId: dto.productId,
        quantity: dto.quantity,
        amount: dto.amount,
        status: OrderStatus.PENDING,
      },
    });

    this.logger.log(`Order created: ${order.id} | Status: PENDING`);

    const event: BaseEvent<OrderCreatedPayload> = {
      eventType: Events.ORDER_CREATED,
      timestamp: new Date().toISOString(),
      payload: {
        orderId: order.id,
        productId: order.productId,
        quantity: order.quantity,
        amount: order.amount,
      },
    };

    await this.messaging.publish('order-topic', event);

    return order;
  }

  async findById(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException(`Order ${id} not found`);
    }
    return order;
  }

  async updateStatus(orderId: string, status: OrderStatus) {
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: { status },
    });
    this.logger.log(`Order ${orderId} status updated → ${status}`);
    return order;
  }
}
