import { UserStatus } from '../../modules/users/entities/user.entity';

/**
 * AuthenticatedPrincipal — the sanitized shape of request.user.
 *
 * Hotfix: JwtStrategy.validate() previously returned `{ ...user, roles }` —
 * the FULL User entity (including passwordHash, mfaSecret, userRoles entities,
 * etc.). This caused:
 *   - Controllers that passed `user` to services expecting a UUID string to
 *     produce QueryFailedError: invalid input syntax for type uuid
 *   - Sensitive fields (passwordHash, mfaSecret) to be in memory on every
 *     authenticated request, increasing the blast radius of a memory dump
 *
 * This interface defines the ONLY fields that should be on request.user.
 * It contains no secrets — passwordHash, mfaSecret, refresh tokens, reset
 * tokens, userRoles entities, and encrypted broker credentials are NEVER
 * present. The validated session generation is deliberately retained because
 * mutating auth endpoints must bind compare-and-set updates to the exact
 * bearer-token generation that authenticated the request.
 */
export interface AuthenticatedPrincipal {
  /** The user's UUID (from JWT payload.sub). */
  userId: string;
  /** The user's email (nullable for phone-only users). */
  email: string | null;
  /** The user's phone (nullable for email-only users). */
  phone: string | null;
  /** The user's roles (from JWT payload.roles). Used by RolesGuard. */
  roles: string[];
  /** The user's status (ACTIVE, SUSPENDED, etc.). */
  status: UserStatus;
  /**
   * Server-validated session generation carried by the access token.
   * JwtStrategy always populates it in production. It remains optional at the
   * structural interface boundary so legacy focused test fixtures that do not
   * exercise generation-bound mutations stay source-compatible; sensitive
   * endpoints must validate its presence before use.
   */
  authenticatedSessionVersion?: number;
}
