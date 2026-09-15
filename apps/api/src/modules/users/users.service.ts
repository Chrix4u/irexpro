import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { KycStatus, UserProfile } from './entities/user-profile.entity';
import { Role, RoleName } from './entities/role.entity';
import { UpdateMyProfileDto } from './dto/update-my-profile.dto';
import { TradingAuthorityService } from '../execution-authority/trading-authority.service';
import { GrantInvalidationService } from '../execution-authority/grant-invalidation.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(UserProfile)
    private profileRepo: Repository<UserProfile>,
    @InjectRepository(Role)
    private roleRepo: Repository<Role>,
    // Round 6 (#300): authority-affecting profile edits bump the trading
    // authority generation + invalidate NEW exposure atomically.
    private readonly tradingAuthorityService: TradingAuthorityService,
    private readonly grantInvalidation: GrantInvalidationService,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { id },
      relations: ['profile', 'userRoles', 'userRoles.role'],
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findAll(page?: number, limit?: number): Promise<{ users: User[]; total: number }> {
    const requestedPage = this.positiveSafeIntegerOrDefault(page, 1);
    const limitNum = Math.min(this.positiveSafeIntegerOrDefault(limit, 20), 100);
    const maxPageForSafeOffset = Math.floor(Number.MAX_SAFE_INTEGER / limitNum) + 1;
    const pageNum = Math.min(requestedPage, maxPageForSafeOffset);
    const [users, total] = await this.userRepo.findAndCount({
      relations: ['profile'],
      order: { createdAt: 'DESC' },
      take: limitNum,
      skip: (pageNum - 1) * limitNum,
    });
    return { users, total };
  }

  /**
   * Legacy profile update — only updates UserProfile fields.
   * Kept for backward compatibility. Prefer updateMyProfile() for onboarding.
   */
  async updateProfile(userId: string, updates: Partial<UserProfile>): Promise<UserProfile> {
    const profile = await this.profileRepo.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Profile not found');
    Object.assign(profile, updates);
    return this.profileRepo.save(profile);
  }

  /**
   * Update the authenticated user's onboarding profile.
   *
   * Sprint 45 safety invariant: if the stored DOB changes after any KYC state
   * has been recorded, KYC is reset to NONE and must be reviewed again. A
   * previous immutable KYC review therefore never applies to a different DOB.
   */
  async updateMyProfile(userId: string, dto: UpdateMyProfileDto): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id: userId }, relations: ['profile'] });
    if (!user) throw new NotFoundException('User not found');

    // Round 6 (#2/#300): authority-affecting changes tracked for the atomic
    // generation bump — countryCode (jurisdiction), dateOfBirth (+ the
    // DOB-triggered KYC reset). Display-only edits never bump.
    let authorityBumpReason:
      | 'USER_PROFILE_COUNTRY_CHANGED'
      | 'USER_PROFILE_DATE_OF_BIRTH_CHANGED'
      | 'USER_PROFILE_DOB_KYC_RESET'
      | null = null;

    if (dto.countryCode !== undefined) {
      const nextCountry = dto.countryCode.toUpperCase();
      if (nextCountry !== user.countryCode) {
        authorityBumpReason = 'USER_PROFILE_COUNTRY_CHANGED';
      }
      user.countryCode = nextCountry;
    }
    if (dto.timezone !== undefined) user.timezone = dto.timezone;
    if (dto.preferredCurrency !== undefined)
      user.preferredCurrency = dto.preferredCurrency.toUpperCase();

    if (user.profile) {
      if (dto.firstName !== undefined) user.profile.firstName = dto.firstName;
      if (dto.lastName !== undefined) user.profile.lastName = dto.lastName;
      if (dto.tradingExperienceLevel !== undefined)
        user.profile.tradingExperienceLevel = dto.tradingExperienceLevel;

      if (dto.dateOfBirth !== undefined) {
        if (!this.isValidDateOfBirth(dto.dateOfBirth)) {
          throw new BadRequestException('Date of birth must be a valid past calendar date.');
        }

        if (user.profile.dateOfBirth !== dto.dateOfBirth) {
          const resetsKyc = user.profile.kycStatus !== KycStatus.NONE;
          user.profile.dateOfBirth = dto.dateOfBirth;
          user.profile.kycStatus = KycStatus.NONE;
          user.profile.kycSubmittedAt = null;
          user.profile.kycApprovedAt = null;
          authorityBumpReason = resetsKyc ? 'USER_PROFILE_DOB_KYC_RESET' : 'USER_PROFILE_DATE_OF_BIRTH_CHANGED';
        }
      }

      await this.profileRepo.save(user.profile);
    }

    await this.userRepo.manager.transaction(async (em) => {
      await em.getRepository(User).save(user);
      if (authorityBumpReason) {
        // Round 6 (#2 atomicity): the authority fact + generation bump +
        // NEW-exposure invalidation commit together (never best-effort later).
        await this.tradingAuthorityService.bumpGeneration(userId, authorityBumpReason, em);
        await this.grantInvalidation.invalidateUserNewExposureAuthority(
          userId,
          authorityBumpReason,
          em,
        );
      }
    });
    return this.findById(userId);
  }

  async seedDefaultRoles(): Promise<void> {
    for (const name of Object.values(RoleName)) {
      const exists = await this.roleRepo.findOne({ where: { name } });
      if (!exists) {
        await this.roleRepo.save(
          this.roleRepo.create({ name, description: `Default ${name} role` }),
        );
      }
    }
  }

  private positiveSafeIntegerOrDefault(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private isValidDateOfBirth(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return false;
    }

    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return parsed.getTime() < todayUtc;
  }
}
