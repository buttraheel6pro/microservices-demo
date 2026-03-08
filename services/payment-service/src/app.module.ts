import { Module } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { MessagingService } from './messaging/messaging.service';
import { PaymentConsumerService } from './messaging/payment-consumer.service';
import { PaymentsService } from './payments/payments.service';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    PrismaService,
    MessagingService,
    PaymentsService,
    PaymentConsumerService,
  ],
})
export class AppModule {}
