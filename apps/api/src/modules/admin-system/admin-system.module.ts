import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminSystemController } from './admin-system.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [AdminSystemController],
})
export class AdminSystemModule {}
