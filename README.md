# Launchpad Aggregator

Ứng dụng tổng hợp launchpad đa chain đang được xây dựng theo từng adapter. Sản phẩm sẽ có mục Pools gồm cả các pool khác ngoài venue do launchpad chỉ định, với dữ liệu swap và giá USD được index qua Envio. Phần Pools đó chưa triển khai trong giao diện/API hiện tại.

## Trạng thái hiện tại

- Backend có schema PostgreSQL, adapter Pons v1/v2, API Fastify và SSE qua PostgreSQL `LISTEN/NOTIFY`.
- Việc index Pons (launch, lifecycle, trade chính thức, pool V4 đã xác thực) chạy qua **Envio** (xem phần “Envio HyperIndex” bên dưới) — đây là đường ghi dữ liệu thật duy nhất hiện tại. API đọc nến đã lưu sau khi backfill nến hoàn tất; trước đó vẫn dựng nến từ trade. Chart không sinh nến trong khoảng `Swept`, trả `complete: false` khi thiếu giá, nến đang tính lại hoặc nguồn chưa quét đủ.
- **Đã gỡ bỏ (2026-10-04):** bộ indexer cũ quét trực tiếp qua RPC (`dev:indexer`/`runFactoryIndexer.ts`, bộ lập lịch job-queue song song, `scan_jobs`, và các công cụ benchmark/seed/trạng thái đi kèm). Toàn bộ các ghi chú đo đạc/benchmark của bộ indexer đó (tốc độ quét, giới hạn RPC công khai, song song hoá...) cũng đã gỡ cùng, vì không còn áp dụng — Envio đảm nhiệm toàn bộ việc này theo cách khác.
- Buyback khớp lệnh trên curve hoặc V4 là giao dịch tính vào volume chính thức, nhưng gắn `activityKind` riêng; phí chuyển khoản, refund và khóa vault không tạo giao dịch/volume thứ hai. Xem [thiết kế Pons](docs/superpowers/specs/2026-09-28-pons-readonly-design.md).
- Audit có giới hạn ngày 29/09/2026 đã so sánh receipt RPC với fixture của token `0xc9e9ab90654f82893d7fd18b62f694992e8cef29`: launch `(27823666, 0xd7b79e93…45ab6, 30)`, curve buy `(27823668, 0x8147b8c0…cc28, 19)`, sweep `(27823772, 0xcdf59f4c…f3f, 52)`, `Initialize` `(27828161, 0x98dfda11…d6a3, 16)`, graduation `(27828161, cùng tx, 36)` và V4 swap `(27828165, 0x9f9e6779…0977, 108)`: cả 6 log khớp address/topic/data/block hash; swap có quote amount thô `5620497268881825819`, giá sau swap `0.000000152480063034` NVDA/token. Đây là đối chiếu **một token**, không chứng minh mọi launch đã được thu thập.

## Chạy local

Cần Node.js 24, npm và PostgreSQL 16+; Docker Compose là tùy chọn cho PostgreSQL.

### Biến môi trường (.env)

Mỗi phần (`be/`, `fe/`, `envio/`) có file biến môi trường riêng, theo đúng quy ước của từng công cụ — không gộp chung 1 file ở thư mục gốc được (Next.js chỉ tự đọc `.env.local` trong chính `fe/`, Docker Compose chỉ tự đọc `.env` trong chính `envio/`):

| File | Công cụ đọc | Sao chép từ |
|---|---|---|
| `be/.env` | Node (`--env-file-if-exists`, cờ gốc của Node ≥20.6, không cần thư viện ngoài) | `be/.env.example` |
| `fe/.env.local` | Next.js (tự động) | `fe/.env.example` |
| `envio/.env` | Docker Compose (tự động) | `envio/.env.example` |

Sao chép cả 3 file `.example` thành file thật (`.env`/`.env.local`) rồi điền giá trị trước khi chạy local. Cả 3 đều nằm trong `.gitignore`, không commit.

Các lệnh `npm run ... -w be` bên dưới vẫn ghi rõ biến môi trường ở đầu dòng để tài liệu hoá chính xác lệnh đó cần gì — nhưng nếu `be/.env` đã có sẵn `DATABASE_URL`/`FE_ORIGIN`, phần ghi đè ở đầu dòng là tùy chọn, không bắt buộc nữa.

```sh
docker compose up -d postgres
npm ci
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run db:migrate -w be
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad npm run seed:known-quote-feeds -w be
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad FE_ORIGIN=http://localhost:3000 VOLUME_CURSOR_SECRET=<openssl rand -hex 32> npm run dev:api -w be
```

