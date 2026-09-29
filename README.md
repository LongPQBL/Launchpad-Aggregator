# Launchpad Aggregator

Ứng dụng tổng hợp launchpad đa chain đang được xây dựng theo từng adapter. Giai đoạn hiện tại chỉ đọc dữ liệu Pons trên Robinhood Chain (`4663`); **chưa có giao diện, kết nối ví hoặc giao dịch mua/bán**.

## Trạng thái hiện tại

- Backend có schema PostgreSQL, adapter Pons v1/v2, bộ quét theo block/checkpoint, API Fastify và SSE qua PostgreSQL `LISTEN/NOTIFY`.
- Tiến trình `dev:indexer` quét ba factory tạo token, pool V3 chính thức của v1, curve v2, các sự kiện chuyển pha v2 và từng pool V4 **do Pons tạo và đã xác thực**. API dựng nến từ trade chính thức theo trang thời gian; chart không sinh nến trong khoảng `Swept`, trả `complete: false` khi thiếu giá hoặc nguồn chưa quét đủ. Không khám phá hay hiển thị “Pools khác”. Backend đã nối nhưng **chưa backfill toàn chain**; `/v1/coverage` hiện vẫn `complete: false`, volume/price chưa đủ trả `null`.
- Một lần chạy local ngày 29/09/2026 với RPC Robinhood công khai đã quét v1 legacy đến block `8621659`, v1 active đến `9012165`, v2 đến `26862893`, trong khi safe head lúc chạy là `75341396`. Có 1 launch v1 legacy được ghi vào DB phát triển; chưa có bằng chứng quét đủ lịch sử hoặc đo độ trễ realtime. Số này chỉ là kết quả thử nghiệm, không phải số liệu tổng của Pons.
- Các lượt quét tiếp theo trên DB phát triển đã ghi được trade V3 và curve thật; riêng đoạn V2 curve đến block `27112894` có 69 trade. Trade `CurveBuy` tại tx `0x389193691a40fc306c3114b1d96070b43a189b7b3f1a056cbf16fb517484913b`, log 27 khớp fixture đã lưu. Một vòng 100.000 block qua nhiều nguồn V1 mất khoảng 3 phút trên RPC công khai, nên chưa thể suy diễn rằng backfill toàn chain sẽ nhanh với endpoint miễn phí.
- Buyback khớp lệnh trên curve hoặc V4 là giao dịch tính vào volume chính thức, nhưng gắn `activityKind` riêng; phí chuyển khoản, refund và khóa vault không tạo giao dịch/volume thứ hai. Xem [thiết kế Pons](docs/superpowers/specs/2026-09-28-pons-readonly-design.md).
- Audit có giới hạn ngày 29/09/2026 đã so sánh receipt RPC với fixture của token `0xc9e9ab90654f82893d7fd18b62f694992e8cef29`: launch `(27823666, 0xd7b79e93…45ab6, 30)`, curve buy `(27823668, 0x8147b8c0…cc28, 19)`, sweep `(27823772, 0xcdf59f4c…f3f, 52)`, `Initialize` `(27828161, 0x98dfda11…d6a3, 16)`, graduation `(27828161, cùng tx, 36)` và V4 swap `(27828165, 0x9f9e6779…0977, 108)`: cả 6 log khớp address/topic/data/block hash; swap có quote amount thô `5620497268881825819`, giá sau swap `0.000000152480063034` NVDA/token. Đây là đối chiếu **một token**, không chứng minh mọi launch đã được thu thập.
- Một vòng indexer có giới hạn 100 block/nguồn trên DB phát triển đưa cursor `pons-v2` đến `27134043` và `pons-v2-lifecycle` đến `26841946`; safe head quan sát `75532920`. Các nguồn v1/trade v2 cũng còn ở khoảng block 8–27 triệu, và chưa có gap được ghi cho vòng audit này. Khoảng cách cursor lớn nghĩa là vẫn thiếu lịch sử, dù bảng `source_gaps` đang trống. RPC công khai trả phase `2` của token mẫu tại block `75532920`, nhưng `eth_call` tại các block `27823666`, `27823772`, `27828161` đều lỗi “Missing or invalid parameters”; cần RPC hỗ trợ state lịch sử để xác minh giá curve/phase ở các mốc cũ.

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

## Bước còn lại trước khi coi backend đạt yêu cầu

Kiểm chứng giá curve lịch sử bằng RPC lưu state cũ, đối chiếu số launch với nguồn độc lập, chạy backfill cả ba factory và mọi nguồn trade/lifecycle đến safe head, rồi đo độ trễ khi head mới xuất hiện. Chỉ khi đối chiếu phase và coverage qua cửa sổ yêu cầu thành công mới kết luận volume/chart đầy đủ. FE, ví và mua/bán thật là giai đoạn sau, chưa nằm trong backend chỉ đọc này. Kế hoạch Pons V2 ở [lifecycle plan](docs/superpowers/plans/2026-09-29-pons-v2-lifecycle.md).
