import { ParseUUIDPipe } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AccountGovernanceController } from './account-governance.controller';
import { AccountAppealDecision } from './entities/account-appeal.entity';
import { AccountStatusAction } from './dto/update-account-status.dto';

/**
 * Security regression for #264: administrator-controlled account-governance
 * path IDs must be rejected before UUID-backed persistence is reached.
 */
describe('AccountGovernanceController — admin UUID route boundary', () => {
  const APPEAL_ID = '22222222-2222-4222-8222-222222222222';
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
  const controllerPath = path.resolve(__dirname, './account-governance.controller.ts');

  it('wires ParseUUIDPipe to appeal-resolution and account-status IDs', () => {
    const source = fs.readFileSync(controllerPath, 'utf8');

    expect(source).toContain("@Param('id', ParseUUIDPipe) appealId: string");
    expect(source).toContain("@Param('id', ParseUUIDPipe) userId: string");
  });

  it.each(['not-a-uuid', `${APPEAL_ID}\nforged-log-line`, 'x'.repeat(4096)])(
    'rejects malformed UUID input %p before a controller handler can receive it',
    async (value) => {
      const pipe = new ParseUUIDPipe();
      await expect(
        pipe.transform(value, { type: 'param', metatype: String, data: 'id' }),
      ).rejects.toThrow();
    },
  );

  it('preserves valid UUID service contracts for both privileged mutations', async () => {
    const service = {
      resolveAppeal: jest.fn().mockResolvedValue({}),
      applyAdminAction: jest.fn().mockResolvedValue({}),
    };
    const controller = new AccountGovernanceController(service as never);

    await controller.resolveAppeal(APPEAL_ID, ADMIN_ID, {
      decision: AccountAppealDecision.REACTIVATE,
    });
    await controller.updateAccountStatus(USER_ID, ADMIN_ID, {
      action: AccountStatusAction.DEACTIVATE,
      reason: 'Policy review',
    });

    expect(service.resolveAppeal).toHaveBeenCalledWith(APPEAL_ID, ADMIN_ID, {
      decision: AccountAppealDecision.REACTIVATE,
    });
    expect(service.applyAdminAction).toHaveBeenCalledWith(USER_ID, ADMIN_ID, {
      action: AccountStatusAction.DEACTIVATE,
      reason: 'Policy review',
    });
  });
});
