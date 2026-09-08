import { ParseUUIDPipe } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { EligibilityController } from './eligibility.controller';

/**
 * Security regression for #266: administrator-controlled eligibility/KYC
 * user IDs must be rejected before UUID-backed persistence is reached.
 */
describe('EligibilityController — admin UUID route boundary', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const REVIEWER_ID = '33333333-3333-4333-8333-333333333333';
  const controllerPath = path.resolve(__dirname, './eligibility.controller.ts');

  it('wires ParseUUIDPipe to jurisdiction and KYC review user IDs', () => {
    const source = fs.readFileSync(controllerPath, 'utf8');

    expect(source).toContain("@Param('id', ParseUUIDPipe) userId: string");
    expect(source.match(/@Param\('id', ParseUUIDPipe\) userId: string/g)).toHaveLength(2);
  });

  it.each(['not-a-uuid', `${USER_ID}\nforged-log-line`, 'x'.repeat(4096)])(
    'rejects malformed UUID input %p before a controller handler can receive it',
    async (value) => {
      const pipe = new ParseUUIDPipe();
      await expect(
        pipe.transform(value, { type: 'param', metatype: String, data: 'id' }),
      ).rejects.toThrow();
    },
  );

  it('preserves valid UUID service contracts for jurisdiction and KYC reviews', async () => {
    const service = {
      reviewUser: jest.fn().mockResolvedValue({}),
      reviewKyc: jest.fn().mockResolvedValue({}),
    };
    const controller = new EligibilityController(service as never);
    const jurisdictionDto = {} as never;
    const kycDto = {} as never;

    await controller.reviewUser(USER_ID, REVIEWER_ID, jurisdictionDto);
    await controller.reviewKyc(USER_ID, REVIEWER_ID, kycDto);

    expect(service.reviewUser).toHaveBeenCalledWith(USER_ID, REVIEWER_ID, jurisdictionDto);
    expect(service.reviewKyc).toHaveBeenCalledWith(USER_ID, REVIEWER_ID, kycDto);
  });
});
