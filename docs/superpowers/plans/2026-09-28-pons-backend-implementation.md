# Pons Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng BE chỉ đọc có thể quét đầy đủ launch/giao dịch chính thức pons v1/v2 trên Robinhood, phục hồi realtime và cung cấp API có trạng thái đồng bộ.

**Architecture:** Một npm workspace chứa `be/`; HTTP API và indexer là hai tiến trình dùng chung domain, adapter và PostgreSQL. Adapter giải mã giao thức; indexer quét theo block và lưu checkpoint; API chỉ đọc dữ liệu đã chuẩn hóa. Dữ liệu v1/v2 cùng đi qua hợp đồng domain để FE không cần biết cách quét riêng.

**Tech Stack:** Node.js 24 LTS, npm workspaces, TypeScript, Fastify, viem, PostgreSQL, Drizzle, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-28-pons-readonly-design.md` — đọc toàn bộ trước khi thực hiện.

## Global Constraints

- Scope chỉ gồm Robinhood Chain ID `4663`, pons v1 legacy/active và pons v2; không viết giao dịch tiền thật hay kết nối ví.
- Tên file/thư mục, biến, hàm, kiểu, trường API, test và chú thích code đều bằng tiếng Anh; tài liệu cho người dùng có thể bằng tiếng Việt.
- Tài sản/token nhận diện bằng `(chainId, address)`; số lượng tiền dùng `bigint`/chuỗi thập phân, không dùng JavaScript `number` để tính tiền.
- Volume chỉ từ nơi giao dịch chính thức, theo đúng tài sản ghép cặp; không quy đổi USD hoặc cộng các quote asset khác đơn vị.
- Dữ liệu thiếu là `null` kèm trạng thái bao phủ, không biểu diễn thành số 0; không tuyên bố đủ lịch sử khi còn khoảng chưa quét.
- WSS chỉ tăng tốc nhận tín hiệu mới; HTTP backfill/gap repair và checkpoint PostgreSQL quyết định tính đầy đủ.
- CI dùng fixture cố định và PostgreSQL test; không cần RPC thật, ví hoặc private key. Docker/Compose chỉ là lựa chọn để chạy PostgreSQL local.
- Mỗi task thực hiện test đỏ → code tối thiểu → test xanh → commit riêng. Người dùng đã yêu cầu tự triển khai sau khi hoàn tất kế hoạch; chỉ push các mốc đã kiểm chứng, không tự động deploy.

## Review Focus

1. Cùng địa chỉ token trên hai chain không được gộp → Task 1 test `tokenKey` với chain khác nhau.
2. Một log được RPC trả lặp hoặc bị reorg không được đếm volume hai lần → Task 3 và 5 test idempotency/retraction.
3. v2 dùng quote ERC-20 với decimals khác ETH không được tính sai giá/volume → Task 7 và 9 test quote normalization.
4. Lệnh mua cuối v2 bị khớp một phần và hoàn tiền không được tính volume theo lượng yêu cầu → Task 7 test `CurveBuy`/`CurveBuyRefunded`.
5. RPC thiếu archive hoặc giới hạn `eth_getLogs` không được tạo khoảng trống âm thầm → Task 4 và 10 test adaptive ranges/coverage.

## Bản đồ file chính

- Root: `package.json`, `package-lock.json`, `.nvmrc`, `.gitignore`, `.github/workflows/ci.yml`, `compose.yaml`, `README.md` — workspace, CI và hướng dẫn local.
- `be/src/domain/{types,ids}.ts` — hợp đồng dữ liệu chuẩn hóa và định danh.
- `be/src/chains/robinhood.ts`, `be/src/launchpads/pons/sourceRegistry.ts` — provider và factory/ABI/start block đã xác minh.
- `be/src/db/{schema,repository}.ts`, `be/drizzle/` — bảng, migration, giao dịch ghi dữ liệu/checkpoint.
- `be/src/indexer/{scan,live,reorg,reconcile}.ts` — backfill, head notification, reorg và độ bao phủ.
- `be/src/launchpads/pons/{v1,v2}/` — giải mã launch/venue/trade/state cho từng phiên bản.
- `be/src/market/{price,aggregate}.ts` — giá theo quote asset, nến và volume chính thức.
- `be/src/api/{server,routes,events}.ts`, `be/src/cli/{api,indexer}.ts` — API, SSE, entrypoint riêng.
- `be/tests/fixtures/`, `be/tests/integration/` — log thật cố định và test PostgreSQL; test đơn vị đặt cạnh module.

---

### Task 1: Workspace, domain identity và CI tối thiểu

**Files:** Tạo `package.json`, `package-lock.json`, `.nvmrc`, `.gitignore`, `be/package.json`, `be/tsconfig.json`, `be/src/domain/types.ts`, `be/src/domain/ids.ts`, `be/src/domain/ids.test.ts`, `.github/workflows/ci.yml`.

**Interfaces:** `tokenKey(chainId: number, tokenAddress: Address): string`; `venueKey(chainId: number, kind: VenueKind, ref: string): string`; `logKey(chainId: number, blockHash: Hash, txHash: Hash, logIndex: number): string`. `types.ts` xuất `Launch`, `Venue`, `Trade`, `LifecycleStatus`, `IndexBatch`, `SourceCursor` với số lượng on-chain ở dạng `bigint` và `VenueKind = 'v3_pool' | 'curve' | 'v4_pool'`.

- [ ] **Step 1 — Test đỏ:** Trong `ids.test.ts`, `expect(tokenKey(4663, A)).not.toBe(tokenKey(56, A))`; địa chỉ chữ hoa/thường cùng chain cho cùng key; `venueKey` không lẫn `v3_pool` với `v4_pool`.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- ids.test.ts`; mong đợi FAIL vì các hàm chưa tồn tại.
- [ ] **Step 3 — Code:** Tạo npm workspace chỉ chứa `be`, scripts `test`, `typecheck`, `build`, `lint`; dùng Node 24; cài Vitest/TypeScript; triển khai ba hàm và kiểu domain. CI chạy `npm ci`, lint, typecheck, test, build trên push/PR mà không gọi RPC.
- [ ] **Step 4 — Chạy xanh:** `npm test -w be -- ids.test.ts`, `npm run typecheck -w be`, `npm run build -w be`; tất cả exit 0. Kiểm tra workflow YAML parse hợp lệ.
- [ ] **Step 5 — Commit:** `git add package.json package-lock.json .nvmrc .gitignore be .github/workflows/ci.yml` rồi `git commit -m "feat: establish backend workspace and domain"`.

