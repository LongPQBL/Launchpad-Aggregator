# Đặc tả bổ sung — Vòng đời Pons V2 và giao dịch pool V4 chính thức

**Ngày:** 29/09/2026

**Trạng thái:** Đã duyệt cho vòng đời Pons V2; backend đã triển khai, lịch sử toàn chain và giá curve cũ chưa xác minh đủ. Quyết định loại hẳn “Pools khác” trong tài liệu cũ đã bị chủ dự án hủy ngày 04/10/2026.

**Phụ thuộc:** [Đặc tả Pons chỉ đọc](2026-09-28-pons-readonly-design.md). Tài liệu này cụ thể hóa phần backend còn thiếu; không mở rộng sang mua/bán hoặc sàn/chain khác.

## 1. Mục tiêu và phạm vi

Với một token Pons V2 trên Robinhood, app phải hiển thị đúng chuỗi `Trading on curve → Swept → PoolCreated` hoặc `Trading on curve → Swept → Rescued`; kết hợp giao dịch curve và pool V4 **chính thức** thành lịch sử token, chart và volume không đếm trùng. `Swept` có thể kéo dài không xác định; khoảng không có giao dịch không được sinh nến hoặc volume giả. Giá giao dịch cuối, nếu hiển thị, phải ghi rõ là giá cũ.

**Phạm vi của phần vòng đời Pons V2:** phần này chỉ xác minh và ghép curve với pool V4 do Pons tạo. Mục Pools của sản phẩm sẽ khám phá, lập chỉ mục và hiển thị các pool khác trong một phần việc riêng, dùng Envio và hệ thống giá USD chung. Không trộn giao dịch pool khác vào metric được gắn nhãn venue do Pons chỉ định; metric toàn bộ pool, nếu hiển thị, phải có nhãn riêng.

## 2. Phương án được chọn

Lưu sự kiện chuyển trạng thái bất biến gắn với raw log, rồi dựng trạng thái/nơi giao dịch từ lịch sử đó. Đây là phương án được chọn vì có thể tua lại chính xác khi reorg và giải thích được chart lịch sử. Hai phương án không chọn: (1) chỉ hỏi `phase` hiện tại của factory — không cho biết khoảng chờ hay ranh giới quá khứ; (2) cập nhật đè `launches.lifecycleStatus` và `venues.effectiveToBlock` mà không lưu nguồn/undo — dễ sai khi reorg hoặc quét lại.

`getLaunchedToken(token).phase` vẫn là nguồn có thẩm quyền cho **trạng thái hiện tại** theo tài liệu Pons. Lịch sử sự kiện giải thích các mốc đã xảy ra; hai nguồn phải được đối chiếu ở cùng một block đã xác định khi có RPC phù hợp. Nếu chưa thể đối chiếu, trạng thái/độ bao phủ là đang xác minh, không tuyên bố dữ liệu hoàn chỉnh. Không dùng phase mới nhất lúc hydrate `TokenLaunched` để biến một launch trong quá khứ thành launch đã tốt nghiệp ngay tại block tạo.

## 3. Thành phần và dữ liệu

- `pons/v2` giải mã `LaunchSwept`, `PoolGraduated`, `LaunchGraduationRescued`. `LaunchForceSwept` chỉ làm rõ nguyên nhân của sweep, không tạo thêm một phase. Decoder thuần không ghi DB. Dùng `getLaunchedToken` để lấy cấu hình bất biến (token, curve, quote, fee, tick spacing) và quan sát phase ở block xác định.
- `indexer` có nguồn quét lifecycle riêng từ block triển khai factory V2, để cursor cũ của nguồn `TokenLaunched` không che khuất sự kiện lịch sử. Nguồn launch phải đi trước nguồn lifecycle đến cùng mốc block; nếu gặp transition của token chưa có launch, tạm dừng range đó và quét bù launch thay vì bỏ qua. Log, transition và checkpoint của cùng block range được commit nguyên tử; thất bại hoặc log không khớp đưa nguồn vào `degraded`/ghi gap, không âm thầm tiến cursor.
- `db` lưu transition theo chain/token, phase sau chuyển trạng thái, block/hash, `logIndex` và `sourceLogId` tham chiếu raw log. Thứ tự là `(blockNumber, logIndex)`, không chỉ block. `launches.lifecycleStatus` nếu còn tồn tại chỉ là projection/cache có thể dựng lại; không là nguồn sự thật độc lập. Tương tự, ranh giới venue được suy ra từ log, không phụ thuộc cập nhật đè không thể hoàn tác.
- Pool V4 chỉ được đăng ký khi `PoolGraduated` khớp với `PoolManager.Initialize` của cùng transaction/block, đúng pool ID tính từ token/quote/fee/tick spacing/hook của launch và đúng PoolManager Robinhood. V4 venue tham chiếu raw log `Initialize`; transition phase 2 tham chiếu raw log `PoolGraduated`, để lần theo cả hai chứng cứ. Mốc bắt đầu hiệu lực là `Initialize.logIndex`, vì Initialize có thể đứng trước PoolGraduated trong cùng transaction. Mốc kết thúc curve là `LaunchSwept.logIndex`; các trade được xác thực theo đúng `(blockNumber, logIndex)`.
- Nguồn swap V4 lọc `PoolManager.Swap` theo pool ID chính thức, không quét mọi pool theo token. Mỗi pool có checkpoint từ block Initialize của chính nó và khoảng thiếu riêng. Có thể gom pool ID thành các nhóm truy vấn RPC để giảm request, miễn mỗi pool vẫn có watermark độc lập; pool phát hiện muộn phải quét bù từ block khởi tạo. Trade, raw log và checkpoint lưu trong cùng transaction. Khóa định danh log ngăn đếm trùng khi replay.
- API chỉ lấy launch, venue và trade đã chuẩn hóa từ DB. Danh sách hiển thị volume chính thức 24 giờ; chi tiết token trả giao dịch/biểu đồ hợp nhất curve→V4, các mốc vòng đời và độ bao phủ từng nguồn. Không thêm API cho pool phụ.

