import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { MessagingService } from './messaging/messaging.service';
import { NotificationConsumerService } from './messaging/notification-consumer.service';
import { NotificationsService } from './notifications/notifications.service';
import { NotificationsController } from './notifications/notifications.controller';
import { HealthController } from './health.controller';

@Module({
  controllers: [NotificationsController, HealthController],
  providers: [
    PrismaService,
    MessagingService,
    NotificationsService,
    NotificationConsumerService,
  ],
})
export class AppModule {}