### Task 2: Danh mục nguồn pons và fixture có nguồn gốc

**Files:** Tạo `be/src/chains/robinhood.ts`, `be/src/launchpads/pons/sourceRegistry.ts`, `be/src/launchpads/pons/sourceRegistry.test.ts`, `be/src/cli/auditSources.ts`, `be/tests/fixtures/provenance.json`, các fixture log v1/v2 trong `be/tests/fixtures/`.

**Interfaces:** `getPonsFactorySources(): readonly FactorySource[]`, với `FactorySource = { id: string; chainId: 4663; version: 'v1' | 'v2'; factory: Address; startBlock: bigint; launchTopic: Hash }`; `createRobinhoodPublicClient(httpUrl: string)`. Task sau nhận danh mục này, không hardcode địa chỉ.

- [ ] **Step 1 — Test đỏ:** `sourceRegistry.test.ts` xác nhận có đúng ba factory (`v1` legacy `0x0c37a24F5D23A486FA692d1500881d698B1F77a4`, v1 active `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`, v2 `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`), chain 4663, start block > 0, không trùng source ID; fixture có block/tx/log hash và URL explorer.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- sourceRegistry.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code/audit:** Ghi start block v1 legacy `8600612`, active `8991118` theo tài liệu pons. `auditSources.ts` tìm block triển khai v2 từ explorer/chain và kiểm tra factory có bytecode + log mẫu; ghi số block và provenance thật vào registry/fixture. Thu ít nhất một log v1 và v2; không ghi API key vào repo. Nếu dữ liệu lịch sử không thể xác minh bằng endpoint miễn phí, lưu bằng chứng thất bại trong provenance và dừng các task phụ thuộc, không tự đoán start block.
- [ ] **Step 4 — Chạy xanh:** Test registry xanh; `npm run audit:sources -w be` xuất ba nguồn với bằng chứng; `npm run typecheck -w be` exit 0.
- [ ] **Step 5 — Commit:** `git add be/src/chains be/src/launchpads/pons/sourceRegistry* be/src/cli/auditSources.ts be/tests/fixtures` rồi commit `feat: verify pons source registry`.

