# Đặc tả — Cutover: Envio trở thành nguồn ghi chính, tắt hẳn indexer RPC-scan

**Ngày:** 01/10/2026

**Trạng thái:** Đã chốt hướng thiết kế qua brainstorming (`/superpowers:brainstorming`), đã người dùng duyệt từng phần trong hội thoại. Bổ sung/thay thế mục 5-8 của `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md`.

**Phạm vi:** Hoàn thiện lớp đồng bộ Envio (`be/src/envioSync/`) để nó có thể ghi trực tiếp vào các bảng thật (`launches`, `venues`, `trades`, `lifecycle_transitions`) mà API/FE đang dùng, thay thế hoàn toàn indexer RPC-scan hiện tại (`be/src/cli/runFactoryIndexer.ts` và `be/src/indexer/*`). Không mở rộng sang launchpad/chain khác, không đổi API công khai hay hành vi frontend.

## Quyết định đã chốt qua hội thoại (khác với spec gốc 2026-09-30)

- **Không giữ indexer cũ làm đường lùi sau cutover.** Spec gốc (mục 6) đề xuất "giữ code indexer cũ lại một thời gian làm đường lùi trước khi gỡ hẳn" — người dùng đã **từ chối rõ ràng** hướng này sau khi được giải thích hậu quả cụ thể (FE mất phần lớn dữ liệu hiển thị nếu tắt sớm). Quyết định cuối: chờ đủ điều kiện sẵn sàng (xem mục 5) rồi tắt hẳn indexer cũ ngay lúc cutover, không chạy song song thêm sau đó.
- **Đường lùi duy nhất:** không xóa code/migration của indexer cũ khỏi repo (vẫn nằm trong git history và có thể khôi phục nếu cần), nhưng sau cutover sẽ không có tiến trình indexer cũ nào chạy nền — nếu phát hiện sự cố, phải chủ động khởi động lại indexer cũ bằng tay (nó tự tiếp tục từ cursor đã lưu trong bảng `sources`, không mất tiến độ).

## 1. Hai lỗ hổng chặn việc ghi thẳng vào bảng thật

Phát hiện khi đối chiếu cấu trúc bảng thật (`be/src/db/schema.ts`) với dữ liệu lớp đồng bộ Envio hiện có:

**(a) Thiếu dữ liệu metadata on-chain.** Bảng `launches` thật bắt buộc NOT NULL cho `name`, `symbol`, `quoteAssetSymbol`, `quoteAssetDecimals`. Lớp đồng bộ Envio hiện tại chỉ đọc được các trường có sẵn trong event (không gọi RPC bổ sung), nên các trường này đang để `null` trong bảng staging — sẽ bị Postgres từ chối nếu ghi thẳng vào bảng thật.

**(b) Thiếu "biên lai gốc" (`raw_logs`).** Bảng `launches`/`venues`/`trades` thật yêu cầu NOT NULL `sourceLogId` (khóa ngoại trỏ tới `raw_logs`, nơi indexer RPC-scan lưu lại log blockchain thô nó đọc được). Bảng `lifecycle_transitions` còn nặng hơn: `sourceLogId` chính là **khóa chính** của bảng. Lớp đồng bộ Envio không tạo ra các dòng `raw_logs` tương ứng (nó đọc entity đã giải mã sẵn của Envio, không có log thô gốc), nên không thể tạo khóa ngoại/khóa chính hợp lệ cho các bảng này.

Cả hai lỗ hổng này không phải giới hạn cố hữu — có cách giải quyết cụ thể ở mục 2 và 3.

## 2. Bổ sung đọc metadata on-chain vào lớp đồng bộ

Lớp đồng bộ (`be/src/envioSync/`) hiện tại chỉ kết nối tới 2 nguồn: Postgres của Envio (đọc) và Postgres của app (ghi) — không có client RPC. Bổ sung một viem `PublicClient` (dùng `RH_HTTP_RPC_URL`, đã có sẵn trong `be/.env.example`), rồi tái sử dụng trực tiếp các hàm đã có và đã kiểm thử của indexer RPC-scan:

