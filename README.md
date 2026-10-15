# Launchpad Aggregator

Ứng dụng tổng hợp launchpad đa chain đang được xây dựng theo từng adapter. Giao diện và API hiện có trang Pools cho các pool liên quan đến token Pons, gồm swap và các chỉ số USD được index qua Envio.

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

**Chart theo cỡ nến/cột (1m / 5m / 1H / 4H / 1D):** mỗi tab đặt kích thước một nến giá hoặc một cột Volume/TVL; server chọn cửa sổ cố định tương ứng (`be/src/charts/ranges.ts`):

| Tab | Cỡ nến/cột | Cửa sổ | Số bucket |
|---|---|---|---|
| 1m | 1 phút | 2 giờ | 120 |
| 5m | 5 phút | 12 giờ | 144 |
| 1H | 1 giờ | 7 ngày | 168 |
| 4H | 4 giờ | 30 ngày | 180 |
| 1D | 1 ngày | 365 ngày | 365 |

API nhận `?range=1m|5m|1h|4h|1d` (mặc định `1h`; tên tham số `range` được giữ để tương thích). Volume và TVL được tính sẵn thay vì quét giao dịch
mỗi lần xem:

- `launch_volume_buckets` / `pool_volume_buckets`: do `candles:worker` và `pools:candles:worker` cập
  nhật trong cùng giao dịch với nến (bucket 1 phút từ giao dịch, các bucket lớn hơn gộp từ bucket nhỏ
  hơn liền kề). Bucket có giao dịch chưa định giá được thì volume là `null`, không phải 0.
- `pool_tvl_buckets`: giá trị cuối cùng mỗi giờ / 4 giờ / ngày, ghi cùng lúc với mỗi snapshot TVL và
  giữ sau khi snapshot thô bị xoá. Tab 1H/4H/1D đọc bảng này; 1m/5m đọc snapshot thô, nên cần chụp dày
  hơn mặc định. Gợi ý: `POOL_TVL_SNAPSHOT_INTERVAL_SECONDS=60` (mặc định 3600). Đây chỉ là gợi ý, chưa
  áp dụng cho worker nào đang chạy. Lịch sử TVL chỉ bắt đầu từ lúc bắt đầu chụp.

Sau migration `0050`, chạy một lần để dựng lại volume lịch sử (tiếp tục được nếu bị dừng):

```sh
npm run -w be charts:backfill-volume
```

Nến USD (chế độ USD của chart giá) cũng được tính sẵn theo từng phút trong `launch_usd_candle_buckets`
(cùng worker, cùng giao dịch). Dựng lại lịch sử bằng `npm run -w be charts:backfill-volume` (hoặc chỉ phần này:
`... charts:backfill-volume -- --only usd`). Worker và bảng `usd_candles` cũ (cùng script so sánh) đã được gỡ ở migration `0054`,
cùng bảng `scan_jobs` của bộ indexer RPC đã bỏ.

Worker giá USD chính thức: `npm run -w be prices:worker` (giải quyết feed Chainlink còn chờ và đồng bộ các round oracle; chu kỳ
`PRICE_WORKER_INTERVAL_SECONDS`, mặc định 30 giây).

**Đo độ trễ liên tục:** `GET /v1/metrics` (JSON) cho biết số luồng SSE đang mở và, với từng loại sự kiện, tổng số đã nhận cùng độ trễ
p50/p90/max trên 200 mẫu gần nhất. Độ trễ = thời điểm API nhận sự kiện trừ timestamp của block gây ra nó (`trade.created`, `pool.changed`),
tức chặng chain → Envio → sync → Postgres. Dùng nó để so trước/sau khi mua gói HyperSync.