### Task 3: PostgreSQL schema và repository ghi dữ liệu nguyên tử

**Files:** Tạo `be/src/db/{schema,client,repository}.ts`, `be/src/db/repository.test.ts`, `be/drizzle/`, `be/drizzle.config.ts`, `compose.yaml`, `be/.env.example`.

**Interfaces:** `saveIndexBatch(sourceId: string, fromBlock: bigint, toBlock: bigint, batch: IndexBatch): Promise<void>`; `getCursor(sourceId: string): Promise<SourceCursor>`; `retractBlocks(chainId: number, fromBlock: bigint): Promise<void>`; `listPendingSources(): Promise<IndexedSource[]>`. Bảng: `sources`, `raw_logs`, `launches`, `venues`, `trades`, `candles`; raw log khóa theo chain+block hash+tx hash+log index, các bản ghi liên kết nguồn log.

- [ ] **Step 1 — Test đỏ:** Integration test với PostgreSQL thật: cùng batch ghi hai lần chỉ có một trade; source cursor chỉ tăng sau khi cả batch commit; lỗi giữa transaction không tăng cursor; cùng địa chỉ token trên hai chain tạo hai bản ghi.
- [ ] **Step 2 — Chạy đỏ:** `npm run test:integration -w be -- repository.test.ts`; mong đợi FAIL trước migration/repository.
- [ ] **Step 3 — Code:** Tạo migration Drizzle, chỉ mục theo `(chain_id, token_address)`, `(source_id, block_number)`, `(chain_id, tx_hash, log_index)` cho canonical trade; lưu on-chain integers chính xác. `compose.yaml` chỉ chạy PostgreSQL có healthcheck; `DATABASE_URL` lấy từ environment, không commit giá trị thật.
- [ ] **Step 4 — Chạy xanh:** `npm run db:migrate -w be` trên database test và integration test xanh; chạy lại migration không phá dữ liệu.
- [ ] **Step 5 — Commit:** Stage đúng các file schema/repository/migration/Compose/env mẫu và commit `feat: persist indexed events and checkpoints`.

### Task 4: Backfill có giới hạn, batching và checkpoint

**Files:** Tạo `be/src/indexer/{scan,groupQueries}.ts`, `be/src/indexer/scan.test.ts`, `be/src/cli/indexer.ts`.

**Interfaces:** `scanToHead(source: LogSource, safeHead: bigint, deps: ScanDeps): Promise<ScanReport>`; `LogSource` chứa source ID, start block, contract address/topic hoặc nhóm địa chỉ; `ScanReport` chứa các range đã commit và range còn thiếu. `groupVenueQueries(venues: Venue[], maxAddresses: number): LogQuery[]` gom địa chỉ curve/V3 pool theo topic thay vì gọi từng token một.

- [ ] **Step 1 — Test đỏ:** Fake RPC trả lỗi giới hạn khi range lớn: scanner giảm chunk và quét đủ; crash trước commit giữ nguyên cursor; restart tiếp từ cursor+1; 2.000 venue được chia theo `maxAddresses`, không tạo 2.000 request mỗi block; provider trả lỗi lịch sử không hỗ trợ thì report ghi đúng range còn thiếu.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- scan.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Dùng `viem.getLogs` theo khoảng block có giới hạn, retry/backoff có trần, address/topic batching, `saveIndexBatch` cho ghi nguyên tử. Không quét `earliest`→`latest` bằng một request. CLI indexer lấy URL RPC từ environment và dùng source registry.
- [ ] **Step 4 — Chạy xanh:** `npm test -w be -- scan.test.ts` và `npm run typecheck -w be` exit 0; test scan không gọi RPC thật.
- [ ] **Step 5 — Commit:** Stage module scan/CLI/test và commit `feat: add resumable bounded backfill`.

