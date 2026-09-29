# Launchpad Aggregator

Ứng dụng tổng hợp launchpad đa chain đang được xây dựng theo từng adapter. Giai đoạn hiện tại chỉ đọc dữ liệu Pons trên Robinhood Chain (`4663`); **chưa có giao diện, kết nối ví hoặc giao dịch mua/bán**.

## Trạng thái hiện tại

- Backend có schema PostgreSQL, adapter Pons v1/v2, bộ quét factory theo block/checkpoint, API Fastify và SSE qua PostgreSQL `LISTEN/NOTIFY`.
- Tiến trình `dev:indexer` **hiện chỉ quét ba factory tạo token**. Nguồn trade V3/curve/V4, chuyển pha tốt nghiệp, nến lịch sử và backfill toàn bộ chain chưa được nối vào daemon. Vì vậy `/v1/coverage` phải trả `complete: false`; volume/price thiếu trả `null`, không phải 0.
- Một lần chạy local ngày 29/09/2026 với RPC Robinhood công khai đã quét v1 legacy đến block `8621659`, v1 active đến `9012165`, v2 đến `26862893`, trong khi safe head lúc chạy là `75341396`. Có 1 launch v1 legacy được ghi vào DB phát triển; chưa có bằng chứng quét đủ lịch sử hoặc đo độ trễ realtime. Số này chỉ là kết quả thử nghiệm, không phải số liệu tổng của Pons.
- Buyback khớp lệnh trên curve hoặc V4 là giao dịch tính vào volume chính thức, nhưng gắn `activityKind` riêng; phí chuyển khoản, refund và khóa vault không tạo giao dịch/volume thứ hai. Xem [thiết kế Pons](docs/superpowers/specs/2026-09-28-pons-readonly-design.md).

## Chạy local

Cần Node.js 24, npm và PostgreSQL 16+; Docker Compose là tùy chọn cho PostgreSQL.

```sh
docker compose up -d postgres
npm ci
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run db:migrate -w be
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad FE_ORIGIN=http://localhost:3000 npm run dev:api -w be
```

Ở terminal khác, chạy indexer factory:

```sh
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run dev:indexer -w be
```

`RH_HTTP_RPC_URL` mặc định là RPC công khai của Robinhood. `INDEXER_MAX_BLOCKS_PER_CYCLE` mặc định `10000`; đặt `INDEXER_ONCE=true` để chạy một vòng rồi thoát. Indexer không cần private key và không gửi giao dịch. RPC công khai có thể giới hạn lịch sử/range; khi lỗi, checkpoint không nhảy qua khoảng trống.

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

Nối quét trade chính thức V3/curve/V4 và sự kiện tốt nghiệp, kiểm chứng giá curve lịch sử, lưu lý do các khoảng thiếu, đối chiếu số launch với nguồn độc lập, chạy backfill đến safe head và đo độ trễ khi head mới xuất hiện. Sau đó mới kết luận coverage/volume/chart đầy đủ và xây FE trên API này. Kế hoạch chi tiết ở [backend plan](docs/superpowers/plans/2026-09-28-pons-backend-implementation.md).