**Fast lane (WebSocket, mặc định tắt):** một tiến trình riêng ghi giao dịch chính thức của launch (curve buy/sell, buyback, swap V3/V4 của pool
chính thức) vào `trades` ngay từ log WebSocket của chain, trước khi Envio kịp quét; Envio vẫn là nguồn đúng đắn, nó bổ sung phần lane bỏ sót
và `incrementalRepair` xoá dòng sai/reorg. Bật bằng `FAST_LANE_ENABLED=true` và `RH_WS_RPC_URL` (URL riêng tư, không đưa vào repo), rồi chạy
`npm run -w be fast-lane:run`. Đếm số log mỗi giây theo từng sự kiện (chỉ đếm tốc độ log, không đo trễ WebSocket):
`npm run -w be fast-lane:measure -- 90`. So các dòng lane đã ghi với dòng của Envio: `npm run -w be fast-lane:parity` (thoát với mã 1 nếu
có khác biệt; dòng nào mà giao dịch đã bị xoá thì được tính là `repaired` và bỏ đi). Khi có `ENVIO_DATABASE_URL`, `fast-lane:run` cứ 60 s
chạy reconcile: dòng lane đã cũ (mặc định 300 s, `FAST_LANE_RECONCILE_MIN_AGE_SECONDS`) và nằm dưới block Envio đã xử lý mà Envio không có
(hoặc có ở block khác) thì bị xoá (và thay bằng dòng của Envio nếu có); không có biến này thì reconcile tắt (in một cảnh báo). Swap V4 chỉ
được nhận khi log đến từ PoolManager. Watchdog: WebSocket im lặng 120 s thì cảnh báo mỗi phút, 600 s thì thoát mã 1 để supervisor khởi
động lại. Worker định giá curve lấy phí và thuế của giao dịch lane từ chính bản ghi lane (`fast_lane_rows.raw`) khi Envio chưa có dòng, nên giá token theo quote cũng chạy realtime; nếu một giao dịch cũ hơn đến muộn (Envio lấp chỗ lane bỏ sót) thì điểm lưu reserve của launch bị xoá và tính lại từ đầu theo đúng thứ tự. Watch set chỉ tải venue mới thêm (cột `venues.seq`, chồng lấn 2.000 dòng), tải đầy đủ lại mỗi 10 phút; venue bị xoá nằm lại trong set tới lần tải đầy đủ (vô hại: giao dịch không tìm thấy venue thì bị bỏ). `fast_lane_rows` tăng ~19k dòng/ngày nếu không chạy parity hoặc reconcile. Đo trên chain thật (DB nháp, 10 phút, 62 giao dịch): block → DB p50 0,79 s, p90 1,29 s; kiểm tra độc lập bằng `eth_getLogs` không thiếu giao dịch nào; block → trình duyệt (SSE) p50 ~0,8–0,95 s. Nhà cung cấp RPC đóng kết nối HTTP rảnh sau vài giây nên lần gọi thưa phải bắt tay TLS lại (800–1.200 ms thay vì 250 ms): làn nhanh tra cứu qua WebSocket, còn API và `launch-stats:live` gửi một `eth_blockNumber` mỗi 1,5 s (`RPC_KEEP_WARM_MS`, `0` = tắt) để số liệu launch tính lại sau ~30 ms thay vì ~700 ms. Chế độ chạy: `FAST_LANE_MODE=off` (mặc định) | `on` (luôn chạy; `FAST_LANE_ENABLED=true` là cách viết cũ của `on`) | `auto` — chỉ chạy khi pipeline Envio tụt sau head từ 40 block (~5 s) trở lên trong 3 lần đo liên tiếp (10 s/lần), và tắt khi Envio theo kịp (≤ 16 block ~2 s) suốt 30 lần đo (5 phút); độ trễ được đo bằng con trỏ `processed_watermark` của các luồng giao dịch trong `envio_sync_cursors` so với head của chain (`be/src/fastLane/governor.ts`; `FAST_LANE_AUTO_ON_LAG_BLOCKS`, `FAST_LANE_AUTO_OFF_LAG_BLOCKS`, `FAST_LANE_AUTO_SAMPLE_SECONDS`). Độ trễ không đo được (sync chưa chạy) được coi là tụt. Giá USD realtime: giá USD của một giao dịch = số lượng quote × round oracle gần nhất không cũ quá 24 giờ (`quote_usd_price_rounds`); làn nhanh cũng nghe `AnswerUpdated` của các aggregator của feed đã verify qua cùng WebSocket và lưu round ngay (`be/src/fastLane/oracleRounds.ts`, dùng `upsertPriceRounds` nên volume/biểu đồ được dựng lại và trang nhận `coverage.changed`); chạy và dừng cùng làn nhanh. Khoảng thời gian làn tắt thì worker giá (`prices:worker`, backfill round theo job) vẫn là đường bù. Lần đầu nên chạy `prices:backfill-history` để bảng round không cũ hơn 24 giờ. `GET /v1/metrics` có `lagByVia.fast` và `lagByVia.envio` để so
độ trễ hai đường. Tắt: bỏ biến `FAST_LANE_ENABLED` rồi dừng tiến trình; không có thành phần nào khác phụ thuộc vào nó. Chưa đo độ trễ
của lane trên giao dịch thật; mục tiêu là p50 từ chain đến API dưới ~1,5 s và 0 khác biệt parity trong 24 giờ.