### Task 5: Live head, quét bù và reorg

**Files:** Tạo `be/src/indexer/{live,reorg}.ts`, `be/src/indexer/live.test.ts`, `be/src/indexer/reorg.test.ts`.

**Interfaces:** `startLiveIndexer(deps: LiveDeps): Promise<StopFn>` nhận WSS head notification nếu có và gọi `scanToHead`; `reconcileCanonicalHead(chainId: number, safeHead: bigint, deps: ReorgDeps): Promise<ReorgReport>` so sánh block hash đã lưu, gọi `retractBlocks` và quét lại. HTTP polling vẫn hoạt động khi WSS mất.

- [ ] **Step 1 — Test đỏ:** Mất WSS từ block 100→110 rồi nối lại phải quét 101–110; cùng head đến hai lần không tăng trade count; reorg thay block 108–110 phải loại trade cũ và tính lại; WSS không khả dụng vẫn cập nhật qua HTTP polling.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- live.test.ts reorg.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** WSS chỉ đánh thức scanner; HTTP/checkpoint là cơ chế bảo đảm. Lưu block hash cho các block chưa đủ xác nhận, đặt confirmation depth trong cấu hình chain, không hardcode trong adapter.
- [ ] **Step 4 — Chạy xanh:** Hai file test, integration test repository và typecheck đều xanh.
- [ ] **Step 5 — Commit:** Stage module live/reorg/test và commit `feat: repair live gaps and handle reorgs`.

### Task 6: Adapter pons v1 — launch, V3 trade và tốt nghiệp

**Files:** Tạo `be/src/launchpads/pons/v1/{abi,adapter,state}.ts`, `be/src/launchpads/pons/v1/adapter.test.ts`, fixture v1 gồm token PONS tham chiếu.

**Interfaces:** `decodeV1Launch(log: RpcLog, factory: FactorySource): LaunchWithVenue`; `decodeV1Swap(log: RpcLog, venue: Venue): Trade`; `readV1Graduation(token: Address, factory: Address, block: bigint): Promise<boolean>`. V1 pool lấy từ `TokenLaunched`; `VenueKind = 'v3_pool'` trước/sau tốt nghiệp.

- [ ] **Step 1 — Test đỏ:** Log launch của cả legacy/active được nhận; V3 swap có chiều mua/bán theo thứ tự token0/token1; PONS tham chiếu tốt nghiệp vẫn có đúng một official venue; token giả cùng tên không được nhận là pons nếu không có factory log.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- v1/adapter.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Giải mã ABI đúng từng factory, đọc metadata/`graduationStatus` từ factory tương ứng, ghi các venue nguồn. Lấy `sqrtPriceX96` từ V3 swap để tính giá bằng rational bigint, không ép qua `Number`.
- [ ] **Step 4 — Chạy xanh:** Test adapter, typecheck và một lượt audit read-only cho PONS theo tài liệu pons xanh; nếu provider thiếu historical state thì test fixture vẫn chạy nhưng audit ghi rõ giới hạn.
- [ ] **Step 5 — Commit:** Stage adapter/test/fixture v1 và commit `feat: index pons v1 launches and trades`.

### Task 7: Adapter pons v2 — launch, curve, quote asset và phase

**Files:** Tạo `be/src/launchpads/pons/v2/{abi,curve,adapter}.ts`, `be/src/launchpads/pons/v2/adapter.test.ts`, fixture v2 cho curve trades và phase.

