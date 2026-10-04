# Đặc tả — Chuyển thu thập dữ liệu Pons sang Envio HyperIndex (tự host)

**Ngày:** 30/09/2026

**Trạng thái:** Đã chốt hướng thiết kế qua brainstorming (`/superpowers:brainstorming`); triển khai theo yêu cầu người dùng.

**Phạm vi của lần migration này:** Thay thế lớp thu thập dữ liệu tự viết hiện tại (`be/src/indexer/*`, `be/src/cli/runFactoryIndexer.ts`) bằng Envio HyperIndex tự host, cho đúng phạm vi Pons trên Robinhood Chain (`chainId=4663`) đang có. Không mở rộng sang launchpad/chain khác, không đổi API công khai hay frontend. Quyết định cũ loại hẳn “Pools khác” đã bị hủy ngày 04/10/2026; mục Pools là phần sản phẩm riêng và dùng Envio khi triển khai.

## 1. Bối cảnh và động lực

Indexer tự viết hiện tại (job-queue scheduler, `scanToHead`, các adapter Pons V1/V2) đã hoạt động đúng nhưng đòi hỏi tự xây và tự vá nhiều cơ chế hạ tầng: song song hoá có giới hạn, AIMD điều chỉnh concurrency, fair queueing theo backlog, lease/generation fencing chống reorg, quản lý nhiều RPC endpoint/key và ngân sách CU, tự phát hiện và vá từng loại lỗi RPC (429, response quá lớn, timeout...). Phần lớn phiên làm việc ngày 30/09/2026 dành cho việc xây và vá các cơ chế này.

Envio HyperIndex (khảo sát cùng ngày) giải quyết trực tiếp phần lớn các vấn đề đó ở tầng hạ tầng:
- Hỗ trợ hạng nhất cho Robinhood Chain, đọc dữ liệu qua **HyperSync** thay vì RPC thường — không còn giới hạn CU/rate-limit kiểu Validation Cloud đang gặp.
- `contractRegister` — đăng ký địa chỉ pool mới ngay trong handler xử lý event factory, quy mô không giới hạn (từng giới hạn 8 triệu địa chỉ, nay đã bỏ) — thay thế hoàn toàn cơ chế `eligibleVenues`/nhóm địa chỉ thủ công hiện tại.
- Tự xử lý reorg ở tầng thu thập.
- TypeScript, khớp stack hiện có.
- Tự host miễn phí hoàn toàn (chỉ cần 1 `ENVIO_API_TOKEN` miễn phí cho HyperSync, không tính phí theo query khi tự host).

Quyết định (qua brainstorming, đã người dùng duyệt từng bước):
- **Giữ nguyên** PostgreSQL/Drizzle, API Fastify, OpenAPI, frontend — không đổi gì ở các lớp này.
- Envio **chỉ thay thế phần thu thập** (nghe block, giải mã log, phát hiện pool mới).
- Envio ghi vào **schema riêng của nó**; một lớp đồng bộ mới đọc từ đó và ghi vào đúng schema/bảng hiện có, áp đúng toàn bộ luật nghiệp vụ hiện tại.
- **Tự host** Envio (không dùng Envio Cloud) — nhất quán với ưu tiên free/local đã thống nhất từ đầu dự án.
- **Chạy song song** với indexer cũ, đối chiếu kết quả, rồi mới cắt hẳn — không thay thế "một phát ăn ngay" cho một hệ thống đang chạy thật.

## 2. Kiến trúc tổng thể

```
Robinhood Chain (4663)
        │  qua HyperSync (ENVIO_API_TOKEN)
        ▼
┌───────────────────────────────────────────┐
│ Envio HyperIndex (tiến trình tự host mới)  │
│  - handler: TokenLaunched (V1 legacy/active,│
│    V2 factory)                              │
│  - contractRegister: đăng ký pool V3 mới,   │
│    pool V4 đã verify (Initialize+PoolGraduated)│
│  - handler: Swap (V3), CurveBuy/CurveSell/  │
│    CurveBuyback, Sweep/Graduated/Rescued,   │
│    PoolManager.Initialize, V4 Swap          │
│  - ghi vào: PostgreSQL riêng của Envio      │
│    (schema tự sinh từ schema.graphql, gần   │
│    1:1 với raw event, tối thiểu biến đổi)   │
└───────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────┐
│ Lớp đồng bộ (mới) — be/src/envio-sync/     │
│  Đọc bảng raw của Envio, áp lại đúng luật   │
│  nghiệp vụ hiện có:                         │
│  - venue chính thức (V1→V3 pool; V2→curve   │
│    tới khi sweep, sau đó chỉ V4 pool đã     │
│    verify cùng tx với Initialize)           │
│  - phân loại giao dịch (user_trade vs       │
│    protocol_activity cho buyback)           │
│  - suy ra lifecycle_status                  │
│  - tính price staleness                     │
│  Ghi vào bảng staging khi chạy song song,   │
│  bảng thật sau khi cắt hẳn.                  │
└───────────────────────────────────────────┘
        │
        ▼
launches / venues / trades / lifecycle_transitions /
raw_logs / candles / phase_observations (schema hiện có, KHÔNG đổi)
        │
        ▼
API Fastify + OpenAPI + Frontend (KHÔNG đổi)
```