`VOLUME_CURSOR_SECRET` là bắt buộc (API không khởi động nếu thiếu, `be/src/api/config.ts`) — sinh một chuỗi bí mật bất kỳ bằng `openssl rand -hex 32`, không dùng lại giá trị ví dụ trong `be/.env.example` ở môi trường thật. `seed:known-quote-feeds` chỉ cần chạy một lần (idempotent) để phần tính giá USD (TVL/FDV/volume24hUsd) hoạt động ngay với 4 quote asset đã biết sẵn, trước khi vòng lặp nền (`sync:envio-staging:loop`) tự resolve thêm các quote asset mới.

Ở terminal khác, chạy Envio để index Pons (xem phần "Envio HyperIndex" bên dưới — đây là đường index thật hiện tại, không còn `dev:indexer`/RPC-scan).

Với volume PostgreSQL cũ từng chỉ chứa `launchpad_test`, hãy **tạo thêm** DB phát triển `launchpad` trước khi migrate. Volume mới do Compose tạo sẽ có cả `launchpad` và `launchpad_test`.

Kiểm tra API:

```sh
curl http://127.0.0.1:3001/v1/coverage
curl http://127.0.0.1:3001/v1/sources
curl 'http://127.0.0.1:3001/v1/launches?chainId=4663'
```

OpenAPI ở `/openapi.json`; bản snapshot là `be/openapi.json`. SSE ở `/v1/events`, chỉ báo loại sự kiện và ID token để frontend gọi lại API. CORS chỉ cho phép `FE_ORIGIN`.

### Envio HyperIndex — thử nghiệm Phase 1 + Phase 2 + Phase 3 (Pons V1-legacy, V2 launch/curve/lifecycle, V4 pool verification/swap)

Xem `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md`,
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase1.md`,
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase2.md` và
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase3.md`. Để thử nghiệm thủ công
sau khi các task của cả ba plan hoàn tất:

```sh
cd envio && docker compose up -d
# đợi indexer bắt kịp head hoặc ít nhất qua khỏi các block đã dùng làm fixture
cd .. && DATABASE_URL=... ENVIO_DATABASE_URL=postgres://postgres:testing@127.0.0.1:5433/envio-dev npm run -w be sync:envio-staging
DATABASE_URL=... npm run -w be compare:envio-staging
```

`sync:envio-staging` phải chạy trước — nó đọc bảng raw của Envio và ghi vào các bảng `*_envio_staging`; nếu bỏ qua bước này, `compare:envio-staging` sẽ báo mọi launch/trade thật là "chỉ có ở real" (bảng staging vẫn trống). `sync:envio-staging`/`compare:envio-staging` giờ đồng bộ và đối chiếu cả V1-legacy lẫn V2 (launch, curve trade, lifecycle transition) trong cùng một lần chạy.

`sync:envio-staging`/`compare:envio-staging` giờ đồng bộ và đối chiếu cả V1-legacy, V2, lẫn V4
(mở venue V4 đã xác thực + swap chính thức) trong cùng một lần chạy — xem
`docs/superpowers/plans/2026-09-30-envio-indexer-migration-phase3.md`.

Đây là bước đối chiếu thủ công cho phạm vi Phase 1-3 (V1-legacy, V2, V4). Đối chiếu tự động, đầy đủ,
chạy song song với indexer thật đang sống — theo mục 6 của spec — thuộc một plan kế tiếp riêng.

**Chạy nền liên tục (để staging luôn bắt kịp dữ liệu, so sánh thủ công khi cần):**

```sh
cd envio && docker compose up -d
cd .. && DATABASE_URL=... ENVIO_DATABASE_URL=postgres://postgres:testing@127.0.0.1:5433/envio-dev \
  npm run -w be sync:envio-staging:loop