**Interfaces:** `decodeV2Launch(log: RpcLog): LaunchWithVenue`; `decodeCurveTrade(log: RpcLog, launch: Launch): Trade`; `readV2Phase(token: Address, block: bigint): Promise<0 | 1 | 2 | 3>`; `resolveV2QuoteAsset(launch: Launch): Address`. `phase` ánh xạ sang `trading`, `swept`, `graduated`, `rescued` mà không đoán theo balances.

- [ ] **Step 1 — Test đỏ:** `CurveBuy`/`CurveSell` dùng lượng khớp thực tế; giao dịch mua cuối có `CurveBuyRefunded` không cộng hoàn tiền vào volume; quote ERC-20 6 decimals không bị tính như ETH 18 decimals; phase 1 không có pool, phase 3 là rescued.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- v2/adapter.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Dùng event và `getLaunchedToken` đúng factory v2; lưu curve là official venue từ block launch tới trước phase 2; quote asset/decimals đọc theo từng launch và cache kèm nguồn. Tái tạo giá curve bằng trạng thái ban đầu và event có phí/thuế, đối chiếu fixture trạng thái lịch sử.
- [ ] **Step 4 — Chạy xanh:** Test adapter, typecheck và fixture đối chiếu giá/volume xanh; nếu chưa xác minh được giá curve, giữ trạng thái `incomplete` thay vì xuất giá giả.
- [ ] **Step 5 — Commit:** Stage adapter/test/fixture v2 và commit `feat: index pons v2 curve lifecycle`.

### Task 8: Pool V4 chính thức sau tốt nghiệp v2

**Files:** Tạo `be/src/launchpads/pons/v2/{poolKey,v4Swaps}.ts`, `be/src/launchpads/pons/v2/v4Swaps.test.ts`, fixture giao dịch tốt nghiệp/V4 được đối chiếu với explorer.

**Interfaces:** `derivePonsV4PoolId(launch: Launch, hook: Address): Hash`; `decodePonsV4Swap(log: RpcLog, poolId: Hash, launch: Launch): Trade | null`; `transitionOfficialVenue(launch: Launch, phase: 0 | 1 | 2 | 3): VenueTransition`.

- [ ] **Step 1 — Test đỏ:** Pool key sắp xếp currency theo địa chỉ, giữ đúng `tickSpacing`, fee và hook của launch; swap PoolManager khác `poolId` bị bỏ qua; phase 2 đóng curve venue và mở V4 venue một lần; phase 1/3 không tự tạo trade V4.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- v2/v4Swaps.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code/audit:** Xác minh PoolManager Robinhood và ít nhất một launch tốt nghiệp qua explorer + raw logs, ghi provenance; triển khai pool ID theo tài liệu pons và giải mã V4 swap theo đúng ABI Uniswap. Nếu chưa có bằng chứng, dừng nghiệm thu phần sau tốt nghiệp, không dùng pool ngẫu nhiên cùng token.
- [ ] **Step 4 — Chạy xanh:** Test V4, typecheck, fixture trade v2 từ curve → pool đối chiếu đúng tx/log và quote asset.
- [ ] **Step 5 — Commit:** Stage module V4/test/fixture và commit `feat: follow pons v2 official v4 pool`.

### Task 9: Volume, giá, candles và trạng thái bao phủ

**Files:** Tạo `be/src/market/{price,aggregate}.ts`, `be/src/market/aggregate.test.ts`, `be/src/indexer/reconcile.ts`, `be/src/indexer/reconcile.test.ts`.

**Interfaces:** `buildOfficialCandles(trades: readonly Trade[], intervalSeconds: number): Candle[]`; `sumOfficialQuoteVolume(trades: readonly Trade[], since: number): QuoteVolume`; `getCoverage(sourceIds: readonly string[]): Coverage`; `reconcileLaunchCounts(factory: FactorySource, indexedCount: number, independentCount: number): ReconciliationResult`.