Indexer tự viết hiện tại (`jobScheduler.ts`, `scan.ts`, `runFactoryIndexer.ts`, các adapter) **giữ nguyên, tiếp tục chạy** cho tới khi giai đoạn đối chiếu (mục 5) xác nhận Envio+lớp đồng bộ cho kết quả đúng, sau đó mới tắt — đúng nguyên tắc "không chạy hai writer cùng ghi một chỗ, có đường lùi" đã áp dụng khi chuyển sang job-queue scheduler trước đó.

## 3. Phạm vi dữ liệu (không đổi so với hiện tại)

- Pons V1 legacy + active: factory → launch → pool V3 chính thức → `Swap`.
- Pons V2: factory → launch → bonding curve (`CurveBuy`/`CurveSell`/`CurveBuyback`) → `Sweep` → `Graduated`/`Rescued` → nếu graduated: pool V4 do Pons tạo, chỉ chấp nhận sau khi khớp `PoolGraduated` với `PoolManager.Initialize` **cùng transaction/block** và xác minh pool ID/key/hook/manager → `Swap` V4.
- Lần migration này giữ tập nguồn Pons đang có, chưa thêm launchpad, chain hay pool khác. Đây là ranh giới công việc migration, không phải nguyên tắc loại pool khác khỏi sản phẩm; mục Pools riêng sẽ mở rộng Envio sau đó.
- Không đổi hành vi API: coverage theo từng launch (đã có ở Task 5 kế hoạch song song), null khi thiếu dữ liệu, không tự tạo nến/volume giả trong khoảng không có trade.

## 4. Envio: entity và handler cần viết

Định nghĩa entity trong `schema.graphql` của Envio, gần với raw event, KHÔNG áp luật nghiệp vụ tại đây (luật nghiệp vụ thuộc lớp đồng bộ):

- `RawLaunch` — từ `TokenLaunched` (V1 legacy, V1 active, V2): token, deployer, factory, block/tx/logIndex, tham số theo từng version.
- `RawPool` — mỗi pool được `contractRegister` đăng ký: V3 pool (từ log launch V1), V4 pool (từ `PoolGraduated`+`Initialize` cùng tx).
- `RawSwap` — từ `Swap` (V3), `Swap` (V4, đã lọc theo `poolId`) — giữ nguyên `sender`/`origin` nếu đọc được cả hai (V4 cần `tx.origin` vì `sender` thường là router, đã ghi nhận trong `Trade.traderAddress` hiện tại).
- `RawCurveTrade` — từ `CurveBuy`/`CurveSell`/`CurveBuyback`.
- `RawLifecycleTransition` — từ `Sweep`/`Graduated`/`Rescued`.
- `RawInitialize` — từ `PoolManager.Initialize`, dùng để lớp đồng bộ tự xác minh khớp với `PoolGraduated` (KHÔNG tin tưởng Envio đã verify hộ — verify lại ở lớp đồng bộ để giữ đúng nguyên tắc "chỉ pool đã xác minh on-chain" hiện có).

`contractRegister` trên handler `TokenLaunched` (V1) đăng ký pool V3 tương ứng; trên handler khớp `PoolGraduated`+`Initialize` đăng ký pool V4 để bắt `Swap` V4 từ đúng block `Initialize` trở đi (không bỏ sót, không lùi về thời điểm phát hiện).

## 5. Lớp đồng bộ (sync layer)

Trách nhiệm (tương đương những gì `persistBatchInTransaction`, `lifecycleRuntime.ts`, `tradeRuntime.ts`, `v4Runtime.ts` đang làm hôm nay, chỉ khác nguồn đọc):

- Đọc bảng raw của Envio (poll định kỳ hoặc theo checkpoint, KHÔNG cần real-time tuyệt đối — API vẫn honest về độ trễ như hiện tại).
- Xác định venue chính thức đúng luật: V1 luôn là pool V3; V2 là curve cho tới khi có `Sweep`, sau đó chỉ pool V4 đã verify qua bước ở mục 4 — không suy diễn "pool chính thức" chỉ từ cùng địa chỉ token.
- Phân loại `activity_kind`: buyback thực thi trên curve/V4 tính vào volume chính thức với nhãn `protocol_activity`; phí chuyển khoản, refund, khóa vault không tạo trade.
- Giữ đúng thứ tự `(blockNumber, logIndex)`, đơn vị quote-asset, số nguyên thô, provenance — y hệt yêu cầu hiện tại.
- Ghi idempotent (khóa theo `(chain_id, block_hash, tx_hash, log_index)` như hiện tại) — chạy lại không tạo trùng.
- Trong giai đoạn chạy song song (mục 6): ghi vào **bảng staging riêng** (ví dụ hậu tố `_envio`), không đụng bảng thật đang phục vụ API. Sau khi cắt hẳn: ghi thẳng vào bảng thật, tắt lớp ghi cũ.

