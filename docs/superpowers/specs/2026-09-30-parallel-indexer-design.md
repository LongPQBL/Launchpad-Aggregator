# Đặc tả — Indexer song song cho dữ liệu mới và backfill lịch sử

**Ngày:** 30/09/2026

**Trạng thái:** Đã chốt hướng thiết kế; triển khai theo yêu cầu của người dùng

**Phạm vi:** Indexer Pons V1/V2 trên Robinhood hiện có; không thêm sàn, chain, pool phụ hay chức năng giao dịch.

## 1. Mục tiêu và ràng buộc

Token mới phải xuất hiện sớm ngay khi các block gần head đã được xác nhận, trong khi lịch sử tiếp tục được backfill song song. Không gọi chart, volume, danh sách trade hoặc trạng thái vòng đời là đầy đủ nếu thiếu khoảng block hoặc thiếu danh sách pool cần quét. Mọi giao dịch on-chain chỉ được tính một lần. Chạy được trên máy local, một PostgreSQL và các RPC hiện có; số worker/config RPC phải điều chỉnh được mà không thay đổi adapter Pons hay API công khai của sàn/chain khác về sau.

Một worker không đồng nghĩa một tiến trình riêng. Giai đoạn đầu dùng một tiến trình với hàng đợi PostgreSQL và concurrency có giới hạn; cấu trúc lease cho phép tách nhiều tiến trình về sau. Không tạo job không giới hạn, không giả định tăng concurrency luôn tăng throughput. Endpoint shared đã đo được giới hạn `eth_getLogs` khoảng 2.000 block theo hiệu số `toBlock - fromBlock`; cấu hình mặc định dùng tối đa 2.000 block **bao gồm cả hai đầu** cho mỗi request để có biên an toàn. Khóa RPC chỉ lấy từ environment, không ghi vào log, DB hoặc repo.

## 2. Vì sao cần hai lớp công việc

Trade tại block `b` có thể thuộc pool được tạo trước `b`. Truy vấn logs theo địa chỉ chỉ đầy đủ nếu đã biết mọi pool chính thức tồn tại đến cuối khoảng đang quét. Vì vậy job factory/launch ở các khoảng lịch sử có thể chạy song song và lưu kết quả ngay; job trade của khoảng `[a,b]` chỉ được chứng nhận đầy đủ khi factory đã phủ liên tục từ block triển khai đến `b`. Lifecycle V2 cần launch tương ứng; V4 cần thêm transition và `Initialize` đã xác minh. Không suy ra pool chính thức chỉ từ cùng địa chỉ token.

Luồng gần head quét factory của một cửa sổ mới để hiển thị launch mới. Nó có thể quét trade/lifecycle cho những venue đã biết, nhưng kết quả này là **tạm thời**, không chứng nhận độ bao phủ của cả nguồn vì pool/token lịch sử còn chưa biết. Khi tiền đề lịch sử được đáp ứng, cùng cửa sổ được quét lại để chứng nhận; khóa log/trade on-chain ngăn cộng trùng. Nếu chưa biết pool cũ, API phải báo trade/chart/volume chưa đầy đủ, không coi không có trade là volume bằng 0.

## 3. Mô hình lưu trữ và hợp nhất