- `readV1TokenMetadata(client, token)` — `be/src/launchpads/pons/v1/state.ts` — tên/ký hiệu/số thập phân token V1.
- `readV2TokenMetadata(client, token)` — `be/src/launchpads/pons/v2/adapter.ts` — tên/ký hiệu/số thập phân token V2 (lưu ý: `tokenDecimals` của token V2 tự nó luôn là 18, factory đảm bảo — xem comment hiện có ở `transformV2.ts`, không cần gọi RPC cho trường này).
- `resolveV2QuoteAsset(client, pairToken)` (tên hàm thực tế xác nhận lại khi đọc code trong task) — `be/src/launchpads/pons/v2/adapter.ts` — ký hiệu/số thập phân tiền giao dịch, trừ trường hợp địa chỉ zero (ETH, đã biết sẵn không cần RPC).

Các hàm này nhận một interface client tối giản (`readContract`) — một `createPublicClient` từ viem trỏ vào `RH_HTTP_RPC_URL` thỏa mãn interface này trực tiếp, không cần lớp bọc thêm.

**Vị trí gọi:** ngay trước khi insert một dòng `launches` mới (V1 hoặc V2) mà tên/ký hiệu đang unknown — gọi 1 lần, lưu kết quả luôn vào dòng đó (không gọi lại mỗi chu kỳ cho launch đã có đủ dữ liệu).

**Trường hợp RPC lỗi/token không chuẩn ERC20:** giữ nguyên hành vi lỗi của hàm gốc (ném lỗi) — chu kỳ sync bắt lỗi này giống mọi lỗi khác (log, thử lại chu kỳ sau), không chèn placeholder giả cho tên/ký hiệu.

**`v4PoolFee`/`v4TickSpacing`:** hai trường này nullable ở bảng thật, không bắt buộc. Không nằm trong phạm vi bắt buộc của spec này — để `null` là hợp lệ, có thể bổ sung sau (indexer RPC-scan đọc chúng từ factory-state tại thời điểm launch, cơ chế tương đương cho Envio nằm ngoài phạm vi; ghi `null` không vi phạm ràng buộc nào).

## 3. Thay đổi cấu trúc bảng thật (migration cộng thêm, không phá dữ liệu cũ)

Tất cả thay đổi dưới đây là **nới lỏng** (bớt ràng buộc), không xóa cột, không đổi kiểu dữ liệu của dữ liệu đã có — dòng dữ liệu cũ do indexer RPC-scan ghi giữ nguyên `sourceLogId` thật, không bị ảnh hưởng.

- `launches.sourceLogId`, `venues.sourceLogId`, `trades.sourceLogId`: bỏ `NOT NULL` — NULL sẽ không bị kiểm tra khóa ngoại (hành vi chuẩn của Postgres), cho phép dòng do Envio ghi để trống trường này.
- `lifecycleTransitions`: đổi khóa chính từ `sourceLogId` sang tổ hợp `(chainId, txHash, logIndex)` (giống cách bảng `trades` đang định danh duy nhất một log) — `sourceLogId` trở thành cột thường, nullable, giữ khóa ngoại khi có giá trị. **Cần kiểm tra trong task thực thi:** có chỗ nào trong code API/truy vấn hiện tại dựa vào `sourceLogId` là khóa chính của bảng này không (ví dụ dùng làm tham chiếu join) — nếu có, cập nhật theo khóa mới.
- Bảng `sources`: thêm các dòng đăng ký nguồn mới cho Envio (một lần, không lặp lại mỗi launch) — ví dụ `pons-v1-envio`, `pons-v2-envio`, `pons-v2-v4-envio` — để thỏa khóa ngoại `sourceId` NOT NULL của `launches`/`venues`/`trades`/`lifecycle_transitions`. Giá trị cụ thể cho `scannedToBlock`/`confirmedToBlock`/`status` (các cột vốn thiết kế cho cơ chế cursor của indexer cũ) xác định ở task thực thi — có thể để giá trị tĩnh/ước lệ vì lớp đồng bộ Envio không dùng cơ chế cursor này để vận hành (nó tự quét lại từ bảng raw Envio mỗi chu kỳ, không phụ thuộc `sources.scannedToBlock`).

## 4. Chống reorg cho lớp đồng bộ

Đã xác nhận qua tài liệu chính thức Envio (`docs.envio.dev/docs/HyperIndex/reorgs-support`): HyperIndex **tự phát hiện và tự khôi phục (rollback) dữ liệu trong bảng raw của chính nó** khi có reorg — bật mặc định (`rollback_on_reorg: true`), đảm bảo phát hiện được vì dự án dùng HyperSync (không phải RPC thường), phủ reorg sâu tới `max_reorg_depth` (mặc định 200 khối cho Robinhood Chain — không nằm trong nhóm Arbitrum/OP có mặc định 0). Không cần tự xây lại phần phát hiện reorg.