## 4. Luồng và xử lý tình huống đặc biệt

1. `TokenLaunched`: ghi launch ở phase 0 và curve chính thức. Đọc phase hiện tại chỉ để đối chiếu riêng, không ghi ngược vào lịch sử launch.
2. `CurveBuy`, `CurveSell`, `BuybackLocked`: ghi giao dịch curve nếu khớp thật; phân loại buyback Pons; không biến event phí/refund thành trade. Giao dịch cuối có thể trước `LaunchSwept` khá lâu khi curve đã đạt ngưỡng.
3. `LaunchSwept`: ghi mốc phase 1. Không tạo V4 venue hoặc nến. `LaunchForceSwept` cùng transaction không cộng thêm một transition.
4. `PoolGraduated` + `Initialize` xác thực: ghi mốc phase 2, mở V4 venue tại Initialize. `LaunchGraduationRescued` thay vào đó ghi phase 3 và không mở pool.
5. `Swap` đúng pool ID sau Initialize: ghi trade; swap nội bộ thực khớp của Pons vẫn tăng volume một lần, nhưng nhãn nguyên nhân chỉ được dùng khi có bằng chứng. Swap pool khác bị loại. Nến từ giá sau giao dịch, không từ giá seed pool. Chart không có nến trong khoảng chưa có trade. Giai đoạn hiện tại dựng trang nến trực tiếp từ trade đã lập chỉ mục, có chỉ mục `(chain, token, timestamp)`; chưa materialize nến vì cần cơ chế làm bẩn bucket an toàn khi reorg. Nếu một bucket có trade chưa xác minh giá, bỏ bucket đó và báo chart chưa đầy đủ.
6. Mọi truy vấn chart/volume cần biết nguồn curve, lifecycle và V4 liên quan đã quét đủ khoảng yêu cầu. Nếu thiếu, trả `complete=false`/metric `null` hoặc trạng thái đang đồng bộ; không trình bày tổng tạm thời như kết quả đầy đủ.

Khi reorg, xoá raw log của block bị thay và các transition/trade phụ thuộc; nếu `Initialize` bị rút thì V4 venue và swap của pool đó cũng phải bị rút hoặc đánh dấu chưa xác thực. Dựng lại projection trạng thái, ranh giới venue và nến từ log còn hợp lệ rồi quét bù. Reorg qua cùng block chứa curve trade, sweep và pool creation phải cho kết quả giống một lượt quét sạch.

## 5. Giới hạn và lỗi

RPC công khai có thể giới hạn `eth_getLogs` hoặc không phục vụ `eth_call` ở block cũ. Quét bằng dải block thích nghi, retry có giới hạn, ghi gap và giữ checkpoint nguyên tử. Nếu không thể xác minh phase tại block an toàn hoặc giá curve lịch sử qua state archive/đối chiếu độc lập, API công khai chỉ trạng thái/biểu đồ chưa đủ độ bao phủ và ghi rõ cần provider archive; không tự suy đoán. SSE chỉ thông báo thay đổi; HTTP/DB là nguồn dữ liệu có thể khôi phục sau mất kết nối.

## 6. Kiểm thử và tiêu chí nghiệm thu

- Unit tests: event hợp lệ/không hợp lệ, phase 0→1→2 và 0→1→3, force-sweep không trùng, Initialize khớp pool ID/hook/transaction, swap đúng/sai pool, log cuối curve và đầu V4 trong cùng block, buyback/fee conversion chỉ đếm một lần.
- Integration tests PostgreSQL: transition+checkpoint nguyên tử, replay idempotent, pool phát hiện muộn được backfill riêng, lịch sử `Swept` không có nến giả, coverage từng nguồn, reorg rút transition/venue/trade và dựng projection/nến đúng.
- Fixture thực: launch Pons V2 đã tốt nghiệp trên Robinhood với giao dịch curve, `PoolGraduated`, `Initialize` và `Swap` V4 được đối chiếu địa chỉ/tx/log nguồn. Đây là đối chiếu mẫu, **không** chứng minh toàn bộ lịch sử đã quét đủ.
- Chạy lint, typecheck, unit/integration tests, build và OpenAPI check. Chỉ gọi phần backend này hoàn thành khi các nguồn lifecycle/V4 đã quét tới mốc an toàn có thể kiểm chứng hoặc báo rõ gap/provider chưa đủ; không dùng 1 fixture để tuyên bố hoàn tất lịch sử.

## Nguồn chính

- [Mã nguồn Pons V2 Launch Factory](https://github.com/ponsdotdev/pons-labs/blob/main/contractsV2/src/v2/PonsV2LaunchFactory.sol)
- [Tài liệu Pons V2 về phase và vòng đời](https://docs.ponsfamily.com/v2)
- [Uniswap v4 PoolManager](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)
