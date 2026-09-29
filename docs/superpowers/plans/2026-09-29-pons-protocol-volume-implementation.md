# Pons Protocol Volume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tính buyback và swap đổi phí thực sự khớp của pons v2 vào volume/chart chính thức đúng một lần, đồng thời gắn nhãn hoạt động để FE không nhầm với lệnh của người dùng.

**Architecture:** Giữ `Trade` làm bản ghi của một lần khớp thực sự tại venue chính thức; thêm loại hoạt động độc lập với event nguồn. Adapter curve tạo một trade từ `BuybackLocked`; adapter V4 giữ swap do hook khởi tạo và phân loại theo chiều swap. Repository lưu loại hoạt động, còn market aggregation tiếp tục cộng mọi trade của venue chính thức mà không cộng event chuyển phí/khóa token.

**Tech Stack:** TypeScript, viem, PostgreSQL, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-pons-readonly-design.md` (bản sửa đổi buyback ngày 29/09/2026). Đọc toàn bộ trước khi thực hiện. Sau kế hoạch này, tiếp tục phần nối indexer/API của `docs/superpowers/plans/2026-09-28-pons-backend-implementation.md` rồi `docs/superpowers/plans/2026-09-28-pons-frontend-implementation.md`; những câu cũ trong kế hoạch backend nói loại buyback/swap nội bộ khỏi volume được thay bằng kế hoạch này.

## Global Constraints

- Chỉ Robinhood Chain ID `4663` và pons v2 trong phần sửa đổi này; không thêm giao dịch tiền thật hoặc ví.
- Tên file/thư mục, biến, hàm, kiểu, trường API, test và chú thích code bằng tiếng Anh; tài liệu cho người dùng bằng tiếng Việt.
- Giữ định danh `(chainId, tokenAddress)`; tiền và giá tính bằng `bigint`/decimal string, không dùng `number` để tính tiền.
- Volume chính thức chỉ lấy lượng quote thực khớp tại curve/V4 pool chính thức; không cộng refund, fee transfer, vault lock hoặc event sweep lần nữa.
- Buyback curve dùng `BuybackLocked`; V4 dùng `PoolManager.Swap` kể cả sender là hook. Mỗi raw log tạo tối đa một trade, chống trùng sau retry/reorg.
- WSS chỉ đánh thức quét; HTTP backfill và checkpoint PostgreSQL bảo đảm độ bao phủ. Không tuyên bố volume/chart lịch sử đầy đủ khi phần buyback chưa được backfill.
- TDD từng task: test đỏ, code tối thiểu, test xanh, commit riêng. Giữ nguyên các thay đổi không liên quan đang có trong worktree.

## Review Focus

1. `BuybackLocked` cùng transaction với `FeesSwept`/`Locked`: Task 2 kiểm tra chỉ `BuybackLocked` tạo một trade, quote volume bằng đúng `quoteSpent`.
2. `PoolManager.Swap` do hook khởi tạo: Task 3 kiểm tra được giữ lại và phân loại theo chiều, không bị loại khỏi volume.
3. Conversion và buyback cùng transaction: Task 3 kiểm tra hai swap khác `logIndex` là hai lần khớp thật, còn `PoolFeesSwept` không tạo trade thứ ba.
4. Quote token 6 decimals và reserve price: Task 2 kiểm tra lượng raw giữ nguyên, giá buyback lấy từ post-event reserves đã xác minh.
5. Retry/reorg và dữ liệu cũ: Task 1 kiểm tra migration giữ `user_trade` cho row cũ và cùng log không ghi hai lần; Task 3 kiểm tra hai `logIndex` hợp lệ không bị gộp. Kế hoạch backend tiếp nối chịu trách nhiệm quét bù/coverage trước khi công bố metric đầy đủ.

## Bản đồ file

- `be/src/domain/types.ts`: enum `TradeActivityKind` và trường `Trade.activityKind`.
- `be/src/db/{schema,repository}.ts`, `be/drizzle/0004_*.sql`: lưu loại hoạt động, mặc định tương thích dữ liệu cũ.
- `be/src/launchpads/pons/v1/adapter.ts`: gán `user_trade` cho swap V3 hiện có.
- `be/src/launchpads/pons/v2/{abi,adapter,v4Swaps}.ts`: giải mã buyback curve và giữ swap hook V4.
- `be/src/market/aggregate.test.ts`: khóa hành vi cộng volume/nến theo venue, không lọc `activityKind`.
- `be/tests/fixtures/`: bổ sung provenance và log buyback thật; test swap V4 nội bộ có thể dùng log được dựng từ ABI khi chưa tìm được giao dịch thật.

---

### Task 1: Loại hoạt động trong domain và database

**Files:** Sửa `be/src/domain/types.ts`, `be/src/db/schema.ts`, `be/src/db/repository.ts`, `be/src/db/repository.integration.test.ts`, các fixture `Trade` trong test và decoder V3/V2 hiện có; tạo migration Drizzle `be/drizzle/0004_*.sql` cùng metadata tương ứng.

**Interfaces:** `export type TradeActivityKind = 'user_trade' | 'protocol_buyback' | 'protocol_fee_conversion' | 'protocol_internal'`; `Trade.activityKind: TradeActivityKind`. Cột `trades.activity_kind` là `text NOT NULL DEFAULT 'user_trade'`; repository ghi giá trị từ `Trade`, không suy từ `sourceEvent`.

- [ ] **Step 1 — Test đỏ:** `repository.integration.test.ts` lưu trade `activityKind: 'protocol_buyback'` và `SELECT activity_kind` trả `protocol_buyback`; câu SQL insert trade bỏ qua cột mới vẫn trả mặc định `user_trade` (bảo đảm tương thích row cũ khi migration chạy); cùng raw log lưu hai lần vẫn chỉ một row.
- [ ] **Step 2 — Chạy đỏ:** `npm run test:integration -w be -- repository.integration.test.ts`; mong đợi FAIL vì chưa có cột/trường.
- [ ] **Step 3 — Code:** Thêm type và cột, tạo migration không xóa bảng, cập nhật `saveIndexBatch`; mọi decoder hiện có xuất `user_trade` để typecheck, giữ `sourceEvent` là tên event thật.
- [ ] **Step 4 — Chạy xanh:** `npm run db:migrate -w be` trên DB test, `npm run test:integration -w be -- repository.integration.test.ts`, `npm run typecheck -w be` và `npm test -w be`; tất cả exit 0.
- [ ] **Step 5 — Commit:** Chỉ stage file của Task 1; commit `feat: persist trade activity classification`.

### Task 2: Buyback trên bonding curve là một trade chính thức

**Files:** Sửa `be/src/launchpads/pons/v2/abi.ts`, `be/src/launchpads/pons/v2/adapter.ts`, `be/src/launchpads/pons/v2/adapter.test.ts`, `be/src/market/aggregate.test.ts`; thêm fixture log `BuybackLocked` có provenance trong `be/tests/fixtures/`.

**Interfaces:** `decodeCurveBuyback(log: RpcLog, launch: Launch, venue: Venue, timestamp: number, verifiedPostTradeReserves?: CurveReserves): Trade`; `decodeV2CurveBatch(...)` giữ chữ ký cũ và nhận thêm topic `BuybackLocked`. ABI chính thức là `event BuybackLocked(uint256 quoteSpent, uint256 tokensLocked)` (không indexed); `sourceEvent = 'BuybackLocked'`, `activityKind = 'protocol_buyback'`, `side = 'buy'`, `quoteAmountRaw = quoteSpent`, `tokenAmountRaw = tokensLocked`. [Mã curve Pons](https://github.com/ponsdotdev/pons-labs/blob/main/contractsV2/src/v2/PonsV2BondingCurve.sol).

- [ ] **Step 1 — Test đỏ:** Dùng log `BuybackLocked` từ fixture đã xác minh: decoder trả một buyback ở đúng curve, giữ raw quote/token và gắn giá post-event nếu có reserves; batch chứa `FeesSwept`, `BuybackLocked`, `Locked` chỉ trả một trade, volume cộng `quoteSpent` một lần. Lấy mẫu WOLVES tx `0xe27fe1e892b749d2ef81c5e7d715b2a6eeb6646b071ce8ef82f12d5741e9f5fb` trên Robinhood tại block `74955360`; đối chiếu `quoteSpent = 22028506` đơn vị raw USDG (6 decimals) với receipt và reserves. Event không có khớp không tạo trade.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- v2/adapter.test.ts aggregate.test.ts`; mong đợi FAIL tại case mới.
- [ ] **Step 3 — Code:** Thêm ABI/event selector chính xác; tái dùng kiểm tra venue và phép tính giá rational của curve. Không đổi `replayCurveBuyback` đã có; khi replay nến theo log, dùng reserves sau buyback chứ không dùng giá trước đó.
- [ ] **Step 4 — Chạy xanh:** Chạy lại hai test file, `npm run typecheck -w be`; đối chiếu `quoteSpent`, `tokensLocked` và post-event reserves với fixture/on-chain.
- [ ] **Step 5 — Commit:** Chỉ stage file của Task 2; commit `feat: count curve buybacks as official trades`.