**Số liệu danh sách launch theo thời gian thực:** khi một giao dịch được báo (`trade.created`), số liệu lưu sẵn của launch (giá, FDV, TVL,
% thay đổi) được tính lại ngay (tối đa 1 lần mỗi 2 giây cho mỗi launch) rồi mới báo `launch.changed` để trình duyệt tải lại. Mặc định việc
này chạy ngay trong tiến trình API (tiện cho một API cục bộ). Khi chạy nhiều API, tắt bản trong API bằng `LIVE_LAUNCH_STATS_IN_API=false`
và chạy một worker riêng: `npm run -w be launch-stats:live` (`LIVE_LAUNCH_STATS_CONCURRENCY`, mặc định 2); nó nghe Postgres và báo lại qua
Postgres nên mọi API instance đều nhận được. Worker `launch-stats:worker` cũ vẫn là lưới an toàn làm mới theo chu kỳ.

Khi backfill chạy xong, nó ghi `chart_rollup_state` (`launch_volume_done`, `pool_volume_done`, `launch_usd_candles_done`). Trước đó API trả
`complete: false` và bucket không có dòng là `null` (không phải $0), vì có thể chỉ là chưa dựng lại.


**Snapshot TVL của pool V4:** `%` thay đổi TVL so với 24h trước cần lịch sử TVL, mà chain chỉ
trả TVL tại block hiện tại, nên có một worker chụp TVL mỗi giờ vào bảng `pool_tvl_snapshots`
(migration `0047`):

```sh
npm run -w be pools:tvl-snapshots:worker
```

Cần `DATABASE_URL` của app DB và `RH_HTTP_RPC_URL`. Tùy chọn: `POOL_TVL_SNAPSHOT_INTERVAL_SECONDS`
(mặc định 3600, trong khoảng 60–10800) và `POOL_TVL_SNAPSHOT_RETENTION_HOURS` (mặc định 168,
tối thiểu 26; snapshot cũ hơn mức này bị xoá sau mỗi lượt chụp). Trong khoảng 24h đầu sau khi
worker bắt đầu chạy, `%` TVL hiển thị "—" vì chưa có snapshot cũ để so; đó là bình thường.

### Sync gần thời gian thực (incremental) và repair reorg — thay cho vòng lặp đọc lại toàn bảng

Từ bản near-realtime-sync, chế độ `ENVIO_SYNC_TARGET=real` của `sync:envio-staging:loop` **không còn**
đọc lại toàn bộ bảng raw mỗi `ENVIO_SYNC_LOOP_INTERVAL_MS`. Thay vào đó nó chạy một vòng lặp mới,
đọc theo cursor bounded cho từng stream (launch/swap V1, launch/curve/buyback/lifecycle V2, initialize/
swap V4), áp dụng trong transaction, rồi ngủ ngắn và lặp lại:

```sh
ENVIO_SYNC_TARGET=real npm run -w be sync:envio-staging:loop
```

Các biến điều khiển vòng lặp mới (đều optional, có default hợp lý cho dev):

- `ENVIO_TAIL_PASS_INTERVAL_MS` (mặc định `250`): khoảng nghỉ giữa hai lượt tail+history. Đo 2026-10-12: 1000ms → độ trễ raw→trades p50 0,83s; 250ms → 0,41s, CPU của sync loop ~6%.
- `ENVIO_INCREMENTAL_PAGE_LIMIT` (mặc định `500`): số dòng raw tối đa đọc mỗi stream mỗi lượt.
- `ENVIO_REPAIR_EVERY_TICKS` (mặc định `30`): sau bao nhiêu lượt tail thì chạy một lượt repair reorg
  (so khớp key canonical trong 500 block cuối, xoá dòng đã lỗi thời, lùi cursor để lượt sau áp lại
  đúng dữ liệu) — repair nặng hơn một lượt tail bình thường nên không chạy mỗi tick.

