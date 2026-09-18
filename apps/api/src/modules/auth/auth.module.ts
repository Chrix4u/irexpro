import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthCookieService } from './auth-cookie.service';
import { PasswordResetService } from './password-reset.service';
import {
  PasswordResetDeliveryService,
  NodemailerEmailProvider,
  EMAIL_PROVIDER,
} from './password-reset-delivery.service';
import { EmailVerificationDeliveryService } from './email-verification-delivery.service';
import { PhoneVerificationDeliveryService } from './phone-verification-delivery.service';
import { MfaService } from './mfa.service';
import { VerificationService } from './verification.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { User } from '../users/entities/user.entity';
import { UserProfile } from '../users/entities/user-profile.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { Role } from '../users/entities/role.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { AuthVerificationToken } from './entities/auth-verification-token.entity';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfile,
      UserRole,
      Role,
      PasswordResetToken,
      AuthVerificationToken,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: configService.get<number>('throttle.ttl', 60) * 1000,
            limit: configService.get<number>('throttle.limit', 100),
          },
        ],
      }),
    }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: configService.get<string>('jwt.accessExpiry', '15m'),
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    AuditModule,
    NotificationsModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthCookieService,
    PasswordResetService,
    PasswordResetDeliveryService,
    EmailVerificationDeliveryService,
    PhoneVerificationDeliveryService,
    MfaService,
    VerificationService,
    { provide: EMAIL_PROVIDER, useClass: NodemailerEmailProvider },
    JwtStrategy,
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
