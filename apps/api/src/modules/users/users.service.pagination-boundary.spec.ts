import { UsersService } from './users.service';

describe('UsersService — admin user pagination boundary', () => {
  const userRepo = {
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const service = new UsersService(userRepo as never, {} as never, {} as never);

  beforeEach(() => {
    jest.clearAllMocks();
    userRepo.findAndCount.mockResolvedValue([[], 0]);
  });

  async function expectPagination(page: unknown, limit: unknown, skip: number, take: number) {
    await service.findAll(page as number, limit as number);
    expect(userRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip, take }),
    );
  }

  it('preserves defaults and ordinary valid pagination', async () => {
    await expectPagination(undefined, undefined, 0, 20);
    await expectPagination(3, 25, 50, 25);
    await expectPagination('2', '25', 25, 25);
  });

  it('caps an oversized positive limit at 100', async () => {
    await expectPagination(3, 1000, 200, 100);
  });

  it.each([
    [-1, -5],
    [0, 0],
    [1.5, 2.5],
    [Number.NaN, Number.POSITIVE_INFINITY],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
    ['-7', '2.5'],
  ])('falls back safely for invalid page=%p limit=%p', async (page, limit) => {
    await expectPagination(page, limit, 0, 20);
  });

  it('keeps the computed offset within JavaScript safe-integer bounds', async () => {
    await service.findAll(Number.MAX_SAFE_INTEGER, 100);

    const options = userRepo.findAndCount.mock.calls[0]?.[0] as {
      skip: number;
      take: number;
    };
    expect(options.take).toBe(100);
    expect(Number.isSafeInteger(options.skip)).toBe(true);
    expect(options.skip).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});