- Giữ source ID logic hiện có (`pons-v1-active`, `pons-v1-active-trades`, `pons-v2-lifecycle`, từng pool V4, v.v.) làm provenance của raw log và bản ghi chuẩn hóa. Không tạo source ID giả cho từng worker hay từng lane.
- Thêm job theo khóa `(source_id, lane, from_block, to_block)`, trong đó `lane = certified | provisional`, với trạng thái `pending | leased | complete | failed`, số lần thử, hạn lease, thế hệ reorg và thông tin lỗi đã che URL. Khoảng job dùng quy ước `[from_block, to_block]`. Các job `certified` của cùng nguồn không chồng nhau; job `provisional` được phép trùng khoảng với job `certified` vì nó sẽ được quét lại. Các request RPC bên trong job có thể chia nhỏ hơn giới hạn provider.
- Lưu batch dữ liệu và đánh dấu khoảng `complete` trong cùng transaction. Worker nhận job bằng lease có hạn; hết lease thì job có thể được nhận lại. Transaction kiểm tra thế hệ reorg và quyền lease trước khi commit. Replay phải idempotent theo `(chain_id, block_hash, tx_hash, log_index)` cho raw log và khóa trade hiện có; không ghi đè dữ liệu mâu thuẫn âm thầm.
- `sources.scanned_to_block`/`confirmed_to_block` tiếp tục biểu diễn **tiền tố liên tục** từ `start_block`, không nhảy qua khoảng thiếu chỉ vì job ở block mới đã xong. Các khoảng hoàn tất rời rạc nằm ở bảng coverage. Di chuyển cursor hiện có thành một khoảng đã hoàn tất trong migration, giữ nguyên raw log/launch/trade và các `source_gaps` chưa giải quyết. Migration có kiểm tra tính nhất quán trước khi scheduler mới chạy.
- Job `provisional` hoàn tất chỉ chứng minh đã quét những địa chỉ đang biết; nó không tạo khoảng coverage được chứng nhận, không mở khóa job phụ thuộc và không đổi status nguồn thành `caught_up`. Job `certified` sau đó quét lại, hợp nhất cùng raw event và tạo coverage hoàn chỉnh mà không nhân đôi trade.

## 4. Lịch chạy và tối ưu throughput

1. Lấy safe head và dành quota/concurrency riêng cho job gần head; backfill dùng phần còn lại. Dùng ưu tiên có giới hạn để backfill không bị bỏ đói khi head liên tục tăng. Không chạy hai scheduler cùng ghi cùng job nếu chưa có lease/khóa hợp lệ.
2. Chia factory thành các khoảng độc lập và xử lý song song trong giới hạn endpoint. Khi một tiền tố factory đã hoàn tất, mở các job lifecycle/trade phụ thuộc đến mốc đó; không đợi toàn bộ lịch sử chain. Sau lifecycle, đăng ký pool V4 chính thức và mở job V4 từ block `Initialize` của từng pool. Các pool V4 được xử lý song song có giới hạn thay cho vòng tuần tự hiện tại.
3. Với mỗi job trade `[a,b]`, chỉ truy vấn pool có `effectiveFromBlock <= b` và chưa kết thúc trước `a`; giữ ranh giới `logIndex` để decoder loại trade ngoài venue chính thức trong block tạo/kết thúc. Pool tạo ngay trong job không được bỏ sót. Tính danh sách này một lần cho job, không gửi mọi pool tương lai vào từng request. V1 pool hiện không có `effectiveToBlock`; V2 curve có thể kết thúc khi sweep, nên số pool đủ điều kiện không nhất thiết tăng mãi.
4. Chia job theo **ước lượng chi phí** từ số pool đủ điều kiện × số block và dữ liệu đo thực tế. Khoảng nhiều pool có thể ngắn hơn; mọi request vẫn dưới giới hạn RPC. Hàng đợi phân phối job theo worker còn rảnh, không cố định một nửa lịch sử cho một worker, để job nặng không kéo dài toàn bộ đợt.
5. Quản lý concurrency/rate limit theo endpoint, gồm các trade RPC riêng và shared RPC cho factory/lifecycle/V4. Giảm tải và retry khi gặp 429/timeout; không tiếp tục đẩy thêm request trong cửa sổ rate-limit. Ghi metric thời gian/job, số request, số log, địa chỉ/pool, retry, 429 và block/giây để điều chỉnh bằng phép đo. Thử JSON-RPC batch/multicall cho metadata trên một mẫu hữu hạn trước khi áp dụng; chỉ giữ nếu provider hỗ trợ và thời gian tổng giảm mà kết quả dữ liệu không đổi.

Quan sát nền 30/09/2026: ở gần cursor `pons-v1-active-trades`, chỉ 129 pool V1-active đã tồn tại trong khi truy vấn hiện tại đưa khoảng 82.076 pool vào danh sách địa chỉ. Một vòng ngân sách 50.000 block với 30 pool V4 tuần tự mất khoảng 16 phút. Đây là số đo ban đầu, không phải cam kết tốc độ sau tối ưu; benchmark phải đo lại với cùng khoảng block và cùng RPC.

## 5. API, reorg và lỗi