- [ ] **Step 1 — Test đỏ:** V1 một pool trước/sau tốt nghiệp và v2 curve→V4 tạo cùng chuỗi nến theo thời gian; pool khác không được cộng; fee sweep và refund không tạo trade; hai quote asset khác nhau không cộng chung; thiếu range trả `complete=false`, metric thiếu là `null`, không phải 0.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- aggregate.test.ts reconcile.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Tính theo bigint/rational, lưu candles/projections có thể tái tính sau reorg; 24h volume lấy quote leg thực khớp. Đối chiếu số launch bằng scan độc lập/overlap hoặc on-chain total nếu có; giữ báo cáo range thiếu khi provider chặn.
- [ ] **Step 4 — Chạy xanh:** Test market/reconcile, integration test idempotency và typecheck xanh.
- [ ] **Step 5 — Commit:** Stage market/reconcile/test và commit `feat: derive official market metrics and coverage`.

### Task 10: Fastify API, SSE, OpenAPI và chạy local

**Files:** Tạo `be/src/api/{server,events}.ts`, `be/src/api/routes/{sources,launches,trades,candles,coverage}.ts`, `be/src/api/server.test.ts`, `be/src/cli/api.ts`, `be/openapi.json` sinh tự động, cập nhật `README.md`, `.github/workflows/ci.yml`.

**Interfaces:** `createApiServer(deps: ApiDeps): FastifyInstance`; `GET /v1/sources`, `GET /v1/launches`, `GET /v1/launches/:chainId/:tokenAddress`, `GET /v1/launches/:chainId/:tokenAddress/trades`, `GET /v1/launches/:chainId/:tokenAddress/candles`, `GET /v1/coverage`, `GET /v1/events` (SSE). List/trades dùng cursor ổn định `(blockNumber, txHash, logIndex)`; `limit` tối đa 100. `LaunchSummary = { chainId, tokenAddress, name, symbol, platform: 'pons', protocolVersion, quoteAsset: { address, symbol, decimals }, lifecycleStatus, officialVolume24h: string | null, coverageStatus }`; detail thêm `officialVenues` và `priceQuote: string | null`. Trade/candle có `venueId`, timestamp, giá/khối lượng theo quote asset dạng decimal strings. SSE chỉ gửi `launch.changed`, `trade.created`, `coverage.changed` với ID và key của tài nguyên.

- [ ] **Step 1 — Test đỏ:** Fastify `inject()` kiểm tra phân trang không trùng/bỏ sót, chain+address identity, trade/candle đúng official venue, thiếu coverage trả `null` + status, URL token sai trả 404, SSE phát launch/trade/status event và client có thể kết nối lại từ dữ liệu API. CORS chỉ chấp nhận FE origin đã cấu hình.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- api/server.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Route schema Fastify sinh OpenAPI; API chỉ query PostgreSQL; SSE gửi ID/event đủ để FE refetch, không đẩy raw log toàn bộ. Cấu hình CORS theo allowlist `FE_ORIGIN` cho browser SSE/API, không dùng wildcard khi có credentials. README ghi cách chạy PostgreSQL bằng Compose hoặc cài native, migration, `npm run dev:api -w be`, `npm run dev:indexer -w be`, cách xem coverage. CI bổ sung PostgreSQL service và integration tests, không cần RPC secret.
- [ ] **Step 4 — Chạy xanh:** `npm run lint -w be`, `npm run typecheck -w be`, `npm test -w be`, `npm run test:integration -w be`, `npm run build -w be`, `npm run openapi:check -w be` đều exit 0; smoke `GET /v1/coverage` trả trạng thái thật.
- [ ] **Step 5 — Commit:** Stage API/CLI/OpenAPI/README/CI và commit `feat: expose pons read-only API`.

## Backend exit gate

Chạy lại toàn bộ kiểm thử và một lần backfill thật từ start block của cả ba factory đến safe head. Ghi trong README số launch, block đã quét, block còn thiếu, đối chiếu độc lập, độ trễ live đo được và các giới hạn RPC. Nếu còn khoảng lịch sử chưa truy xuất hoặc chưa xác minh được V4 post-graduation, báo rõ BE chưa đạt tiêu chí “đầy đủ”; không chuyển lỗi đó thành dữ liệu 0 trên FE. Chỉ push commit đã kiểm chứng; không tự động deploy.
