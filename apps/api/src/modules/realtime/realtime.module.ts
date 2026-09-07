import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { WsMessageRateGuard } from './guards/ws-message-rate.guard';
import { User } from '../users/entities/user.entity';
import { TradingSession } from '../execution/entities/trading-session.entity';

/**
 * RealtimeModule — WebSocket gateway and real-time event emission.
 *
 * Read-only identity access lets WsJwtGuard enforce the same account-status
 * and session-version revocation checks as HTTP JWT authentication. Read-only
 * trading-session access lets the gateway authorize session-room membership
 * from persisted ownership instead of trusting client-supplied identity data.
 * WsMessageRateGuard runs first on guarded messages to bound repeated auth and
 * ownership-validation work per socket.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, TradingSession]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
      }),
    }),
  ],
  providers: [RealtimeGateway, RealtimeService, WsMessageRateGuard, WsJwtGuard],
  exports: [RealtimeService],
})
export class RealtimeModule {}