Launch mới hiện ngay với `name`/`symbol` là `null` (FE hiển thị địa chỉ token thay tên) cho tới khi
job làm giàu metadata lõi (`be/src/launchpads/pons/coreMetadata.ts`, chạy chung cơ chế lease với job
logo/description/socials cũ) điền đầy đủ. **`ENVIO_SYNC_TARGET=staging` và lệnh `sync:envio-staging`
một lần vẫn dùng đường cũ (đọc lại toàn bảng) không đổi** — đây là cách rollback nếu đường incremental
có vấn đề: dừng tiến trình `real`, chạy lại với `ENVIO_SYNC_TARGET=staging` hoặc gọi trực tiếp các hàm
`syncV1LegacyToReal`/`syncV2ToReal`/`syncV4ToReal` qua `runAllSyncsOnce` (xem `be/src/envioSync/syncAll.ts`)
để đối chiếu/khôi phục thủ công. Không hàm nào trong hai đường bị xoá — đường cũ luôn còn để đối chiếu.

**Benchmark/probe trên DB disposable (không chạy trên app DB thật):**

```sh
DATABASE_URL=postgres://launchpad:launchpad_local@127.0.0.1:55432/launchpad_test \
  npm run -w be tsx src/cli/benchmarkIncrementalSync.ts
```

Script tự chối chạy nếu tên DB trong `DATABASE_URL` không chứa `test`/`disposable`/`bench` — không có
cách nào chạy nhầm lên app DB thật. Nó tự sinh dữ liệu synthetic (launch V1/V2, curve, buyback,
graduation, pool V4), chạy đường cũ (full-table) trước để lấy tập key canonical "chuẩn", xoá sạch, rồi
chạy đường incremental trên cùng dữ liệu và so khớp key — khớp tuyệt đối thì in `MATCH`. Nó cũng đo độ
trễ từ lúc ghi dòng raw đến lúc transaction app commit, và một proxy "đến lúc SSE bắn thông báo" (không
phải thời gian render UI thật — không có trình duyệt trong probe này, nhãn rõ là proxy). Ngưỡng pass:
commit ≤ 3s, proxy SSE ≤ 5s (mục tiêu của spec, đo trên tải local "khoẻ mạnh", không phải cam kết độ
trễ chain-to-UI thật). Script còn chạy thử "restart" (áp lại đúng dữ liệu, kỳ vọng 0 dòng mới) và một
lượt repair trên dữ liệu đã đúng (kỳ vọng 0 thay đổi). **Không đo được** tình huống 429/throttling từ
provider hay độ trễ chain-to-Envio thật — hai thứ này cần kết nối Envio/HyperSync thật, không có trong
probe DB disposable; muốn đo thật thì chạy `sync:envio-staging:loop` với `RH_HTTP_RPC_URL` thật và theo
dõi log. Biến môi trường `BENCH_V1_LAUNCHES`/`BENCH_V2_LAUNCHES`/`BENCH_GRADUATED` chỉnh quy mô dữ liệu
synthetic (mặc định 10/10/3).

## Kiểm toán độ phủ launch Pons

`GET /v1/coverage` báo riêng độ phủ từ source và `launchParity` cho ba factory Pons.
`complete` chỉ có thể là `true` khi các khoảng finalized đã có báo cáo đối chiếu liên tục,
không có sai khác, và các nguồn giao dịch/lifecycle cũng đã bắt kịp. `latestFinalizedFence`
loại 500 block mới nhất. `parityAlerts` đếm source sai khác, watermark chậm và yêu cầu sửa
đang chờ. Một báo cáo chưa chạy hoặc bị lỗi giữ trạng thái chưa đầy đủ.

`launch_parity_reports` lưu kết quả đối chiếu; `launch_parity_repairs` lưu yêu cầu sửa theo
khoảng block và theo lớp lỗi (`envio_reindex` hoặc `app_promotion`). Yêu cầu sửa là hàng đợi
vận hành, không tự kích hoạt Envio reindex. Chỉ đánh dấu đã sửa sau khi chạy lại audit và
đối chiếu thành công.

