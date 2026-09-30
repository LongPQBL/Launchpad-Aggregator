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

Với volume PostgreSQL cũ từng chỉ chứa `launchpad_test`, hãy **tạo thêm** DB phát triển `launchpad` trước khi migrate. Không chạy indexer trên `launchpad_test`: test tích hợp sẽ `TRUNCATE` các bảng của DB đó. Volume mới do Compose tạo sẽ có cả `launchpad` và `launchpad_test`.

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
