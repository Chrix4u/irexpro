import { ForbiddenException } from '@nestjs/common';
import { PerformanceFeePaymentController } from './performance-fee-payment.controller';
import { RoleName } from '../users/entities/role.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AuthenticatedPrincipal } from '../../common/interfaces/authenticated-principal.interface';

/**
 * Hotfix: all 4 controller methods now accept `@CurrentUser() principal:
 * AuthenticatedPrincipal` (they all call `isAdmin()` for role checks).
 */
function normalUser(): AuthenticatedPrincipal {
  return {
    userId: 'user-1',
    email: null,
    phone: null,
    roles: [RoleName.USER],
    status: UserStatus.ACTIVE,
  };
}
function adminUser(): AuthenticatedPrincipal {
  return {
    userId: 'admin-1',
    email: null,
    phone: null,
    roles: [RoleName.ADMIN],
    status: UserStatus.ACTIVE,
  };
}

let svc: any;
let controller: PerformanceFeePaymentController;

beforeEach(() => {
  svc = {
    listUserPerformanceFeeInvoices: jest.fn(async () => []),
    getInvoiceView: jest.fn(async () => ({})),
    initiatePerformanceFeeCheckout: jest.fn(async () => ({})),
    getPerformanceFeePaymentStatus: jest.fn(async () => ({})),
  };
  controller = new PerformanceFeePaymentController(svc);
});

describe('listInvoices', () => {
  it('normal user with no userId query is scoped to own id', async () => {
    await controller.listInvoices(normalUser(), undefined, undefined, undefined);
    expect(svc.listUserPerformanceFeeInvoices).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('normal user cannot list another user invoices (403)', () => {
    // The guard throws synchronously before any promise is returned.
    expect(() => controller.listInvoices(normalUser(), 'other-user', undefined, undefined)).toThrow(
      ForbiddenException,
    );
  });

  it('admin can list any user invoices', async () => {
    await controller.listInvoices(adminUser(), 'target-user', undefined, undefined);
    expect(svc.listUserPerformanceFeeInvoices).toHaveBeenCalledWith(
      'target-user',
      expect.anything(),
    );
  });

  it('admin with no userId receives the global bounded invoice workspace', async () => {
    await controller.listInvoices(adminUser(), undefined, undefined, undefined);
    expect(svc.listUserPerformanceFeeInvoices).toHaveBeenCalledWith(undefined, expect.anything());
  });
});

describe('getInvoice', () => {
  it('delegates with isAdmin=false for normal user', async () => {
    await controller.getInvoice('invoice-1', normalUser());
    expect(svc.getInvoiceView).toHaveBeenCalledWith('invoice-1', 'user-1', false);
  });

  it('delegates with isAdmin=true for admin', async () => {
    await controller.getInvoice('invoice-1', adminUser());
    expect(svc.getInvoiceView).toHaveBeenCalledWith('invoice-1', 'admin-1', true);
  });
});

describe('initiateCheckout', () => {
  it('delegates checkout with requesting user + isAdmin flag', async () => {
    await controller.initiateCheckout(
      'invoice-1',
      { provider: 'stripe', countryCode: 'US', currency: 'USD' },
      normalUser(),
      { ip: '1.2.3.4' },
    );
    expect(svc.initiatePerformanceFeeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'invoice-1',
        requestingUserId: 'user-1',
        isAdmin: false,
        ipAddress: '1.2.3.4',
      }),
    );
  });

  it('delegates checkout for an admin with isAdmin=true (admin-initiated checkout on behalf of a user)', async () => {
    await controller.initiateCheckout(
      'invoice-1',
      { provider: 'stripe', countryCode: 'US', currency: 'USD' },
      adminUser(),
      { ip: '5.6.7.8' },
    );
    expect(svc.initiatePerformanceFeeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: 'invoice-1',
        requestingUserId: 'admin-1',
        isAdmin: true,
        ipAddress: '5.6.7.8',
      }),
    );
  });
});

describe('getPaymentStatus', () => {
  it('delegates status lookup with isAdmin flag', async () => {
    await controller.getPaymentStatus('invoice-1', adminUser(), { ip: '9.9.9.9' });
    expect(svc.getPerformanceFeePaymentStatus).toHaveBeenCalledWith(
      'invoice-1',
      'admin-1',
      true,
      '9.9.9.9',
    );
  });

  it('delegates status lookup with isAdmin=false for a normal user', async () => {
    await controller.getPaymentStatus('invoice-1', normalUser(), { ip: '1.1.1.1' });
    expect(svc.getPerformanceFeePaymentStatus).toHaveBeenCalledWith(
      'invoice-1',
      'user-1',
      false,
      '1.1.1.1',
    );
  });
});
