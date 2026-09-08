from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


def replace_between(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    text = read(path)
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f"{path}: start marker not found: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f"{path}: end marker not found: {end_marker!r}")
    write(path, text[:start] + replacement + text[end:])


# 1) Backend service: bounded findAndCount + safe pagination normalization.
service = "apps/api/src/modules/users/account-governance.service.ts"
replace_once(
    service,
    "export interface AdminAccountStatusView {\n",
    "export interface AccountAppealListResponse {\n"
    "  items: AccountAppealAdminView[];\n"
    "  page: number;\n"
    "  limit: number;\n"
    "  total: number;\n"
    "  totalPages: number;\n"
    "}\n\n"
    "export interface AdminAccountStatusView {\n",
)
replace_between(
    service,
    "  async listAppeals(",
    "  async resolveAppeal(",
    "  async listAppeals(\n"
    "    status?: AccountAppealStatus,\n"
    "    requestedPage = 1,\n"
    "    requestedLimit = 20,\n"
    "  ): Promise<AccountAppealListResponse> {\n"
    "    const { page, limit, skip } = this.normalizeAppealPagination(\n"
    "      requestedPage,\n"
    "      requestedLimit,\n"
    "    );\n"
    "    const [appeals, total] = await this.appealRepo.findAndCount({\n"
    "      where: status ? { status } : {},\n"
    "      relations: ['user', 'user.profile'],\n"
    "      withDeleted: true,\n"
    "      order: { createdAt: 'ASC', id: 'ASC' },\n"
    "      skip,\n"
    "      take: limit,\n"
    "    });\n"
    "\n"
    "    return {\n"
    "      items: appeals.map((appeal) => this.toAdminAppealView(appeal)),\n"
    "      page,\n"
    "      limit,\n"
    "      total,\n"
    "      totalPages: total === 0 ? 0 : Math.ceil(total / limit),\n"
    "    };\n"
    "  }\n\n"
)
replace_once(
    service,
    "  /** Explicit allowlist for admin browser responses; never serialize entities. */\n",
    "  /**\n"
    "   * Normalize pagination at the service boundary as defense in depth. HTTP\n"
    "   * validation rejects malformed query values, but direct/internal callers\n"
    "   * must never be able to produce negative, fractional, non-finite, or\n"
    "   * overflow-scale TypeORM offsets.\n"
    "   */\n"
    "  private normalizeAppealPagination(\n"
    "    requestedPage: number,\n"
    "    requestedLimit: number,\n"
    "  ): { page: number; limit: number; skip: number } {\n"
    "    const limitCandidate = Number.isFinite(requestedLimit)\n"
    "      ? Math.trunc(requestedLimit)\n"
    "      : 20;\n"
    "    const limit = Math.min(100, Math.max(1, limitCandidate));\n"
    "\n"
    "    const pageCandidate = Number.isFinite(requestedPage)\n"
    "      ? Math.trunc(requestedPage)\n"
    "      : 1;\n"
    "    const positivePage = Math.max(1, pageCandidate);\n"
    "    const maxPageForSafeOffset = Math.floor(Number.MAX_SAFE_INTEGER / limit) + 1;\n"
    "    const page = Math.min(positivePage, maxPageForSafeOffset);\n"
    "    const skip = (page - 1) * limit;\n"
    "\n"
    "    return { page, limit, skip };\n"
    "  }\n\n"
    "  /** Explicit allowlist for admin browser responses; never serialize entities. */\n",
)

# 2) HTTP query DTO and controller wiring.
dto = "apps/api/src/modules/users/dto/list-account-appeals-query.dto.ts"
Path(dto).write_text(
    "import { ApiPropertyOptional } from '@nestjs/swagger';\n"
    "import { Type } from 'class-transformer';\n"
    "import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';\n"
    "import { AccountAppealStatus } from '../entities/account-appeal.entity';\n\n"
    "/** Validated, bounded query contract for the PII-bearing admin appeal queue. */\n"
    "export class ListAccountAppealsQueryDto {\n"
    "  @ApiPropertyOptional({ enum: AccountAppealStatus })\n"
    "  @IsOptional()\n"
    "  @IsEnum(AccountAppealStatus)\n"
    "  status?: AccountAppealStatus;\n\n"
    "  @ApiPropertyOptional({ description: 'One-based page number', default: 1, minimum: 1 })\n"
    "  @Type(() => Number)\n"
    "  @IsInt()\n"
    "  @Min(1)\n"
    "  @Max(Number.MAX_SAFE_INTEGER)\n"
    "  page: number = 1;\n\n"
    "  @ApiPropertyOptional({ description: 'Page size (1-100)', default: 20, minimum: 1, maximum: 100 })\n"
    "  @Type(() => Number)\n"
    "  @IsInt()\n"
    "  @Min(1)\n"
    "  @Max(100)\n"
    "  limit: number = 20;\n"
    "}\n",
    encoding="utf-8",
)

controller = "apps/api/src/modules/users/account-governance.controller.ts"
replace_once(controller, "  ParseEnumPipe,\n", "")
replace_once(
    controller,
    "import { ResolveAccountAppealDto } from './dto/resolve-account-appeal.dto';\n",
    "import { ListAccountAppealsQueryDto } from './dto/list-account-appeals-query.dto';\n"
    "import { ResolveAccountAppealDto } from './dto/resolve-account-appeal.dto';\n",
)
replace_between(
    controller,
    "  async listAppeals(\n",
    "  @Post('admin/account-appeals/:id/resolve')",
    "  async listAppeals(@Query() query: ListAccountAppealsQueryDto) {\n"
    "    return this.governanceService.listAppeals(query.status, query.page, query.limit);\n"
    "  }\n\n",
)

# 3) Backend deterministic tests.
service_spec = "apps/api/src/modules/users/account-governance.service.spec.ts"
replace_once(service_spec, "    find: jest.fn(),\n", "    findAndCount: jest.fn(),\n")
replace_between(
    service_spec,
    "  describe('listAppeals', () => {",
    "  describe('resolveAppeal', () => {",
    "  describe('listAppeals', () => {\n"
    "    it('returns a bounded oldest-first page with total metadata and a frontend-safe projection', async () => {\n"
    "      const user = makeUser({\n"
    "        passwordHash: 'never-expose-password-hash',\n"
    "      } as Partial<User>);\n"
    "      appealRepo.findAndCount.mockResolvedValue([[makeAppeal({ user })], 41]);\n"
    "\n"
    "      const result = await service.listAppeals(AccountAppealStatus.PENDING, 2, 20);\n"
    "\n"
    "      expect(result).toEqual({\n"
    "        items: [\n"
    "          expect.objectContaining({\n"
    "            id: '22222222-2222-4222-8222-222222222222',\n"
    "            user: expect.objectContaining({ id: user.id, email: user.email, status: user.status }),\n"
    "          }),\n"
    "        ],\n"
    "        page: 2,\n"
    "        limit: 20,\n"
    "        total: 41,\n"
    "        totalPages: 3,\n"
    "      });\n"
    "      expect(JSON.stringify(result)).not.toContain('never-expose-password-hash');\n"
    "      expect(appealRepo.findAndCount).toHaveBeenCalledWith({\n"
    "        where: { status: AccountAppealStatus.PENDING },\n"
    "        relations: ['user', 'user.profile'],\n"
    "        withDeleted: true,\n"
    "        order: { createdAt: 'ASC', id: 'ASC' },\n"
    "        skip: 20,\n"
    "        take: 20,\n"
    "      });\n"
    "    });\n"
    "\n"
    "    it('normalizes hostile direct-call pagination before constructing TypeORM offsets', async () => {\n"
    "      appealRepo.findAndCount.mockResolvedValue([[], 0]);\n"
    "\n"
    "      const invalidResult = await service.listAppeals(\n"
    "        undefined,\n"
    "        Number.POSITIVE_INFINITY,\n"
    "        Number.NaN,\n"
    "      );\n"
    "      expect(invalidResult).toEqual({\n"
    "        items: [],\n"
    "        page: 1,\n"
    "        limit: 20,\n"
    "        total: 0,\n"
    "        totalPages: 0,\n"
    "      });\n"
    "      expect(appealRepo.findAndCount).toHaveBeenLastCalledWith(\n"
    "        expect.objectContaining({ skip: 0, take: 20 }),\n"
    "      );\n"
    "\n"
    "      await service.listAppeals(undefined, Number.MAX_VALUE, 500.75);\n"
    "      const options = appealRepo.findAndCount.mock.calls.at(-1)?.[0] as {\n"
    "        skip: number;\n"
    "        take: number;\n"
    "      };\n"
    "      expect(options.take).toBe(100);\n"
    "      expect(Number.isSafeInteger(options.skip)).toBe(true);\n"
    "      expect(options.skip).toBeGreaterThanOrEqual(0);\n"
    "      expect(options.skip).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);\n"
    "    });\n"
    "  });\n\n",
)

controller_spec = "apps/api/src/modules/users/account-governance.controller.spec.ts"
replace_once(
    controller_spec,
    "  it('passes an optional queue status through unchanged', async () => {\n"
    "    service.listAppeals.mockResolvedValue([]);\n\n"
    "    await controller.listAppeals(AccountAppealStatus.PENDING);\n\n"
    "    expect(service.listAppeals).toHaveBeenCalledWith(AccountAppealStatus.PENDING);\n"
    "  });\n",
    "  it('passes the validated queue status and pagination contract through unchanged', async () => {\n"
    "    service.listAppeals.mockResolvedValue({\n"
    "      items: [],\n"
    "      page: 2,\n"
    "      limit: 10,\n"
    "      total: 0,\n"
    "      totalPages: 0,\n"
    "    });\n\n"
    "    await controller.listAppeals({\n"
    "      status: AccountAppealStatus.PENDING,\n"
    "      page: 2,\n"
    "      limit: 10,\n"
    "    });\n\n"
    "    expect(service.listAppeals).toHaveBeenCalledWith(AccountAppealStatus.PENDING, 2, 10);\n"
    "  });\n",
)

# 4) Shared frontend-safe contract.
types = "packages/types/src/index.ts"
replace_once(
    types,
    "export interface ResolveAccountAppealRequest {\n",
    "export interface AccountAppealListResponse {\n"
    "  items: AccountAppealAdminView[];\n"
    "  page: number;\n"
    "  limit: number;\n"
    "  total: number;\n"
    "  totalPages: number;\n"
    "}\n\n"
    "export interface ResolveAccountAppealRequest {\n",
)

client = "packages/api-client/src/index.ts"
replace_once(client, "  AccountAppealAdminView,\n", "  AccountAppealAdminView,\n  AccountAppealListResponse,\n")
replace_once(
    client,
    "  /** Admin-only appeal queue. */\n  listAccountAppeals(status?: AccountAppealStatus): Promise<AccountAppealAdminView[]>;\n",
    "  /** Admin-only appeal queue with bounded, server-authoritative pagination. */\n"
    "  listAccountAppeals(query?: {\n"
    "    status?: AccountAppealStatus;\n"
    "    page?: number;\n"
    "    limit?: number;\n"
    "  }): Promise<AccountAppealListResponse>;\n",
)
replace_between(
    client,
    "    listAccountAppeals:",
    "    resolveAccountAppeal:",
    "    listAccountAppeals: (query) => {\n"
    "      const params = new URLSearchParams();\n"
    "      if (query?.status !== undefined) params.set('status', query.status);\n"
    "      if (query?.page !== undefined) params.set('page', String(query.page));\n"
    "      if (query?.limit !== undefined) params.set('limit', String(query.limit));\n"
    "      const search = params.toString();\n"
    "      return request<AccountAppealListResponse>(\n"
    "        search ? `/admin/account-appeals?${search}` : '/admin/account-appeals',\n"
    "      );\n"
    "    },\n\n"
)

contracts = "packages/api-client/scripts/test-contracts.cjs"
insert_contract = r'''async function testListAccountAppealsContract() {
  const scenarios = [
    {
      label: 'status and page supplied',
      args: { status: 'PENDING', page: 2, limit: 20 },
      expectedPath: '/admin/account-appeals?status=PENDING&page=2&limit=20',
    },
    {
      label: 'no args lets the server apply defaults',
      args: undefined,
      expectedPath: '/admin/account-appeals',
    },
    {
      label: 'page only omits absent filters',
      args: { page: 3 },
      expectedPath: '/admin/account-appeals?page=3',
    },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    const responseBody = {
      items: [],
      page: scenario.args?.page ?? 1,
      limit: scenario.args?.limit ?? 20,
      total: 47,
      totalPages: 3,
    };
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => responseBody,
      };
    };

    const { createApiClient } = loadApiClient(fakeFetch);
    const client = createApiClient({
      baseUrl: 'https://api.example.test/api/v1',
      getAccessToken: () => 'fixture-access-token',
    });

    const result = await client.listAccountAppeals(scenario.args);

    assert.deepEqual(result, responseBody);
    assert.equal(calls.length, 1, `account appeals (${scenario.label}) must issue one request`);
    const [{ url, init }] = calls;
    assert.equal(url, `https://api.example.test/api/v1${scenario.expectedPath}`);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.headers.Authorization, 'Bearer fixture-access-token');
  }
}

'''
replace_once(contracts, "async function testListSecurityEventsContract() {\n", insert_contract + "async function testListSecurityEventsContract() {\n")
replace_once(
    contracts,
    "  await testListSecurityEventsContract();\n  console.log('api-client security-events contract test passed.');\n",
    "  await testListAccountAppealsContract();\n"
    "  console.log('api-client account-appeals pagination contract test passed.');\n"
    "  await testListSecurityEventsContract();\n"
    "  console.log('api-client security-events contract test passed.');\n",
)

# 5) Admin page: real total + Previous/Next navigation, keeping review semantics.
admin = "apps/admin/src/app/admin/(protected)/account-appeals/page.tsx"
replace_once(
    admin,
    "]\n\nfunction formatDateTime",
    "]\n\nconst APPEAL_PAGE_SIZE = 20;\n\nfunction formatDateTime",
)
replace_once(
    admin,
    "  const [appeals, setAppeals] = useState<AccountAppealAdminView[]>([]);\n",
    "  const [appeals, setAppeals] = useState<AccountAppealAdminView[]>([]);\n"
    "  const [page, setPage] = useState(1);\n"
    "  const [total, setTotal] = useState(0);\n"
    "  const [totalPages, setTotalPages] = useState(0);\n",
)
replace_between(
    admin,
    "  useEffect(() => {\n",
    "  const selectedAppeal =\n",
    "  useEffect(() => {\n"
    "    if (!hasAdminRole) return;\n"
    "    let cancelled = false;\n"
    "    setLoading(true);\n"
    "    setError(null);\n"
    "    setSelectedId(null);\n"
    "    (async () => {\n"
    "      try {\n"
    "        const response = await api.listAccountAppeals({\n"
    "          status: 'PENDING',\n"
    "          page,\n"
    "          limit: APPEAL_PAGE_SIZE,\n"
    "        });\n"
    "        if (cancelled) return;\n"
    "        if (response.totalPages > 0 && page > response.totalPages) {\n"
    "          setPage(response.totalPages);\n"
    "          return;\n"
    "        }\n"
    "        setAppeals(response.items);\n"
    "        setTotal(response.total);\n"
    "        setTotalPages(response.totalPages);\n"
    "      } catch (requestError) {\n"
    "        if (!cancelled) {\n"
    "          setError(\n"
    "            requestError instanceof Error\n"
    "              ? requestError.message\n"
    "              : 'Unable to load account reviews.',\n"
    "          );\n"
    "        }\n"
    "      } finally {\n"
    "        if (!cancelled) setLoading(false);\n"
    "      }\n"
    "    })();\n"
    "    return () => {\n"
    "      cancelled = true;\n"
    "    };\n"
    "  }, [hasAdminRole, page]);\n\n"
)
replace_once(
    admin,
    "      setAppeals((current) =>\n        current.filter((appeal) => appeal.id !== selectedAppeal.id),\n      );\n      setSelectedId(null);\n",
    "      const remainingItems = appeals.filter(\n"
    "        (appeal) => appeal.id !== selectedAppeal.id,\n"
    "      );\n"
    "      const nextTotal = Math.max(0, total - 1);\n"
    "      const nextTotalPages =\n"
    "        nextTotal === 0 ? 0 : Math.ceil(nextTotal / APPEAL_PAGE_SIZE);\n"
    "      setAppeals(remainingItems);\n"
    "      setTotal(nextTotal);\n"
    "      setTotalPages(nextTotalPages);\n"
    "      if (remainingItems.length === 0 && page > 1) {\n"
    "        setPage(page - 1);\n"
    "      }\n"
    "      setSelectedId(null);\n",
)
replace_once(admin, "        <Card title={`Pending requests (${appeals.length})`}>\n", "        <Card title={`Pending requests (${total})`}>\n")
replace_once(
    admin,
    "          )}\n        </Card>\n\n        <Card title=\"Review decision\" className=\"admin-appeals-detail-card\">\n",
    "          )}\n"
    "          {totalPages > 1 && (\n"
    "            <div\n"
    "              style={{\n"
    "                display: 'flex',\n"
    "                alignItems: 'center',\n"
    "                justifyContent: 'space-between',\n"
    "                gap: '0.75rem',\n"
    "                marginTop: '1rem',\n"
    "              }}\n"
    "            >\n"
    "              <Button\n"
    "                type=\"button\"\n"
    "                variant=\"secondary\"\n"
    "                size=\"sm\"\n"
    "                disabled={loading || page <= 1}\n"
    "                onClick={() => setPage((current) => Math.max(1, current - 1))}\n"
    "              >\n"
    "                Previous\n"
    "              </Button>\n"
    "              <span className=\"text-sm muted\" aria-live=\"polite\">\n"
    "                Page {page} of {totalPages}\n"
    "              </span>\n"
    "              <Button\n"
    "                type=\"button\"\n"
    "                variant=\"secondary\"\n"
    "                size=\"sm\"\n"
    "                disabled={loading || page >= totalPages}\n"
    "                onClick={() =>\n"
    "                  setPage((current) => Math.min(totalPages, current + 1))\n"
    "                }\n"
    "              >\n"
    "                Next\n"
    "              </Button>\n"
    "            </div>\n"
    "          )}\n"
    "        </Card>\n\n"
    "        <Card title=\"Review decision\" className=\"admin-appeals-detail-card\">\n",
)

print("Account appeal pagination patch applied successfully.")
