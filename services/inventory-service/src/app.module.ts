import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { MessagingService } from './messaging/messaging.service';
import { InventoryConsumerService } from './messaging/inventory-consumer.service';
import { InventoryService } from './inventory/inventory.service';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    PrismaService,
    MessagingService,
    InventoryService,
    InventoryConsumerService,
  ],
})
export class AppModule {}