Trong `be/`, đặt `DATABASE_URL`, `ENVIO_DATABASE_URL`, `RH_HTTP_RPC_URL` vào `.env`, chọn
`AUDIT_FENCE` là block head quan sát được ở lúc audit, rồi chạy một khoảng nhỏ đã finalized:

```sh
AUDIT_FENCE=... # số block head thật từ RPC; audit từ chối fence vượt head hoặc 500 block mới nhất
npx tsx --env-file-if-exists=.env src/cli/auditLaunchParity.ts \
  --source pons-v1-legacy --from 8600612 --to 8602611 --fence "$AUDIT_FENCE" --max-range 2000
```

Lặp với `pons-v1-active` từ block `8991118` và `pons-v2` từ block `26841846`.
Mỗi lệnh giới hạn 20.000 block, mỗi truy vấn tối đa 2.000 block; tiếp tục các khoảng liền kề
để phủ toàn lịch sử. Lệnh mặc định **chỉ đọc**, in JSON từng khoảng gồm số sự kiện chain,
Envio, app, event thiếu/thừa, block hash sai và watermark của từng lớp. Chỉ dùng
`--persist yes` để ghi báo cáo/hàng đợi sửa; trên DB không có hậu tố `_test`, lệnh còn yêu cầu
`AUDIT_ALLOW_LIVE_WRITE=1`. Xem trạng thái baseline tại
`docs/operations/2026-10-05-launch-parity-baseline.md`.

## Chạy FE

Cần backend API (`dev:api`) đang chạy trước. Sao chép biến môi trường rồi khởi động FE ở terminal riêng:

```sh
cp fe/.env.example fe/.env.local
npm run dev -w fe
```

Mở `http://localhost:3000`. `BE_API_URL` (đọc phía server, cho các trang Next.js render dữ liệu launch) và `NEXT_PUBLIC_BE_API_URL` (đọc phía trình duyệt, cho kết nối SSE realtime ở `fe/src/hooks/use-live-refresh.ts`) trong `fe/.env.local` phải trỏ cùng một instance API. Đặt `RH_HTTP_RPC_URL` trong `fe/.env.local` nếu dùng RPC riêng: trình duyệt gọi `/api/rpc`, route này chuyển tiếp các phương thức đọc tới URL phía server, giới hạn 240 request/phút mỗi client, tối đa 20 lệnh/batch và 64 KiB/request. Không đặt URL có khóa vào biến `NEXT_PUBLIC_*`. Khi API tắt hoặc mất kết nối SSE, giao diện hiện lỗi có nút thử lại hoặc chuyển sang polling định kỳ, không hiện trang trắng.

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

`npm run test:e2e -w fe` tự khởi động BE giả (`fe/e2e/mock-api.ts`) ở cổng 3101 và `next dev` ở cổng 3100; Playwright chạy cả desktop và mobile. Mock không cần backend/PostgreSQL thật. `MOCK_API_DELAY_MS` (mặc định 0) chỉ dùng khi muốn mô phỏng API chậm; bộ e2e không tự đặt biến này. `CI` bật retry và không dùng lại server đang chạy. Test hiện bao gồm chart, giao dịch và swap.

Các biến chỉ dành cho môi trường thử nghiệm với Envio quét một phần lịch sử: `COVERAGE_HEAD_TOLERANCE_BLOCKS` (mặc định 0) nới ngưỡng báo nguồn đã bắt kịp head; `ENVIO_INDEXED_FROM_BLOCK` (mặc định không đặt) ghi block đầu của cửa sổ index để pool cũ không hiện volume thiếu thành `$0`. Đặt chúng ở `be/.env` khi cần; không dùng để khẳng định coverage đầy đủ trên dữ liệu thật.

## Bước còn lại trước khi coi backend đạt yêu cầu

Kiểm chứng giá curve lịch sử bằng RPC lưu state cũ, đối chiếu số launch với nguồn độc lập, chạy backfill cả ba factory và mọi nguồn trade/lifecycle đến safe head, rồi đo độ trễ khi head mới xuất hiện. Chỉ khi đối chiếu phase và coverage qua cửa sổ yêu cầu thành công mới kết luận volume/chart đầy đủ. Ví và mua/bán thật là giai đoạn sau, chưa nằm trong lát cắt chỉ đọc này. Kế hoạch Pons V2 ở [lifecycle plan](docs/superpowers/plans/2026-09-29-pons-v2-lifecycle.md).
