import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { MessagingService } from './messaging/messaging.service';
import { OrderConsumerService } from './messaging/order-consumer.service';
import { OrdersService } from './orders/orders.service';
import { OrdersController } from './orders/orders.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [OrdersController, HealthController],
  providers: [
    PrismaService,
    MessagingService,
    OrdersService,
    OrderConsumerService,
  ],
})
export class AppModule {}