### Task 3: Swap nội bộ Pons trong pool V4

**Files:** Sửa `be/src/launchpads/pons/v2/v4Swaps.ts`, `be/src/launchpads/pons/v2/v4Swaps.test.ts`, `be/src/market/aggregate.test.ts`; bổ sung fixture V4 hook-sender có provenance nếu RPC cung cấp.

**Interfaces:** Giữ `decodePonsV4Swap(...): Trade | null`; `null` chỉ cho sai pool/topic, không phải chỉ vì `sender === hook`. Với hook sender, chiều quote → token là `protocol_buyback`, token → quote là `protocol_fee_conversion`; nếu bằng chứng nguồn không đủ để gọi tên nguyên nhân, dùng `protocol_internal`. Hai đường gọi `_executeInternalSwap` trong [mã hook Pons](https://github.com/ponsdotdev/pons-labs/blob/main/contractsV2/src/v2/hooks/PonsV2MemeHook.sol) là `MemecoinToQuote` để đổi phí và `QuoteToMemecoin` để buyback.

- [ ] **Step 1 — Test đỏ:** Hook-sender V4 swap trả `Trade` với quote/token thực khớp và hoạt động đúng chiều; hai swap nội bộ cùng transaction nhưng khác `logIndex` đều có trong volume/nến; `PoolFeesSwept` không tạo thêm trade; pool ID khác vẫn bị loại. Test price và volume theo quote asset 6 decimals.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w be -- v2/v4Swaps.test.ts aggregate.test.ts`; mong đợi FAIL vì decoder đang trả `null` cho hook sender.
- [ ] **Step 3 — Code:** Bỏ điều kiện loại hook sender; gắn loại hoạt động sau khi giải mã chiều swap. Xác minh chỉ hai đường gọi `_executeInternalSwap` trong mã Pons v2 hiện hành là đổi phí và buyback; nếu phiên bản contract/địa chỉ triển khai chưa chứng minh được, gắn `protocol_internal` nhưng vẫn tính volume. Không tạo trade từ `PoolFeesSwept`.
- [ ] **Step 4 — Chạy xanh:** Chạy lại hai test file, `npm run typecheck -w be`; đối chiếu fixture V4 thật nếu có.
- [ ] **Step 5 — Commit:** Chỉ stage file của Task 3; commit `feat: include pons internal v4 swaps in pool volume`.

## Tiếp nối

Sau Task 3, quay lại kế hoạch backend hiện có để nối luồng indexer cho curve/V4, quét bù các khoảng lịch sử đã đi qua decoder cũ, kiểm chứng coverage, rồi hoàn thành Fastify API/SSE/OpenAPI; sau đó thực hiện kế hoạch frontend Next.js. Nếu database local đã được quét với decoder cũ, không giữ trạng thái `complete` cho chỉ số mới cho đến khi quét bù; không xóa/reset dữ liệu local của người dùng để đi tắt. Không gọi hệ thống hoàn chỉnh chỉ vì unit test xanh: exit gate là FE đọc được dữ liệu pons thật qua API với coverage đã kiểm chứng, chart/volume phản ánh buyback, CI xanh và các khoảng dữ liệu thiếu được hiển thị rõ.