**Xử lý reorg ở lớp đồng bộ:** cần xác định cụ thể cách Envio báo reorg cho consumer (xoá/sửa ngược raw row, hay chỉ dừng phát event mới) — đây là điểm cần làm rõ bằng thử nghiệm thực tế (đọc tài liệu Envio về reorg, thử tạo reorg giả trên fork cục bộ) trước khi viết lớp đồng bộ, ghi vào kế hoạch triển khai chứ không giả định trước ở đặc tả này.

## 6. Kế hoạch đối chiếu song song và tiêu chí cắt hẳn

- Envio + lớp đồng bộ chạy **song song**, độc lập, ghi vào bảng staging — không ảnh hưởng bảng thật đang phục vụ API/FE, không tắt indexer cũ trong giai đoạn này.
- Công cụ đối chiếu (mới, nhỏ): so sánh giữa bảng thật (indexer cũ) và bảng staging (Envio) cho cùng khoảng block đã xác nhận ở CẢ HAI phía:
  - số launch theo từng nguồn,
  - số trade theo từng venue,
  - tổng volume chính thức 24h theo từng token,
  - `lifecycle_status` theo từng token,
  - giá cuối cùng (price quote) theo từng token.
- Tiêu chí cắt hẳn: N lần đối chiếu liên tiếp (con số cụ thể chốt ở kế hoạch triển khai) không lệch, hoặc lệch có giải thích được và chấp nhận được — không cắt khi còn lệch không rõ nguyên nhân.
- Cắt hẳn: dừng indexer cũ (theo đúng quy trình đã dùng khi chuyển sang job-queue scheduler — dừng sạch, xác nhận dữ liệu chỉ tăng không giảm), lớp đồng bộ chuyển ghi sang bảng thật, giữ code indexer cũ lại một thời gian làm đường lùi trước khi gỡ hẳn.

## 7. Kiểm thử

- Đơn vị: hàm biến đổi trong lớp đồng bộ (venue chính thức, phân loại activity, lifecycle) — dùng lại fixture đã có (`be/tests/fixtures/pons-v2-graduated.json`) nếu áp dụng được, viết fixture mới theo schema raw của Envio khi cần.
- Tích hợp: Envio chạy trên một khoảng block lịch sử đã biết trước (giống audit hiện có) → lớp đồng bộ → so sánh đúng từng dòng với dữ liệu đã xác minh trong `be/tests/fixtures/`.
- Đối chiếu trên dữ liệu thật: theo mục 6, không phải test tự động một lần mà là quy trình vận hành có ghi log/kết quả.

## 8. Lộ trình triển khai dự kiến

1. Tạo project Envio tự host, viết handler cho **V1 legacy + V3 pool + Swap V3 trước** (lát cắt nhỏ nhất, đúng tinh thần "Pons là proving slice"), xác thực đúng với fixture trước khi mở rộng.
2. Thêm V2 factory + curve + lifecycle transitions.
3. Thêm xác minh pool V4 (`Initialize`+`PoolGraduated` cùng tx) + `Swap` V4 — phần phức tạp nhất, cần giữ đúng nguyên tắc "chỉ pool đã xác minh".
4. Viết lớp đồng bộ + bảng staging + công cụ đối chiếu.
5. Chạy song song với indexer cũ đang live, đối chiếu theo mục 6.
6. Sửa lệch (nếu có), lặp lại đối chiếu tới khi đạt tiêu chí.
7. Cắt hẳn theo quy trình ở mục 6; giữ indexer cũ làm đường lùi.
8. Gỡ bỏ code indexer cũ (`be/src/indexer/*` liên quan trực tiếp tới quét RPC — giữ lại phần logic nghiệp vụ đã tái dùng ở lớp đồng bộ) sau khi Envio+lớp đồng bộ đã ổn định trong sản xuất một thời gian đủ dài.

## 9. Ngoài phạm vi đặc tả này

- Launchpad khác, chain khác (theo đúng roadmap hiện có — chưa mở rộng).
- Ví, giao dịch thật (đã hoãn theo CLAUDE.md).
- Chuyển khỏi PostgreSQL/Fastify API — đã loại rõ ràng qua brainstorming, giữ nguyên các lớp này.
- Dùng Envio Cloud (managed) — chỉ tự host trong đặc tả này; có thể xem lại sau khi sản phẩm thật cần độ tin cậy vận hành cao hơn.
