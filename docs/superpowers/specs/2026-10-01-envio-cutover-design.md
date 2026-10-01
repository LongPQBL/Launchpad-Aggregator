# Đặc tả — Cutover: Envio trở thành nguồn ghi chính, tắt hẳn indexer RPC-scan

**Ngày:** 01/10/2026

**Trạng thái:** Đã chốt hướng thiết kế qua brainstorming (`/superpowers:brainstorming`), đã người dùng duyệt từng phần trong hội thoại. Bổ sung/thay thế mục 5-8 của `docs/superpowers/specs/2026-09-30-envio-indexer-migration-design.md`.

**Phạm vi:** Hoàn thiện lớp đồng bộ Envio (`be/src/envioSync/`) để nó có thể ghi trực tiếp vào các bảng thật (`launches`, `venues`, `trades`, `lifecycle_transitions`) mà API/FE đang dùng, thay thế hoàn toàn indexer RPC-scan hiện tại (`be/src/cli/runFactoryIndexer.ts` và `be/src/indexer/*`). Không mở rộng sang launchpad/chain khác, không đổi API công khai hay hành vi frontend.

## Quyết định đã chốt qua hội thoại (khác với spec gốc 2026-09-30)

- **Không giữ indexer cũ làm đường lùi sau cutover.** Spec gốc (mục 6) đề xuất "giữ code indexer cũ lại một thời gian làm đường lùi trước khi gỡ hẳn" — người dùng quyết định không giữ. Tắt hẳn indexer cũ ngay lúc cutover, không chạy song song thêm sau đó.
- **Đường lùi duy nhất:** không xóa code/migration của indexer cũ khỏi repo (vẫn nằm trong git history và có thể khôi phục nếu cần), nhưng sau cutover sẽ không có tiến trình indexer cũ nào chạy nền — nếu phát hiện sự cố, phải chủ động khởi động lại indexer cũ bằng tay (nó tự tiếp tục từ cursor đã lưu trong bảng `sources`, không mất tiến độ).
- **Không chờ Envio quét xong toàn bộ lịch sử mới cutover.** Quyết định cuối sau khi làm rõ cơ chế ghi: mọi hàm ghi của lớp đồng bộ dùng `onConflictDoNothing` — chỉ **thêm dòng chưa có**, không bao giờ xóa/ghi đè dữ liệu đã tồn tại trong bảng thật. Vì vậy dữ liệu lịch sử indexer cũ đã ghi (hàng nghìn launch, hàng trăm nghìn giao dịch tại thời điểm viết spec) **không biến mất** khi chuyển sang Envio, kể cả khi Envio chưa quét xong toàn bộ lịch sử. Hệ quả thật sự của việc cutover sớm chỉ là: **launch/giao dịch MỚI phát sinh sau khi tắt indexer cũ sẽ xuất hiện trễ**, cho tới khi Envio quét tuần tự tới đúng thời điểm đó (có thể nhiều giờ, tùy tốc độ quét đo được lúc thực thi) — không phải mất dữ liệu cũ. Xem mục 5 (điều kiện cutover đã cập nhật theo quyết định này) và rủi ro còn lại (chống reorg cho đoạn lịch sử Envio chưa quét tới).

## 1. Hai lỗ hổng chặn việc ghi thẳng vào bảng thật

Phát hiện khi đối chiếu cấu trúc bảng thật (`be/src/db/schema.ts`) với dữ liệu lớp đồng bộ Envio hiện có:

**(a) Thiếu dữ liệu metadata on-chain.** Bảng `launches` thật bắt buộc NOT NULL cho `name`, `symbol`, `quoteAssetSymbol`, `quoteAssetDecimals`. Lớp đồng bộ Envio hiện tại chỉ đọc được các trường có sẵn trong event (không gọi RPC bổ sung), nên các trường này đang để `null` trong bảng staging — sẽ bị Postgres từ chối nếu ghi thẳng vào bảng thật.