**Lỗ hổng thật sự:** lớp đồng bộ đọc bảng raw của Envio rồi ghi một chiều (insert, `onConflictDoNothing`) — không có cơ chế nhận biết khi một dòng raw bị Envio tự xóa/sửa do rollback. Dữ liệu phái sinh (staging hoặc bảng thật) từ dòng đã bị rollback sẽ ở lại sai vĩnh viễn.

**Cơ chế bổ sung — "xóa cửa sổ gần đây rồi quét lại", mỗi chu kỳ sync:**

1. Xác định mốc cửa sổ: `windowStart = (khối lớn nhất lớp đồng bộ từng ghi) - REORG_WINDOW_BLOCKS` (đề xuất mặc định `REORG_WINDOW_BLOCKS = 500`, dư ra so với `max_reorg_depth = 200` mặc định của Envio làm biên an toàn — giá trị chính xác chốt ở task thực thi).
2. Trước bước sync bình thường của mỗi chu kỳ: xóa toàn bộ dòng có `block_number >= windowStart` khỏi các bảng đích (staging hiện tại, hoặc bảng thật sau cutover) — áp dụng cho cả 4 loại bảng (`launches` theo `launch_block`, `venues` theo `effective_from_block`, `trades`/`lifecycle_transitions` theo `block_number`).
3. Chạy lại logic sync bình thường (đã idempotent sẵn) — nó sẽ tự dựng lại đúng từ dữ liệu HIỆN TẠI trong bảng raw Envio (đã được Envio tự sửa đúng nếu có reorg).

Vì bước (2) xóa trước khi (3) ghi lại, không cần so sánh từng dòng xem cái nào đổi — đơn giản, đúng, đánh đổi một chút chi phí (xóa+ghi lại vài trăm khối mỗi 15 phút, không đáng kể so với tổng dữ liệu).

**Lưu ý quan trọng về thứ tự xóa (tránh xóa oan dữ liệu cũ):** bảng thật có khóa ngoại `ON DELETE CASCADE` giữa `launches → venues → trades`. Nếu xóa một dòng `launches` nằm trong cửa sổ, nó sẽ **cascade xóa toàn bộ venues/trades của token đó, kể cả những dòng NẰM NGOÀI cửa sổ** (token đã launch từ lâu nhưng vẫn còn giao dịch gần đây). Vì vậy bước (2) phải xóa **độc lập theo từng bảng, lọc đúng cột khối của chính bảng đó** (`trades`/`lifecycle_transitions` theo `block_number`, `venues` theo `effective_from_block`, `launches` theo `launch_block`) — **không** xóa `launches` rồi dựa vào cascade để xóa phần còn lại. Chỉ những token launch NGAY TRONG cửa sổ (hiếm, token rất mới) mới có dòng `launches` bị xóa trực tiếp, và trường hợp đó cascade là đúng vì token đó không có dữ liệu nào cũ hơn cửa sổ cả.

**Áp dụng cho cả 2 giai đoạn:** cơ chế này cần hoạt động đúng khi đích là bảng staging (kiểm chứng trước cutover) VÀ khi đích là bảng thật (sau cutover) — viết thành một hàm dùng chung, nhận tên bảng đích làm tham số, không viết riêng 2 lần.

## 5. Điều kiện phải đạt trước khi cutover

Tất cả các điều kiện sau phải đạt **đồng thời**, xác nhận bằng dữ liệu thật đo được — không ước lượng:

1. Envio đã quét xong toàn bộ lịch sử tới gần khối đầu chain an toàn hiện tại (không còn "only in real" đáng kể trong `compare:envio-staging` — chênh lệch còn lại chỉ là độ trễ tự nhiên vài chu kỳ sync, không phải backlog lớn).
2. `compare:envio-staging` cho kết quả khớp 100% ở mọi hạng mục (launches, trades, V2 launches, V2 curve trades, lifecycle transitions, V4 swaps) — `only in staging` = 0 tuyệt đối trong N lần chạy liên tiếp (số N cụ thể chốt ở kế hoạch triển khai).
3. Cơ chế chống reorg (mục 4) đã triển khai, có test, và đã chạy ổn định trên staging một khoảng thời gian quan sát được trước khi áp dụng cho bảng thật.
4. Migration mục 3 đã chạy trên DB thật, kiểm tra không ảnh hưởng dữ liệu/API hiện có.
5. Bổ sung metadata (mục 2) đã kiểm thử, xác nhận launches mới có đầy đủ tên/ký hiệu như indexer cũ từng cung cấp.

