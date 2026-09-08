import {
  BrokerAuthorizationStatus,
  BrokerAuthorizationStateMachine,
  BROKER_AUTHORIZATION_STATUSES,
} from './broker-authorization-status';

/**
 * Sprint 50 — BrokerAuthorizationStateMachine unit tests.
 *
 * Directive §15: live-account activation must be an explicit server-side
 * state machine. Directive §16/§48: unknown/missing state fails closed.
 */
describe('BrokerAuthorizationStateMachine', () => {
  describe('transition table completeness', () => {
    it('covers every status as a key (no silent gaps)', () => {
      for (const status of BROKER_AUTHORIZATION_STATUSES) {
        expect(BrokerAuthorizationStateMachine.canTransition(status, status)).toBeDefined();
      }
    });

    it('contains every enum value exactly once', () => {
      expect(BROKER_AUTHORIZATION_STATUSES).toHaveLength(12);
      expect(BROKER_AUTHORIZATION_STATUSES).toContain(BrokerAuthorizationStatus.ACTIVE);
      expect(BROKER_AUTHORIZATION_STATUSES).toContain(BrokerAuthorizationStatus.REVOKED);
    });
  });

  describe('valid lifecycle paths', () => {
    it('allows the full DEMO path: NOT_CONNECTED → CONNECTING → CONNECTED → AUTHORIZED', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.NOT_CONNECTED,
          BrokerAuthorizationStatus.CONNECTING,
        ),
      ).toBe(true);
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.CONNECTING,
          BrokerAuthorizationStatus.CONNECTED,
        ),
      ).toBe(true);
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.CONNECTED,
          BrokerAuthorizationStatus.AUTHORIZED,
        ),
      ).toBe(true);
    });

    it('allows the LIVE authorization path: CONNECTED → ACTIVE (explicit endpoint only)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.CONNECTED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(true);
      // Via the AUTHORIZED intermediate state as well
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.AUTHORIZED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(true);
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.READY,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(true);
    });

    it('allows revocation from authorized/active states', () => {
      for (const from of [
        BrokerAuthorizationStatus.AUTHORIZED,
        BrokerAuthorizationStatus.READY,
        BrokerAuthorizationStatus.ACTIVE,
      ]) {
        expect(
          BrokerAuthorizationStateMachine.canTransition(from, BrokerAuthorizationStatus.REVOKED),
        ).toBe(true);
      }
    });

    it('allows suspended connections to recover through re-verification', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.SUSPENDED,
          BrokerAuthorizationStatus.VERIFYING,
        ),
      ).toBe(true);
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.SUSPENDED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(true);
    });

    it('allows REVOKED to re-enter through AUTHORIZATION_REQUIRED (full re-auth)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.REVOKED,
          BrokerAuthorizationStatus.AUTHORIZATION_REQUIRED,
        ),
      ).toBe(true);
    });
  });

  describe('INVALID transitions are rejected (no arbitrary mutation)', () => {
    it('rejects NOT_CONNECTED → ACTIVE (can never jump straight to execution)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.NOT_CONNECTED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(false);
    });

    it('rejects CONNECTING → ACTIVE (must complete the handshake first)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.CONNECTING,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(false);
    });

    it('allows CONNECTING → AUTHORIZED (DEMO validation completes within the handshake)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.CONNECTING,
          BrokerAuthorizationStatus.AUTHORIZED,
        ),
      ).toBe(true);
    });

    it('rejects DISCONNECTED → ACTIVE (must reconnect first)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.DISCONNECTED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(false);
    });

    it('rejects ERROR → ACTIVE (must recover through reconnection)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.ERROR,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(false);
    });

    it('rejects REVOKED → ACTIVE (re-authorization path only)', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          BrokerAuthorizationStatus.REVOKED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(false);
    });

    it('assertTransition throws with a descriptive message', () => {
      expect(() =>
        BrokerAuthorizationStateMachine.assertTransition(
          BrokerAuthorizationStatus.NOT_CONNECTED,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toThrow(/Invalid broker authorization transition: NOT_CONNECTED → ACTIVE/);
    });
  });

  describe('fail-closed execution gate (Directive §16/§48)', () => {
    it('isExecutable returns true ONLY for ACTIVE', () => {
      expect(BrokerAuthorizationStateMachine.isExecutable(BrokerAuthorizationStatus.ACTIVE)).toBe(
        true,
      );
      for (const status of BROKER_AUTHORIZATION_STATUSES) {
        if (status === BrokerAuthorizationStatus.ACTIVE) continue;
        expect(BrokerAuthorizationStateMachine.isExecutable(status)).toBe(false);
      }
    });

    it('isExecutable fails closed on null/undefined/unknown state', () => {
      expect(BrokerAuthorizationStateMachine.isExecutable(null)).toBe(false);
      expect(BrokerAuthorizationStateMachine.isExecutable(undefined)).toBe(false);
      // Unknown state — never executable
      expect(BrokerAuthorizationStateMachine.isExecutable('HACKED' as never)).toBe(false);
    });

    it('canTransition fails closed on null/undefined/unknown from-state', () => {
      expect(
        BrokerAuthorizationStateMachine.canTransition(null, BrokerAuthorizationStatus.ACTIVE),
      ).toBe(false);
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          undefined,
          BrokerAuthorizationStatus.CONNECTED,
        ),
      ).toBe(false);
      expect(
        BrokerAuthorizationStateMachine.canTransition(
          'HACKED' as never,
          BrokerAuthorizationStatus.ACTIVE,
        ),
      ).toBe(false);
    });
  });

  describe('UI presentation groups (non-authoritative)', () => {
    it('groups ACTIVE as EXECUTING', () => {
      expect(BrokerAuthorizationStateMachine.describeGroup(BrokerAuthorizationStatus.ACTIVE)).toBe(
        'EXECUTING',
      );
    });

    it('groups NOT_CONNECTED/unknown safely', () => {
      expect(
        BrokerAuthorizationStateMachine.describeGroup(BrokerAuthorizationStatus.NOT_CONNECTED),
      ).toBe('NOT_CONNECTED');
      expect(BrokerAuthorizationStateMachine.describeGroup(null)).toBe('NOT_CONNECTED');
      expect(BrokerAuthorizationStateMachine.describeGroup(undefined)).toBe('NOT_CONNECTED');
    });
  });
});
