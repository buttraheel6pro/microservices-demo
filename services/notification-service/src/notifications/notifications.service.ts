import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ─────────────────────────────────────────
// Notification Service is MOCKED: logs only
// In production this would send emails, push, SMS, etc.
// ─────────────────────────────────────────

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('📬 NotificationService');

  constructor(private readonly prisma: PrismaService) {}

  async notify(type: string, message: string): Promise<void> {
    // Persist to DB
    const notification = await this.prisma.notification.create({
      data: { type, message },
    });

    // Mock: log the notification
    this.logger.log(
      `\n${'─'.repeat(60)}\n` +
      `📣 NOTIFICATION [${type.toUpperCase()}]\n` +
      `   Message : ${message}\n` +
      `   ID      : ${notification.id}\n` +
      `   At      : ${notification.createdAt.toISOString()}\n` +
      `${'─'.repeat(60)}`,
    );
  }

  async findAll() {
    return this.prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}
