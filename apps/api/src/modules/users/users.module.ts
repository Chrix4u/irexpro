import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserProfile } from './entities/user-profile.entity';
import { UserRole } from './entities/user-role.entity';
import { Role } from './entities/role.entity';
import { UserPaymentProfile } from './entities/user-payment-profile.entity';
import { AccountAppeal } from './entities/account-appeal.entity';
import { UserDisclosureConsent } from './entities/user-disclosure-consent.entity';
import { UserEligibilityReview } from './entities/user-eligibility-review.entity';
import { UserKycReview } from './entities/user-kyc-review.entity';
import { RiskProfile } from '../risk/entities/risk-profile.entity';
import { BrokerConnection } from '../broker/entities/broker-connection.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { OnboardingService } from './onboarding.service';
import { AuditModule } from '../audit/audit.module';
import { AccountGovernanceController } from './account-governance.controller';
import { AccountGovernanceService } from './account-governance.service';
import { EligibilityController } from './eligibility.controller';
import { EligibilityService } from './eligibility.service';
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module';

@Module({
  // OnboardingService needs RiskProfile + BrokerConnection repos.
  // Sprint 44/45: eligibility, consent, age, and KYC evidence are part of the
  // same centralized fail-closed readiness boundary.
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserProfile,
      UserRole,
      Role,
      UserPaymentProfile,
      AccountAppeal,
      UserDisclosureConsent,
      UserEligibilityReview,
      UserKycReview,
      RiskProfile,
      BrokerConnection,
    ]),
    AuditModule,
    // Round 6 (#300): the unified execution-authority leaf — profile/KYC/
    // jurisdiction/governance mutations bump the TradingAuthorityGeneration
    // and invalidate NEW exposure through the tenant-scoped seams.
    ExecutionAuthorityModule,
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
  ],
  controllers: [UsersController, AccountGovernanceController, EligibilityController],
  providers: [
    UsersService,
    BootstrapAdminService,
    OnboardingService,
    AccountGovernanceService,
    EligibilityService,
  ],
  exports: [
    UsersService,
    BootstrapAdminService,
    OnboardingService,
    EligibilityService,
    TypeOrmModule,
  ],
})
export class UsersModule {}