## 6. Quy trình cutover

Thực hiện theo đúng thứ tự, không đảo bước, mỗi bước xác nhận xong mới sang bước kế:

1. Xác nhận đủ 5 điều kiện ở mục 5.
2. Dừng indexer RPC-scan cũ (`runFactoryIndexer.ts`) — dừng sạch, không kill cứng giữa một batch đang ghi dở.
3. Chạy một lần `compare:envio-staging` cuối cùng, xác nhận vẫn khớp 100% tại đúng thời điểm vừa dừng indexer cũ.
4. Đổi lớp đồng bộ từ ghi vào bảng staging sang ghi thẳng vào bảng thật (tái sử dụng gần như nguyên vẹn logic hiện có — xem mục 7).
5. Chạy lớp đồng bộ một chu kỳ, kiểm tra API/FE vẫn trả về đúng dữ liệu như trước khi cutover (so sánh thủ công vài launch/trade cụ thể).
6. Bật vòng lặp sync liên tục (`sync:envio-staging:loop`, đổi tên/đích phù hợp) chạy nền thay thế hoàn toàn vai trò của indexer cũ.

**Không có giai đoạn chạy song song sau bước 2** — theo đúng quyết định đã chốt ở đầu spec này. Nếu bước 5 phát hiện vấn đề, dừng lớp đồng bộ, khởi động lại indexer cũ bằng tay (tự tiếp tục từ cursor đã lưu), xử lý lỗi trước khi thử cutover lại.

## 7. Lớp đồng bộ chuyển hướng ghi

Các hàm `syncV1LegacyOnce`/`syncV2Once`/`syncV4Once` hiện tại import trực tiếp các Drizzle schema object của bảng staging (`launchesEnvioStaging`, `venuesEnvioStaging`, v.v.). Việc đổi đích ghi thực hiện bằng cách tham số hóa bảng đích đầu vào (không viết lại logic nghiệp vụ), theo đúng pattern tên bảng Envio raw đã tham số hóa sẵn (`EnvioTableNames`/`EnvioV2TableNames`/`EnvioV4TableNames`) — làm tương tự cho phía ghi. Chi tiết interface cụ thể xác định ở kế hoạch triển khai.

## 8. Kiểm thử

- Đơn vị: hàm metadata-enrichment (mục 2) — test với client RPC giả lập (mock `readContract`), không gọi RPC thật trong unit test.
- Đơn vị: hàm chống reorg (mục 4) — test với dữ liệu giả lập mô phỏng một dòng "biến mất" khỏi bảng raw giữa 2 chu kỳ, xác nhận dòng phái sinh tương ứng bị xóa đúng.
- Tích hợp: migration mục 3 chạy trên DB test, xác nhận dữ liệu cũ (sourceLogId thật) không bị ảnh hưởng, dữ liệu mới (sourceLogId null) ghi được.
- Tích hợp: lớp đồng bộ ghi thẳng vào bảng thật (không phải staging) trên DB test — mở rộng từ các test tích hợp hiện có của `runSync.ts`/`runSyncV2.ts`/`runSyncV4.ts`, đổi đích bảng.
- Vận hành thật: đối chiếu theo mục 5-6, không phải test tự động một lần mà là quy trình có ghi log kết quả từng lần chạy.

## 9. Ngoài phạm vi đặc tả này

- Gỡ bỏ code indexer RPC-scan (`be/src/indexer/*`, `be/src/cli/runFactoryIndexer.ts`) khỏi repo — giữ nguyên trong code, chỉ ngừng chạy. Việc xóa hẳn (nếu muốn) là quyết định riêng, sau khi Envio đã chạy ổn định một thời gian đủ dài trong thực tế.
- `v4PoolFee`/`v4TickSpacing` qua RPC bổ sung cho launch mới — để `null`, không bắt buộc (mục 2).
- Launchpad khác, chain khác, ví/giao dịch thật — ngoài phạm vi theo CLAUDE.md, không đổi bởi spec này.
- Dùng Envio Cloud (managed) — vẫn tự host, không đổi.