API giữ provenance Pons/Robinhood và chỉ pool chính thức. Coverage phải phân biệt `complete`, `provisional` và `missing` theo nguồn/khoảng; danh sách token có thể hiện launch mới khi lịch sử thiếu, nhưng metric phụ thuộc cửa sổ 24 giờ chỉ được công bố là đầy đủ nếu factory, lifecycle và mọi nguồn trade/venue chính thức liên quan đã phủ toàn bộ cửa sổ đó đến safe head. Chart có thể trả nến đã biết kèm `complete=false` và khoảng thiếu; không chèn nến giả hoặc biến thiếu dữ liệu thành volume 0. Giá/phase chưa xác minh giữ trạng thái chưa xác minh như đặc tả Pons V2.

Khi phát hiện reorg, scheduler tạm ngừng commit ở vùng ảnh hưởng, tăng thế hệ reorg, thu hồi job lease, rút dữ liệu từ fork block theo provenance và đánh dấu các khoảng giao với vùng bị thay là cần quét lại. Job phụ thuộc có thể đã dùng danh sách pool cũ cũng phải được xác nhận lại hoặc quét lại. Worker giữ thế hệ cũ không được commit sau khi reorg đã xử lý. Không tuyên bố hoàn chỉnh sau một reorg cho đến khi các khoảng phụ thuộc được xác nhận lại.

RPC lỗi/historical gap chỉ làm job liên quan `failed` và ghi gap; job độc lập tiếp tục. Không để lỗi một job tạo khoảng trống vô hình hoặc làm toàn bộ indexer dừng. Retry hữu hạn, backoff theo 429, có thể chạy lại thủ công. Log vận hành ghi source/job/latency nhưng không ghi URL có khóa.

## 6. Kiểm thử và nghiệm thu

- Unit: planner chỉ mở trade khi factory prefix đủ; pool tạo đúng đầu/cuối job được truy vấn; pool tương lai không bị truy vấn; V2 curve kết thúc được lọc đúng; job nặng được chia nhỏ; giới hạn request và ưu tiên head/backfill không gây starvation.
- Integration PostgreSQL: hai worker nhận job khác nhau; lease hết hạn/replay không nhân đôi log, trade, volume; batch và coverage commit nguyên tử; migration giữ cursor/gap; job hoàn tất lệch thứ tự chỉ nâng contiguous cursor khi khoảng trống được lấp; trạng thái tạm thời không mở khóa job phụ thuộc.
- Reorg: fork ở giữa hai job hoặc trong block chứa launch/transition/Initialize/trade; worker thế hệ cũ bị từ chối; projection sau quét lại bằng kết quả một lượt quét sạch; không để lại nến hoặc volume từ nhánh cũ.
- API: launch mới hiện khi backfill còn thiếu; trade/chart/volume có coverage đúng từng cửa sổ; giá trị `null`/`complete=false` khi chưa đầy đủ; khi backfill nối đủ các khoảng, cùng dữ liệu trở thành hoàn chỉnh mà không đổi số lượng trade.
- Benchmark trên cùng mẫu block/RPC: ghi baseline và kết quả sau từng tối ưu cho thời gian lấy launch mới, block/giây backfill, request/giây, tỷ lệ 429, số job lỗi và thời gian một vòng. Không tăng worker nếu throughput không tăng. Chạy test, integration test, lint, typecheck và build trước khi chuyển tiến trình đang chạy sang scheduler mới.

## 7. Thứ tự triển khai dự kiến

1. Metric và bộ chọn pool theo khoảng block (tác động lớn, dễ kiểm chứng).
2. Job/coverage/lease và migration từ cursor liên tục hiện tại.
3. Scheduler backfill song song với dependency frontier và quota theo endpoint; V4 song song có giới hạn.
4. Luồng gần head tạm thời, reconciliation để nâng thành coverage hoàn chỉnh, API coverage theo cửa sổ.
5. Reorg race tests, benchmark đối chiếu kết quả và chuyển tiến trình bằng restart có kiểm soát. Không chạy đồng thời indexer cũ và mới ghi cùng DB.

Các bước 1–4 phải chia thành các phần triển khai nhỏ có test đỏ trước, đo hiệu quả sau mỗi phần; nếu provider không tăng throughput khi tăng concurrency thì giữ giới hạn thấp hơn thay vì cố song song hóa.
