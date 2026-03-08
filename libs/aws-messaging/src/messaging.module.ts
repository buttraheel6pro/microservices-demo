import { DynamicModule, Module } from '@nestjs/common';
import { MessagingService, MessagingConfig } from './messaging.service';

@Module({})
export class MessagingModule {
  static forRoot(config: MessagingConfig): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        {
          provide: 'MESSAGING_CONFIG',
          useValue: config,
        },
        {
          provide: MessagingService,
          useFactory: () => new MessagingService(config),
        },
      ],
      exports: [MessagingService],
      global: true,
    };
  }
}
