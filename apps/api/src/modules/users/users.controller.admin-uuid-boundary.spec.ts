import { ParseUUIDPipe } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { UsersController } from './users.controller';

/**
 * Security regression for #262: administrator-controlled user IDs must be
 * rejected as malformed input before UUID-backed persistence is reached.
 */
describe('UsersController — admin UUID route boundary', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const controllerPath = path.resolve(__dirname, './users.controller.ts');

  it('wires ParseUUIDPipe to both administrator user-id parameters', () => {
    const source = fs.readFileSync(controllerPath, 'utf8');

    expect(source).toContain("getUserById(@Param('id', ParseUUIDPipe) id: string)");
    expect(source).toContain("getUserOnboardingStatus(@Param('id', ParseUUIDPipe) id: string)");
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

  it('preserves valid UUID service contracts for both administrator handlers', async () => {
    const usersService = {
      findById: jest.fn().mockResolvedValue({ id: USER_ID }),
    };
    const onboardingService = {
      getOnboardingStatus: jest.fn().mockResolvedValue({ userId: USER_ID }),
    };
    const controller = new UsersController(
      usersService as never,
      onboardingService as never,
      { log: jest.fn() } as never,
    );

    await controller.getUserById(USER_ID);
    await controller.getUserOnboardingStatus(USER_ID);

    expect(usersService.findById).toHaveBeenCalledWith(USER_ID);
    expect(onboardingService.getOnboardingStatus).toHaveBeenCalledWith(USER_ID);
  });
});