```

Lặp lại cả 3 bước sync (V1-legacy, V2, V4) mỗi 15 phút (chỉnh qua `ENVIO_SYNC_LOOP_INTERVAL_MS`,
đơn vị mili-giây). Một chu kỳ lỗi (mất kết nối DB, Envio chưa quét kịp…) chỉ bị log lại, không làm
dừng tiến trình — tự thử lại ở chu kỳ sau. Dừng bằng `Ctrl+C` hoặc gửi `SIGTERM` (tiến trình dừng sau
khi chu kỳ hiện tại xong, trong vòng ~1 giây nếu đang chờ giữa hai chu kỳ). Kiểm tra tiến trình đang
chạy bằng `ps aux | grep syncEnvioStagingLoop`. Việc so sánh (`compare:envio-staging`) vẫn chạy thủ
công, riêng, khi nào bạn muốn xem khác biệt.

**Cutover (ghi thẳng vào bảng thật thay vì staging):** đặt `ENVIO_SYNC_TARGET=real` cho cả
`sync:envio-staging`/`sync:envio-staging:loop` — chỉ làm việc này theo đúng quy trình ở
`docs/superpowers/specs/2026-10-01-envio-cutover-design.md` (mục 6), không bật tùy tiện vì nó thay
thế vai trò ghi dữ liệu thật của indexer RPC-scan.

Sau migration `0020`, chế độ `ENVIO_SYNC_TARGET=real` còn tự đọc lại metadata Pons bị thiếu:
`logo`, `description`, `socials` (website/Twitter) và timestamp của block tạo token. Vòng sync
liên tục chạy tác vụ này mỗi phút, độc lập với chu kỳ đồng bộ Envio; lệnh sync một lần chạy một lượt
sau khi đồng bộ. Mặc định xử lý tối đa 10 launch/phút trên toàn DB, ưu tiên cả launch mới lẫn cũ.
Có thể chỉnh giới hạn từ 1 đến 100 qua `ENVIO_METADATA_BATCH_LIMIT`. Timeout/rate limit sẽ được
thử lại theo lịch; contract không hỗ trợ hàm thì giữ giá trị `null`. Chỉ bật bản code mới sau khi
áp dụng migration bằng `npm run -w be db:migrate` trên DB đích. Chế độ staging không chạy tác vụ
đọc lại này.

**Tính nến sẵn từ giao dịch ở bảng thật:** sau migration `0024`–`0027`, mọi giao dịch
được thêm/sửa/xoá trong `trades` sẽ đánh dấu phút cần tính lại. Chạy hai lệnh sau với đúng
`DATABASE_URL` của app DB (không phải DB Envio), ở tiến trình riêng với Envio:

```sh
npm run -w be candles:backfill
npm run -w be candles:worker
```

`candles:backfill` quét lại lịch sử theo từng ngày, tiếp tục từ ngày đã hoàn thành nếu bị dừng,
và chỉ sau khi hoàn tất mới cho API đọc nến lưu sẵn. Đây là tác vụ nặng, nên chạy một lần sau
migration và theo dõi tài nguyên DB. `candles:worker` xử lý các phút mới hoặc bị thay đổi theo lô
nhỏ, thử lại khi gặp lỗi; nó không chặn Envio ghi launch/giao dịch. Nếu worker chậm, API ẩn nến
cũ thuộc khoảng đang chờ và báo `complete: false`. Sau khi backfill hoàn tất, cao/thấp 52 tuần
được lấy từ nến ngày và nến phút đã lưu. Phút có giao dịch chưa xác định được giá vẫn được ghi
nhận để API không hiển thị cao/thấp thiếu dữ liệu. Mép đầu khoảng 52 tuần làm tròn xuống phút,
nên có thể gồm tối đa 59 giây trước mốc chính xác. Cơ chế này chưa xoá bất kỳ giao dịch cũ nào.

## Chạy FE

Cần backend API (`dev:api`) đang chạy trước. Sao chép biến môi trường rồi khởi động FE ở terminal riêng:

```sh
cp fe/.env.example fe/.env.local
npm run dev -w fe
```

Mở `http://localhost:3000`. `BE_API_URL` (đọc phía server, cho các trang Next.js render dữ liệu launch) và `NEXT_PUBLIC_BE_API_URL` (đọc phía trình duyệt, cho kết nối SSE realtime ở `fe/src/hooks/use-live-refresh.ts`) trong `fe/.env.local` phải trỏ cùng một instance API. Khi API tắt hoặc mất kết nối SSE, giao diện hiện lỗi có nút thử lại hoặc chuyển sang polling định kỳ, không hiện trang trắng.

**Giới hạn coverage hiện tại:** vì backend chưa backfill toàn chain (xem phần Trạng thái hiện tại), FE sẽ hiện huy hiệu “Backfilling” cho hầu hết launch và “No data yet” cho volume/giá còn thiếu, thay vì số 0 hay dữ liệu giả. Đây là hành vi đúng theo thiết kế, không phải lỗi. (FE copy đổi sang tiếng Anh từ 2026-10-01 — xem CLAUDE.md.)

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
