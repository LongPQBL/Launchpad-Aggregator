# Launchpad Aggregator

Ứng dụng tổng hợp launchpad đa chain đang được xây dựng theo từng adapter. Giai đoạn hiện tại chỉ đọc dữ liệu Pons trên Robinhood Chain (`4663`), có giao diện web tối để duyệt launch/chi tiết/chart/giao dịch; **chưa có kết nối ví hoặc giao dịch mua/bán**.

## Trạng thái hiện tại

- Backend có schema PostgreSQL, adapter Pons v1/v2, bộ quét theo block/checkpoint, API Fastify và SSE qua PostgreSQL `LISTEN/NOTIFY`.
- Tiến trình `dev:indexer` quét ba factory tạo token, pool V3 chính thức của v1, curve v2, các sự kiện chuyển pha v2 và từng pool V4 **do Pons tạo và đã xác thực**. API dựng nến từ trade chính thức theo trang thời gian; chart không sinh nến trong khoảng `Swept`, trả `complete: false` khi thiếu giá hoặc nguồn chưa quét đủ. Không khám phá hay hiển thị “Pools khác”. Backend đã nối nhưng **chưa backfill toàn chain**; `/v1/coverage` hiện vẫn `complete: false`, volume/price chưa đủ trả `null`.
- Một lần chạy local ngày 29/09/2026 với RPC Robinhood công khai đã quét v1 legacy đến block `8621659`, v1 active đến `9012165`, v2 đến `26862893`, trong khi safe head lúc chạy là `75341396`. Có 1 launch v1 legacy được ghi vào DB phát triển; chưa có bằng chứng quét đủ lịch sử hoặc đo độ trễ realtime. Số này chỉ là kết quả thử nghiệm, không phải số liệu tổng của Pons.
- Các lượt quét tiếp theo trên DB phát triển đã ghi được trade V3 và curve thật; riêng đoạn V2 curve đến block `27112894` có 69 trade. Trade `CurveBuy` tại tx `0x389193691a40fc306c3114b1d96070b43a189b7b3f1a056cbf16fb517484913b`, log 27 khớp fixture đã lưu. Một vòng 100.000 block qua nhiều nguồn V1 mất khoảng 3 phút trên RPC công khai, nên chưa thể suy diễn rằng backfill toàn chain sẽ nhanh với endpoint miễn phí.
- Buyback khớp lệnh trên curve hoặc V4 là giao dịch tính vào volume chính thức, nhưng gắn `activityKind` riêng; phí chuyển khoản, refund và khóa vault không tạo giao dịch/volume thứ hai. Xem [thiết kế Pons](docs/superpowers/specs/2026-09-28-pons-readonly-design.md).
- Audit có giới hạn ngày 29/09/2026 đã so sánh receipt RPC với fixture của token `0xc9e9ab90654f82893d7fd18b62f694992e8cef29`: launch `(27823666, 0xd7b79e93…45ab6, 30)`, curve buy `(27823668, 0x8147b8c0…cc28, 19)`, sweep `(27823772, 0xcdf59f4c…f3f, 52)`, `Initialize` `(27828161, 0x98dfda11…d6a3, 16)`, graduation `(27828161, cùng tx, 36)` và V4 swap `(27828165, 0x9f9e6779…0977, 108)`: cả 6 log khớp address/topic/data/block hash; swap có quote amount thô `5620497268881825819`, giá sau swap `0.000000152480063034` NVDA/token. Đây là đối chiếu **một token**, không chứng minh mọi launch đã được thu thập.
- Một vòng indexer có giới hạn 100 block/nguồn trên DB phát triển đưa cursor `pons-v2` đến `27134043` và `pons-v2-lifecycle` đến `26841946`; safe head quan sát `75532920`. Các nguồn v1/trade v2 cũng còn ở khoảng block 8–27 triệu, và chưa có gap được ghi cho vòng audit này. Khoảng cách cursor lớn nghĩa là vẫn thiếu lịch sử, dù bảng `source_gaps` đang trống. RPC công khai trả phase `2` của token mẫu tại block `75532920`, nhưng `eth_call` tại các block `27823666`, `27823772`, `27828161` đều lỗi “Missing or invalid parameters”; cần RPC hỗ trợ state lịch sử để xác minh giá curve/phase ở các mốc cũ.
- **Đo backfill có giới hạn ngày 29/09/2026 (RPC công khai, không dùng provider trả phí):** chạy `dev:indexer` liên tục ~2h20' với `INDEXER_MAX_BLOCKS_PER_CYCLE=50000`. Các nguồn chỉ quét log factory (`pons-v1-legacy`, `pons-v1-active`, `pons-v2`, `pons-v2-lifecycle`) đạt khoảng **125 block/giây** (~450.000 block/giờ) và không gặp lỗi decode; số launch trong DB tăng từ 52 lên **6136**, số trade từ 612 lên **24435**, phát hiện thêm 1 pool V4 mới tốt nghiệp thật. Với tốc độ này, quét hết khoảng cách tới safe head (~65 triệu block với v1, ~47 triệu block với v2) ước tính mất nhiều ngày liên tục cho riêng phần log — **chưa tính** các nguồn trade cần đọc thêm timestamp/receipt (chậm hơn nhiều, xem bên dưới), nên RPC công khai miễn phí xác nhận là **không đủ nhanh để backfill toàn chain trong một phiên**, dù vẫn dùng được để xác minh dữ liệu và chạy cục bộ.
- **Hai vấn đề khiến nguồn trade v1 kẹt vĩnh viễn ở RPC công khai (không tự phục hồi bằng cách chạy lại):**
  1. `pons-v2-curve` bị `429 Too Many Requests` từ `rpc.mainnet.chain.robinhood.com` khi quét đồng thời nhiều nguồn; `scanToHead` có retry/backoff cho lỗi tạm thời nhưng không đủ trong lần này, nguồn chuyển `degraded` và dừng hẳn tại đó thay vì tự thử lại ở chu kỳ sau.
  2. `pons-v1-active-trades` và `pons-v1-legacy-trades` dừng hẳn (không phải do RPC) vì gặp swap V3 **thật** có một vế đúng bằng 0 do làm tròn số nguyên với giao dịch rất nhỏ — ví dụ pool `0x7da3d775b803eeb44079f1a658b4dea116da1343`, tx [`0xba1e0cde96648343c22aea642b45fccbd4a8d3fdcea940fdc770ad5835b4348f`](https://robinhoodchain.blockscout.com/tx/0xba1e0cde96648343c22aea642b45fccbd4a8d3fdcea940fdc770ad5835b4348f), log 1, block `9265305`: `amount0=0`, `amount1=25654359`; và pool `0x835e4b15d72029866108393f1bbcb34d7bc04399`, tx [`0xc880f816f90fafe7acdc3ad91c5c30aa983c223735e56071b872a53f1683aa5f`](https://robinhoodchain.blockscout.com/tx/0xc880f816f90fafe7acdc3ad91c5c30aa983c223735e56071b872a53f1683aa5f), log 11, block `9265320`: `amount0=0`, `amount1=948761`. `decodeV1Swap` (`be/src/launchpads/pons/v1/adapter.ts`) coi bất kỳ vế nào bằng 0 là "Invalid V3 swap amounts" và từ chối decode; `scanToHead` (`be/src/indexer/scan.ts`) khi decode lỗi thì ghi `missingRanges` và **dừng hẳn tại đó**, không nhảy qua — đúng tinh thần "không âm thầm bỏ qua khoảng trống" của spec, nhưng nghĩa là nguồn đó sẽ không bao giờ tự tiến tiếp nếu không có can thiệp, vì swap kiểu này xuất hiện định kỳ trong lịch sử thật. Đây là quyết định sản phẩm cần người dùng chọn hướng xử lý, chưa tự sửa.
- **Đo song song hoá nguồn quét ngày 30/09/2026 (`be/src/cli/benchmarkParallel.ts`, `benchmarkParallelTrades.ts`, script tạm không dùng trong production):** chạy song song 3 nguồn chỉ quét log factory (`pons-v1-legacy`, `pons-v1-active`, `pons-v2`) trên RPC công khai **an toàn và có lợi** — 2 nguồn song song đạt 2.742 block/giây (so với ~1.975 tuần tự, +39%), 3 nguồn đạt 3.138 block/giây, không gap/lỗi. Ngược lại, chạy song song 2 nguồn trade (`pons-v1-legacy-trades`, `pons-v1-active-trades` — mỗi nguồn đã tự dùng `RPC_FETCH_CONCURRENCY=5` bên trong để tra timestamp/trader) gây **36 lỗi 429 trong 35 giây**, cả hai nguồn đều thất bại ngay từ đoạn đầu (ghi gap, cursor không tiến — không mất dữ liệu vì vòng quét sau sẽ tự thử lại đúng đoạn đó). Kết luận: chỉ song song hoá 3 nguồn log factory (đã áp dụng vào `runFactoryIndexer.ts` qua `runFactoryCycle(..., { parallel: true })`), giữ nguyên tuần tự cho toàn bộ nguồn trade/lifecycle/V4 vì mỗi nguồn đó đã tự bão hoà băng thông RPC.
- **Batching giảm round-trip ngày 30/09/2026:** gộp `eth_getBlock`(timestamp)+`eth_getTransactionByHash`(trader) thành một `eth_getBlock(..., includeTransactions: true)`; sau đó gộp tiếp nhiều block khác nhau thành 1 JSON-RPC batch HTTP call (mảng nhiều request trong 1 lần POST) thay vì gọi từng cái (`be/src/indexer/blockDataBatch.ts`, `batchSize = 100`) — đo trực tiếp qua curl: 100 request gộp ~0.4s so với 100 request riêng lẻ ~60s. Đo thêm: RPC này chấp nhận batch tới ~150 request/lần, 200 trở lên bị từ chối bằng 1 object lỗi duy nhất (không phải mảng lỗi theo từng item) — `batchSize = 100` chừa dư an toàn. Không dùng tính năng batch tự động của viem (`transport: http(url, { batch: ... })`) vì nó gộp lẫn cả các request không liên quan (log, đọc metadata) đang chạy đồng thời trong cùng tiến trình, gây lỗi khó retry đúng cách — xem `be/src/chains/robinhood.ts`. Riêng `eth_getLogs` có giới hạn khác hẳn: tối đa 1000 địa chỉ+topic trong 1 lần gọi (đo được: 1313 selector bị từ chối bằng lỗi tham số, không phải 429) — `MAX_ADDRESSES_PER_LOG_QUERY = 900` trong `be/src/indexer/tradeRuntime.ts` gộp nhóm địa chỉ pool theo giới hạn này, giảm số lần gọi `eth_getLogs` cần thiết cho nguồn có nhiều pool.
- **Nguồn trade vẫn kẹt cứng sau các sửa ngày 30/09/2026 — nguyên nhân chưa xác định đầy đủ:** cả 3 nguồn trade (`pons-v1-legacy-trades`, `pons-v1-active-trades`, `pons-v2-curve`) liên tục nhận `429 Too Many Requests` **không kèm thời gian reset** ngay tại bước `eth_getLogs` đầu tiên của mỗi chu kỳ, kể cả khi: chạy cô lập hoàn toàn (không có tiến trình nào khác chạm RPC), đã chờ đủ `65s × 6 lần thử` (tổng ~6.7 phút mỗi lần), và sau khi giảm số lượng `eth_getLogs` cần gọi bằng cách gộp địa chỉ pool thành nhóm lớn hơn (`MAX_ADDRESSES_PER_LOG_QUERY = 900`, xem `be/src/indexer/tradeRuntime.ts`). Đáng chú ý: cùng một request y hệt (cùng địa chỉ, cùng khoảng block, dùng đúng hàm sản xuất thật) chạy **cô lập trong một script tối giản** thì **thành công** (1075ms), nhưng chạy qua `npm run dev:indexer` với các bước chuẩn bị đầu chu kỳ (kiểm tra reorg, ghi block đã quan sát) thì **vẫn thất bại**. Giả thuyết chưa kiểm chứng: RPC công khai này có thể áp dụng giới hạn theo cửa sổ dài hơn (theo giờ/ngày) cho toàn bộ IP/phiên, đã bị tiêu hao đáng kể bởi khối lượng lớn request thử nghiệm trong ngày 30/09/2026 (nhiều lần benchmark quét hàng triệu block, hàng trăm lệnh gọi `curl` thủ công) — nếu đúng, chỉ có thể chờ cửa sổ dài hơn tự làm mới, không phải lỗi có thể sửa bằng code. Cần theo dõi thêm sau khi ngừng phát sinh traffic thử nghiệm.

**Đo tối ưu truy vấn pool theo block ngày 30/09/2026 (RPC chỉ đọc, chưa restart indexer):** tại khoảng `9.731.762–9.733.761` của `pons-v1-active-trades`, DB hiện có 83.680 pool V1-active nhưng chỉ 236 pool đã tồn tại trong khoảng này. Cùng endpoint, topic Swap và khoảng 2.000 block: truy vấn mọi pool cần 20 request song song, 9,790 ms; lọc đúng 236 pool cần 1 request, 2,229 ms. Cả hai trả đúng 326 log, HTTP 200, không lỗi. Đây là một mẫu RPC, chưa chứng minh tốc độ toàn bộ backfill; indexer đang chạy phải được restart có kiểm soát để nạp code mới.

**Baseline ETA trước khi áp dụng bộ lọc:** tiến trình với ngân sách 50.000 block/nguồn/vòng hoàn thành vòng đầu trong khoảng 16 phút; hai vòng đầu đưa `pons-v1-active-trades` tiến 100.000 block trong khoảng 41 phút. Safe head quan sát là `76.207.222`, cursor trade active `9.731.761`, còn khoảng 66,5 triệu block. Nội suy tốc độ hiện tại cho riêng nút thắt này cho ra cỡ **2–3 tuần** để bắt kịp *nếu tốc độ không đổi*. Đây là ước lượng độ tin cậy thấp: còn pool V4 mới được phát hiện, số pool cần hỏi tăng ở các block mới, và RPC có thể rate-limit. Sẽ đo lại ETA bằng tốc độ thực sau từng tối ưu; không dùng con số này như cam kết hoàn tất.

## Chạy local

Cần Node.js 24, npm và PostgreSQL 16+; Docker Compose là tùy chọn cho PostgreSQL.

```sh
docker compose up -d postgres
npm ci
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run db:migrate -w be
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad FE_ORIGIN=http://localhost:3000 npm run dev:api -w be
```

Ở terminal khác, chạy indexer launch, lifecycle và trade chính thức:

```sh
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run dev:indexer -w be
```

`RH_HTTP_RPC_URL` mặc định là RPC công khai của Robinhood. `INDEXER_MAX_BLOCKS_PER_CYCLE` mặc định `10000`; đặt `INDEXER_ONCE=true` để chạy một vòng rồi thoát. `INDEXER_SOURCE_IDS=pons-v2,pons-v2-lifecycle,pons-v2-curve,pons-v2-v4` chọn riêng các nguồn V2 khi cần kiểm tra/vận hành; `pons-v2-v4` tự tạo checkpoint riêng cho từng pool đã xác thực. Để lifecycle tìm thấy token mới, cần bật cả nguồn launch `pons-v2`. Indexer không cần private key và không gửi giao dịch. RPC công khai có thể giới hạn lịch sử/range; khi lỗi, checkpoint không nhảy qua khoảng trống và khoảng thiếu cùng lý do được lưu để API báo ra.

Khi dùng RPC riêng có giới hạn `eth_getLogs` là 2.000 block, đặt `RH_HTTP_RPC_URL` trong môi trường riêng và `INDEXER_SHARED_RPC_LOG_RANGE=2000`. Giới hạn này áp dụng cho factory, lifecycle và V4 dùng RPC chung; `INDEXER_MAX_BLOCKS_PER_CYCLE` vẫn là ngân sách quét của một nguồn trong mỗi vòng. Không lưu URL chứa khóa API vào file được commit. Lỗi RPC được che URL trước khi ghi vào log/khoảng thiếu công khai.

Với volume PostgreSQL cũ từng chỉ chứa `launchpad_test`, hãy **tạo thêm** DB phát triển `launchpad` trước khi migrate. Không chạy indexer trên `launchpad_test`: test tích hợp sẽ `TRUNCATE` các bảng của DB đó. Volume mới do Compose tạo sẽ có cả `launchpad` và `launchpad_test`.

### Bộ lập lịch song song (job-queue) và rollback

Mặc định `dev:indexer` vẫn chạy vòng lặp tuần tự cũ (`runOnce()`). Đặt `INDEXER_SCHEDULER=jobs` để chuyển sang bộ lập lịch job-queue song song có giới hạn (`be/src/indexer/jobScheduler.ts`, thiết kế ở [đặc tả indexer song song](docs/superpowers/specs/2026-09-30-parallel-indexer-design.md)): backfill các nguồn factory/trade/lifecycle/V4 chạy song song có giới hạn theo từng RPC endpoint, cộng thêm 1 luồng "gần đầu chuỗi" tạm thời (provisional) để launch mới hiện sớm mà không đợi backfill lịch sử xong.

**Trước lần đầu chuyển một DB đã có cursor tuần tự sang `INDEXER_SCHEDULER=jobs`:**

```sh
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run db:seed-certified-coverage -w be
```

Lệnh này chuyển cursor `sources.scanned_to_block`/`confirmed_to_block` hiện có thành các khoảng `scan_jobs` đã chứng nhận (`lane = certified`), lùi frontier về trước bất kỳ `source_gaps` chưa giải quyết nào (không âm thầm coi khoảng trống là đã quét). Idempotent — chạy lại không tạo trùng lặp (`onConflictDoNothing`).

**Rollback:** bỏ biến `INDEXER_SCHEDULER` (hoặc đặt giá trị khác `jobs`) rồi khởi động lại tiến trình — vòng lặp tuần tự cũ hoạt động lại ngay, đọc cùng cursor `sources`. Không cần reset DB; `scan_jobs` chỉ được job-queue scheduler dùng, vòng lặp tuần tự bỏ qua bảng đó hoàn toàn.

**Trước khi chuyển tiến trình đang chạy thật sang scheduler mới:** chạy đủ bộ kiểm thử ở mục Kiểm thử bên dưới, dừng tiến trình indexer cũ, chạy `db:seed-certified-coverage`, khởi động lại với `INDEXER_SCHEDULER=jobs`, rồi đối chiếu cursor, số khoảng `scan_jobs` lỗi/rỗng, số launch/trade, tỷ lệ lỗi 429 và độ trễ giữa bản chạy cũ và mới trên cùng một khoảng thời gian quan sát trước khi coi là ổn định. Không chạy đồng thời hai tiến trình ghi cùng một DB.

**Xem tốc độ/ETA:** `DATABASE_URL=... npm run indexer:status -w be` in tốc độ quan sát được (block/giây) và ETA còn lại cho từng nguồn cùng cho cả pipeline, dựa trên các job `scan_jobs` đã hoàn tất gần đây (mặc định 30 phút gần nhất, chỉnh bằng `INDEXER_STATUS_LOOKBACK_MINUTES`). Lệnh chỉ đọc DB, không cần RPC, không bao giờ in URL/khóa. Nếu một nguồn chưa có job hoàn tất nào trong cửa sổ quan sát, hoặc còn pool V4 chưa được phát hiện hết (lifecycle chưa quét kịp safe head), hoặc gặp 429 lặp lại, lệnh báo `unreliable` kèm lý do thay vì đưa ETA giả chính xác — xem `be/src/indexer/backfillEstimate.ts`.

**Baseline (tuần tự) so với candidate (job-queue), đo ngày 30/09/2026:** không có một cửa sổ đo hoàn toàn cùng điều kiện cho cả hai (baseline chạy nhiều giờ trước khi candidate được bật), nên đây là quan sát thực tế đã ghi lại, không phải benchmark kiểm soát chặt:
- Baseline (vòng lặp tuần tự, RPC Validation Cloud, trước khi cutover): pipeline ổn định nhiều giờ liên tục, nhưng `pons-v1-active-trades` gần như đứng yên ở cursor `10.111.761` (không tự vượt qua được, xem lỗi bên dưới).
- Lần cutover đầu tiên sang job-queue: tiến trình crash sau ~3,5 phút (lỗi Postgres tạm thời không được bắt), và `pons-v1-active-trades` lỗi lặp lại xác định trên mọi cửa sổ ("bind message has N parameter formats but 0 parameters" — vượt giới hạn cứng 65.535 tham số bind của PostgreSQL cho một câu INSERT nhiều dòng). Đã rollback ngay, không mất dữ liệu.
- Sau khi vá cả hai lỗi (tự phục hồi sau crash + chia nhỏ insert theo `be/src/db/chunk.ts`) và cutover lại: `pons-v1-active-trades` vượt qua điểm kẹt cũ, quan sát ~4 phút đầu đạt 43/43 job hoàn tất, 0 lỗi; cửa sổ ~20 phút sau đó đạt 178/178 job hoàn tất, 0 lỗi, với 14 lần tự phục hồi sau lỗi tạm thời (cùng loại lỗi shared-memory ban đầu, không còn làm crash tiến trình).
- Tốc độ quan sát trực tiếp qua `indexer:status` ngay sau cutover (cửa sổ 30 phút, nhiều nguồn còn `no reliable sample` vì chưa tới lượt trong cửa sổ đó): `pons-v1-active` 263,4 block/s, `pons-v1-legacy-trades` 304,6 block/s, `pons-v1-active-trades` 91,3 block/s, `pons-v2-curve` 362,7 block/s. Đây là tốc độ tại một thời điểm, không phải cam kết ổn định; đo lại bằng `indexer:status` sau khi chạy đủ lâu để có mẫu đáng tin cho mọi nguồn.

Kiểm tra API:

```sh
curl http://127.0.0.1:3001/v1/coverage
curl http://127.0.0.1:3001/v1/sources
curl 'http://127.0.0.1:3001/v1/launches?chainId=4663'
```

OpenAPI ở `/openapi.json`; bản snapshot là `be/openapi.json`. SSE ở `/v1/events`, chỉ báo loại sự kiện và ID token để frontend gọi lại API. CORS chỉ cho phép `FE_ORIGIN`.

## Chạy FE

Cần backend API (`dev:api`) đang chạy trước. Sao chép biến môi trường rồi khởi động FE ở terminal riêng:

```sh
cp fe/.env.example fe/.env.local
npm run dev -w fe
```

Mở `http://localhost:3000`. `BE_API_URL` (đọc phía server, cho các trang Next.js render dữ liệu launch) và `NEXT_PUBLIC_BE_API_URL` (đọc phía trình duyệt, cho kết nối SSE realtime ở `fe/src/hooks/use-live-refresh.ts`) trong `fe/.env.local` phải trỏ cùng một instance API. Khi API tắt hoặc mất kết nối SSE, giao diện hiện lỗi có nút thử lại hoặc chuyển sang polling định kỳ, không hiện trang trắng.

**Giới hạn coverage hiện tại:** vì backend chưa backfill toàn chain (xem phần Trạng thái hiện tại), FE sẽ hiện huy hiệu “Đang đồng bộ” cho hầu hết launch và “Chưa có dữ liệu” cho volume/giá còn thiếu, thay vì số 0 hay dữ liệu giả. Đây là hành vi đúng theo thiết kế, không phải lỗi.

## Kiểm thử

```sh
npm run lint -w be
npm run typecheck -w be
npm test -w be
TEST_DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test npm run test:integration -w be
npm run build -w be
npm run openapi:check -w be
```

Các test tích hợp chỉ được phép dùng DB có tên kết thúc bằng `_test`. CI tự khởi tạo PostgreSQL riêng, không cần RPC thật.

FE có bộ test riêng, không cần backend hay PostgreSQL thật đang chạy (test dùng schema/kiểu sinh sẵn và mock fetch):

```sh
npm run lint -w fe
npm run typecheck -w fe
npm test -w fe
npm run check:schema -w fe
npm run build -w fe
npm run e2e:install -w fe   # tải trình duyệt Chromium cho Playwright, chỉ cần chạy một lần
npm run test:e2e -w fe
```

`npm run test:e2e -w fe` tự khởi động một BE giả (`fe/e2e/mock-api.ts`, dữ liệu cố định, không gọi RPC/PostgreSQL thật) và `next dev` trước khi chạy, nên chạy được trên máy sạch hoặc CI mà không cần backend thật. Test chạy trên cả viewport desktop và mobile, xác nhận luồng danh sách → chi tiết, huy hiệu coverage thiếu hiển thị trung thực, và không có nút ví/giao dịch nào trên giao diện.

## Bước còn lại trước khi coi backend đạt yêu cầu

Kiểm chứng giá curve lịch sử bằng RPC lưu state cũ, đối chiếu số launch với nguồn độc lập, chạy backfill cả ba factory và mọi nguồn trade/lifecycle đến safe head, rồi đo độ trễ khi head mới xuất hiện. Chỉ khi đối chiếu phase và coverage qua cửa sổ yêu cầu thành công mới kết luận volume/chart đầy đủ. Ví và mua/bán thật là giai đoạn sau, chưa nằm trong lát cắt chỉ đọc này. Kế hoạch Pons V2 ở [lifecycle plan](docs/superpowers/plans/2026-09-29-pons-v2-lifecycle.md).