**(b) Thiếu "biên lai gốc" (`raw_logs`).** Bảng `launches`/`venues`/`trades` thật yêu cầu NOT NULL `sourceLogId` (khóa ngoại trỏ tới `raw_logs`, nơi indexer RPC-scan lưu lại log blockchain thô nó đọc được). Bảng `lifecycle_transitions` còn nặng hơn: `sourceLogId` chính là **khóa chính** của bảng. Lớp đồng bộ Envio không tạo ra các dòng `raw_logs` tương ứng (nó đọc entity đã giải mã sẵn của Envio, không có log thô gốc), nên không thể tạo khóa ngoại/khóa chính hợp lệ cho các bảng này.

Cả hai lỗ hổng này không phải giới hạn cố hữu — có cách giải quyết cụ thể ở mục 2 và 3.

## 2. Bổ sung đọc metadata on-chain vào lớp đồng bộ

Lớp đồng bộ (`be/src/envioSync/`) hiện tại chỉ kết nối tới 2 nguồn: Postgres của Envio (đọc) và Postgres của app (ghi) — không có client RPC. Bổ sung một viem `PublicClient` (dùng `RH_HTTP_RPC_URL`, đã có sẵn trong `be/.env.example`), rồi tái sử dụng trực tiếp các hàm đã có và đã kiểm thử của indexer RPC-scan:

- `readV1TokenMetadata(client, token)` — `be/src/launchpads/pons/v1/state.ts` — tên/ký hiệu/số thập phân token V1.
- `readV2TokenMetadata(client, token)` — `be/src/launchpads/pons/v2/adapter.ts` — tên/ký hiệu/số thập phân token V2 (lưu ý: `tokenDecimals` của token V2 tự nó luôn là 18, factory đảm bảo — xem comment hiện có ở `transformV2.ts`, không cần gọi RPC cho trường này).
- `resolveV2QuoteAsset(pairToken, client)` — `be/src/launchpads/pons/v2/adapter.ts` — ký hiệu/số thập phân tiền giao dịch, trừ trường hợp địa chỉ zero (ETH, đã biết sẵn không cần RPC, hàm tự xử lý case này).
- `readV1TokenMetadata` còn trả về `liquidityPool` — dùng để xác minh khớp với địa chỉ pool trong event (giống hệt indexer cũ đang làm qua `hydrateV1Launch`'s check) — lớp đồng bộ Envio nên tái sử dụng luôn phép xác minh này (hiện tại nó bị bỏ qua, truyền thẳng `liquidityPool: event.poolAddress` khiến check luôn đúng một cách hình thức — xem `be/src/envioSync/runSync.ts` dòng gọi `hydrateV1Launch`).

Các hàm này nhận một interface client tối giản (`readContract`) — một `createPublicClient` từ viem trỏ vào `RH_HTTP_RPC_URL` thỏa mãn interface này trực tiếp, không cần lớp bọc thêm.

**Vị trí gọi:** ngay trước khi insert một dòng `launches` mới (V1 hoặc V2) mà tên/ký hiệu đang unknown — gọi 1 lần, lưu kết quả luôn vào dòng đó (không gọi lại mỗi chu kỳ cho launch đã có đủ dữ liệu).

**Trường hợp RPC lỗi/token không chuẩn ERC20:** giữ nguyên hành vi lỗi của hàm gốc (ném lỗi) — chu kỳ sync bắt lỗi này giống mọi lỗi khác (log, thử lại chu kỳ sau), không chèn placeholder giả cho tên/ký hiệu.

**`v4PoolFee`/`v4TickSpacing`:** hai trường này nullable ở bảng thật, không bắt buộc. Không nằm trong phạm vi bắt buộc của spec này — để `null` là hợp lệ, có thể bổ sung sau (indexer RPC-scan đọc chúng từ factory-state tại thời điểm launch, cơ chế tương đương cho Envio nằm ngoài phạm vi; ghi `null` không vi phạm ràng buộc nào).

## 3. Thay đổi cấu trúc bảng thật (migration cộng thêm, không phá dữ liệu cũ)

Tất cả thay đổi dưới đây là **nới lỏng** (bớt ràng buộc), không xóa cột, không đổi kiểu dữ liệu của dữ liệu đã có — dòng dữ liệu cũ do indexer RPC-scan ghi giữ nguyên `sourceLogId` thật, không bị ảnh hưởng.

- `launches.sourceLogId`, `venues.sourceLogId`, `trades.sourceLogId`: bỏ `NOT NULL` — NULL sẽ không bị kiểm tra khóa ngoại (hành vi chuẩn của Postgres), cho phép dòng do Envio ghi để trống trường này.
- `lifecycleTransitions`: đổi khóa chính từ `sourceLogId` sang tổ hợp `(chainId, txHash, logIndex)` (giống cách bảng `trades` đang định danh duy nhất một log) — `sourceLogId` trở thành cột thường, nullable, giữ khóa ngoại khi có giá trị.
- `launches`: thêm cột mới `launchLogIndex` (integer, NOT NULL) — lý do và cách backfill ở mục 3a ngay dưới.
- Bảng `sources`: thêm các dòng đăng ký nguồn mới cho Envio (một lần, không lặp lại mỗi launch) — ví dụ `pons-v1-envio`, `pons-v2-envio`, `pons-v2-v4-envio` (hoặc theo đúng `sourceId` lớp đồng bộ Envio thực sự gán cho từng launch — xác nhận khi đọc code trong task, phải khớp chính xác giá trị `launches.sourceId`/`trades.sourceId` ghi ra, nếu không `launchCoverageSql` trong `be/src/api/store.ts` sẽ không khớp được) — để thỏa khóa ngoại `sourceId` NOT NULL. **Không phải giá trị tĩnh một lần:** `sources.status`/`confirmedToBlock` được `be/src/api/store.ts`'s `coverage()`/`launchCoverageSql` đọc trực tiếp để tính "launch này đã đủ dữ liệu chưa" hiển thị cho người dùng (`coverageStatus: 'caught_up' | 'backfilling'`) — đúng nguyên tắc CLAUDE.md "không được báo đã đủ dữ liệu khi chưa thật sự đủ". Lớp đồng bộ phải **cập nhật `confirmedToBlock`/`status` mỗi chu kỳ** theo đúng tiến độ Envio thực tế đã quét/xác nhận tới đâu (không phải giá trị cố định chèn một lần) — xem mục 7.

## 3a. API phân trang danh sách launch phụ thuộc `raw_logs` — phát hiện khi đọc code

`be/src/api/store.ts`'s `listLaunches` (endpoint danh sách launch, có phân trang) hiện lấy vị trí sắp xếp (`block_number, tx_hash, log_index`) bằng `JOIN raw_logs r ON r.id = l.source_log_id` — **INNER JOIN**, không phải LEFT JOIN. Một khi `launches.sourceLogId` được phép NULL (mục 3), launch nào có `sourceLogId = NULL` sẽ **bị loại hoàn toàn khỏi kết quả** của endpoint này — không lỗi, không cảnh báo, chỉ biến mất khỏi danh sách FE hiển thị. Đây là lỗi nghiêm trọng nếu không sửa, vì nó vô hiệu hóa toàn bộ mục tiêu của spec này (launch do Envio ghi sẽ không hiển thị được).

**Cách sửa:** thêm cột `launches.launchLogIndex` (mục 3), để launch tự mang theo đủ vị trí sắp xếp của chính nó (`launchBlock` + `launchTxHash` đã có sẵn, chỉ thiếu log index) — không cần mượn qua `raw_logs` nữa. Migration backfill giá trị này cho dữ liệu cũ bằng chính `raw_logs` đang có (`UPDATE launches SET launch_log_index = r.log_index FROM raw_logs r WHERE r.id = launches.source_log_id`), rồi đặt NOT NULL. Sửa câu truy vấn trong `listLaunches` bỏ hẳn `JOIN raw_logs`, dùng `l.launch_block, l.launch_tx_hash, l.launch_log_index` trực tiếp thay cho `r.block_number, r.tx_hash, r.log_index`. Áp dụng chung cho mọi launch (cả của indexer cũ lẫn Envio), không phải nhánh riêng theo nguồn dữ liệu.

Đã rà toàn bộ `be/src/api/` — đây là **chỗ duy nhất** phụ thuộc `raw_logs` theo kiểu loại-bỏ-dòng-khi-thiếu như vậy (endpoint giao dịch dùng cột riêng sẵn có của bảng `trades`, không bị ảnh hưởng; `getLaunch` — tra cứu một launch — không join `raw_logs`).

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

**Không chờ Envio quét xong toàn bộ lịch sử** (xem quyết định ở đầu spec) — vì `onConflictDoNothing` đảm bảo dữ liệu cũ không mất. Điều kiện chỉ xoay quanh **code mới đã đúng và kiểm thử kỹ**, không xoay quanh tiến độ quét:

1. Bổ sung metadata (mục 2) đã có test đơn vị, xác nhận launches mới (trong phạm vi Envio đã quét) có đầy đủ tên/ký hiệu đúng như indexer cũ từng cung cấp — đối chiếu trên vài launch thật đã biết trước.
2. Migration mục 3 đã chạy thành công trên DB test, xác nhận dữ liệu cũ (sourceLogId thật) không bị ảnh hưởng, dữ liệu mới (sourceLogId null) ghi được — trước khi áp dụng lên DB thật.
3. Cơ chế chống reorg (mục 4) đã triển khai, có test đơn vị, và đã chạy ít nhất vài chu kỳ trên staging xác nhận hoạt động đúng (không xóa oan dữ liệu ngoài cửa sổ — xem lưu ý ở mục 4) trước khi áp dụng cho bảng thật.
4. Lớp đồng bộ đã thử ghi thành công vào bảng thật trên DB test (tích hợp, mục 8) — không chỉ chạy đơn vị.

**Rủi ro đã biết, chấp nhận theo quyết định của người dùng (không phải điều kiện chặn):** trong khoảng thời gian Envio còn quét từ vị trí hiện tại tới khối an toàn hiện tại (ước tính nhiều giờ, đo thực tế lúc thực thi), (a) launch/giao dịch mới phát sinh trong khoảng đó xuất hiện trễ cho tới khi Envio quét tới, và (b) đoạn lịch sử indexer cũ đã ghi nhưng Envio CHƯA quét lại tới (vẫn còn trong bảng thật, nguyên vẹn) tạm thời không có cơ chế giám sát reorg nào theo dõi — vì indexer cũ đã tắt và cơ chế chống reorg mới (mục 4) chỉ hoạt động trên phần Envio đã quét tới. Rủi ro này tự hết khi Envio quét xong và cơ chế chống reorg theo kịp toàn bộ.

## 6. Quy trình cutover

Thực hiện theo đúng thứ tự, không đảo bước, mỗi bước xác nhận xong mới sang bước kế:

1. Xác nhận đủ 4 điều kiện ở mục 5 (code đã đúng và kiểm thử — không chờ Envio quét xong lịch sử).
2. Dừng indexer RPC-scan cũ (`runFactoryIndexer.ts`) — dừng sạch, không kill cứng giữa một batch đang ghi dở.
3. Đổi lớp đồng bộ từ ghi vào bảng staging sang ghi thẳng vào bảng thật (tái sử dụng gần như nguyên vẹn logic hiện có — xem mục 7).
4. Chạy lớp đồng bộ một chu kỳ, kiểm tra API/FE vẫn trả về đúng dữ liệu như trước khi cutover (so sánh thủ công vài launch/trade cụ thể) — xác nhận không có lỗi ghi (vi phạm ràng buộc, v.v.) trên dữ liệu thật thay vì chỉ trên DB test.
5. Bật vòng lặp sync liên tục (`sync:envio-staging:loop`, đổi tên/đích phù hợp) chạy nền thay thế hoàn toàn vai trò của indexer cũ.

**Không có giai đoạn chạy song song sau bước 2** — theo đúng quyết định đã chốt ở đầu spec này. Nếu bước 4 phát hiện vấn đề, dừng lớp đồng bộ, khởi động lại indexer cũ bằng tay (tự tiếp tục từ cursor đã lưu), xử lý lỗi trước khi thử cutover lại.

## 7. Lớp đồng bộ chuyển hướng ghi

Các hàm `syncV1LegacyOnce`/`syncV2Once`/`syncV4Once` hiện tại import trực tiếp các Drizzle schema object của bảng staging (`launchesEnvioStaging`, `venuesEnvioStaging`, v.v.). Việc đổi đích ghi thực hiện bằng cách tham số hóa bảng đích đầu vào (không viết lại logic nghiệp vụ), theo đúng pattern tên bảng Envio raw đã tham số hóa sẵn (`EnvioTableNames`/`EnvioV2TableNames`/`EnvioV4TableNames`) — làm tương tự cho phía ghi. Chi tiết interface cụ thể xác định ở kế hoạch triển khai.

**Cập nhật `sources.confirmedToBlock`/`status` mỗi chu kỳ:** sau mỗi lần sync thành công, lớp đồng bộ phải tự cập nhật dòng `sources` tương ứng (mục 3) với khối cao nhất nó vừa xác nhận xong cho nguồn đó — để `be/src/api/store.ts`'s `coverage()`/`launchCoverageSql` phản ánh đúng thực tế, không báo "đã đủ dữ liệu" sớm hơn thật.

## 8. Kiểm thử

- Đơn vị: hàm metadata-enrichment (mục 2) — test với client RPC giả lập (mock `readContract`), không gọi RPC thật trong unit test.
- Đơn vị: hàm chống reorg (mục 4) — test với dữ liệu giả lập mô phỏng một dòng "biến mất" khỏi bảng raw giữa 2 chu kỳ, xác nhận dòng phái sinh tương ứng bị xóa đúng.
- Tích hợp: migration mục 3 chạy trên DB test, xác nhận dữ liệu cũ (sourceLogId thật) không bị ảnh hưởng, dữ liệu mới (sourceLogId null) ghi được; xác nhận `launchLogIndex` backfill đúng từ `raw_logs` cho dữ liệu cũ.
- Tích hợp: `listLaunches` (mục 3a) trả về đúng cả launch có `sourceLogId` null lẫn launch cũ có `sourceLogId` thật, đúng thứ tự phân trang.
- Tích hợp: lớp đồng bộ ghi thẳng vào bảng thật (không phải staging) trên DB test — mở rộng từ các test tích hợp hiện có của `runSync.ts`/`runSyncV2.ts`/`runSyncV4.ts`, đổi đích bảng.
- Vận hành thật: đối chiếu theo mục 5-6, không phải test tự động một lần mà là quy trình có ghi log kết quả từng lần chạy.

## 9. Ngoài phạm vi đặc tả này

- Gỡ bỏ code indexer RPC-scan (`be/src/indexer/*`, `be/src/cli/runFactoryIndexer.ts`) khỏi repo — giữ nguyên trong code, chỉ ngừng chạy. Việc xóa hẳn (nếu muốn) là quyết định riêng, sau khi Envio đã chạy ổn định một thời gian đủ dài trong thực tế.
- `v4PoolFee`/`v4TickSpacing` qua RPC bổ sung cho launch mới — để `null`, không bắt buộc (mục 2).
- Launchpad khác, chain khác, ví/giao dịch thật — ngoài phạm vi theo CLAUDE.md, không đổi bởi spec này.
- Dùng Envio Cloud (managed) — vẫn tự host, không đổi.
