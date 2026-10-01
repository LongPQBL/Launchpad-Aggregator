# Đặc tả bổ sung — Các trường thống kê kiểu Uniswap Launches (USD, FDV, TVL, 52W High/Low)

**Ngày:** 01/10/2026

**Trạng thái:** Đã duyệt hướng đi (oracle, phạm vi tính toán, Market cap = FDV); chưa triển khai.

**Phụ thuộc:** [Đặc tả Pons chỉ đọc](2026-09-28-pons-readonly-design.md), [Đặc tả vòng đời V2](2026-09-29-pons-v2-lifecycle-design.md). Tài liệu này chỉ thêm các trường hiển thị mới dựa trên dữ liệu đã có + 1 nguồn giá mới; không đổi mô hình dữ liệu curve/V4/vòng đời đã thống nhất, không thêm wallet/mua-bán.

## 1. Mục tiêu và phạm vi

FE (trang danh sách và trang chi tiết launch) hiện thiếu một số trường mà Uniswap Launches có: giá trị quy đổi USD trong bảng giao dịch, FDV, Market cap, TVL/Liquidity, và 52W High/Low. Mục tiêu: thêm các trường này, **chỉ khi tính được chính xác hoặc ước tính có ghi chú rõ ràng**, không bịa số liệu.

**Không làm trong phạm vi này:** Holders (bị loại bỏ — cần pipeline index `Transfer` riêng, chi phí lớn so với giá trị). Mục "About" (mô tả token/website/Twitter) — chưa rõ Pons có nguồn metadata nào hay không, cần một spike nghiên cứu riêng trước, không đưa vào spec này.

## 2. Nguồn giá USD

Robinhood Chain dùng Chainlink làm oracle giá chính thức (đã xác minh trực tiếp qua RPC thật, không phải tài liệu suông):

- `ETH/USD`: proxy `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`, 8 decimals. Gọi `latestRoundData()` ngày 01/10/2026 trả về **$2,691.70**, cập nhật cách lúc gọi vài phút.
- `USDC/USD`: proxy `0x9e6f4605992a899eE2999999F3Ec80C41F452546`.
- `USDT/USD`: proxy `0xbf3550B6fAe1671da7C238Af12e03Ac586BEf3B1`.
- Đọc qua `AggregatorV3Interface.latestRoundData()`, **miễn phí** (view call RPC thường, không cần API key/subscription) — không cần hạ tầng trả phí mới.

Nguồn: [Robinhood Chain — Oracles & Price Feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [Chainlink Price Feed Addresses](https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood).

Nếu tài sản ghép cặp của 1 launch không khớp ETH/USDC/USDT (ví dụ `SPCX` thấy trong dữ liệu mẫu — token cổ phiếu hoá của Robinhood), **không quy đổi USD cho launch đó** — trả `null`, không ước tính bằng tỷ giá sai.

## 3. Phương án được chọn

Thêm 2 module mới trong `be/src/market/`:

- `usdPricing.ts`: đọc 3 feed Chainlink qua `createRobinhoodPublicClient` (đã có sẵn ở `be/src/chains/robinhood.ts`), cache trong bộ nhớ tiến trình ~60 giây theo từng feed (giá không cần tức thời tuyệt đối; tránh gọi RPC lặp lại mỗi request). Trả `null` nếu feed không khớp quote asset.
- `tokenStats.ts`: đọc `totalSupply()` (ERC-20 chuẩn) cho FDV, và đọc liquidity/reserve cho TVL theo loại venue (xem mục 4). **Chỉ tính cho launch đang được trả về trong request hiện tại** (trang danh sách đang xem — khoảng 20-50 dòng — hoặc 1 launch đang xem chi tiết), không quét nền cho toàn bộ 166K+ launch. Đây là quyết định đã chốt để tránh đúng vấn đề tải RPC/tài nguyên đã gặp nhiều lần trong quá trình vận hành Envio.

Phương án không chọn: tính sẵn và lưu vào DB cho mọi launch qua một job nền — bị loại vì chi phí RPC/thời gian quét 166K+ launch quá lớn so với giá trị (phần lớn launch cũ không ai xem).

## 4. Từng trường cụ thể

| Trường | Công thức | Nguồn dữ liệu | Trạng thái |
|---|---|---|---|
| 52W High/Low | `MAX(high)` / `MIN(low)` từ bảng `candles`, trong 52 tuần gần nhất hoặc từ lúc launch nếu ngắn hơn | DB có sẵn, không cần RPC | Sẵn sàng triển khai |
| Cột USD trong bảng giao dịch | `quoteAmount × giá quote-asset/USD hiện tại` | `usdPricing.ts` | Sẵn sàng, **phải ghi chú là ước tính theo giá hiện tại** (xem mục 5) |
| FDV | `totalSupply() × giá token tính theo quote-asset × giá quote-asset/USD` | RPC `totalSupply()` (ERC-20 chuẩn) + giá hiện tại đã có + `usdPricing.ts` | Sẵn sàng triển khai |
| Market cap | **= FDV**, không tách circulating supply | — | Đã quyết định: Uniswap tự hiển thị Market cap = FDV cho đúng loại token launch này (xác minh qua 2 ví dụ thật: Boner Coin $42.4M/$42.4M, token khác $159.8M/$159.8M) — hợp lý vì mô hình bonding curve đúc toàn bộ cung ngay lúc launch, không vesting nhỏ giọt |
| TVL / Liquidity (venue V4 pool) | Đọc qua Uniswap V4 `PoolManager`/`StateView` (đọc chuẩn, pool ID đã có sẵn trong `venues.ref`) | RPC mới, theo pattern Uniswap V4 đã dùng ở `v2/v4Swaps.ts` | Sẵn sàng triển khai |
| TVL / Liquidity (venue V3 pool, Pons V1) | Đọc qua `liquidity()`/`slot0()` chuẩn Uniswap V3 | RPC mới | Sẵn sàng triển khai |
| TVL / Liquidity (venue curve, trước khi tốt nghiệp) | Chưa xác định | **Cần nghiên cứu thêm**: hợp đồng curve Pons (`venues.ref` cho `kind='curve'`) có hàm `view` trả về reserve hiện tại hay không — ABI hiện có (`v2FactoryStateAbi`) không có hàm này. Chưa xác nhận | **Không triển khai trong plan đầu tiên** — trả `null` cho launch đang ở phase curve, có nhãn "chưa hỗ trợ", không chặn các trường khác |

## 5. Tính trung thực của số liệu ước tính

Giá quy đổi USD cho giao dịch **lịch sử** dùng tỷ giá **hiện tại** tại thời điểm render, không phải tỷ giá tại đúng lúc giao dịch xảy ra (chain không lưu lịch sử giá ETH/USD tại từng block theo cách rẻ để truy vấn hàng loạt). Vì vậy:

- API trả cột USD kèm một cờ hoặc ghi chú (ví dụ field `usdValueApprox: true`) — không trình bày như số liệu chính xác tuyệt đối.
- FE hiển thị tooltip/chú thích ngắn: "quy đổi theo giá hiện tại, không phải giá tại thời điểm giao dịch".
- Nếu `usdPricing.ts` không đọc được giá (RPC lỗi, feed không khớp), trả `null` cho toàn bộ trường liên quan đến USD của launch đó — không fallback về 0 hay giá cũ cache quá hạn.

## 6. Giới hạn và lỗi

- RPC công khai Robinhood có thể giới hạn/chậm giống các nguồn khác trong dự án — các lệnh đọc mới (`totalSupply`, V3/V4 pool state, Chainlink feed) dùng cùng client/retry pattern đã có, không tạo client RPC riêng không kiểm soát.
- Nếu `totalSupply()`/đọc pool state lỗi cho 1 launch cụ thể (token lạ, hợp đồng không chuẩn ERC-20...), trả `null` cho đúng launch đó, không làm hỏng cả response danh sách.
- Cache giá Chainlink theo tiến trình (in-memory) — không chia sẻ qua nhiều instance API nếu sau này scale ngang; chấp nhận được ở quy mô hiện tại (1 instance).

## 7. Kiểm thử và tiêu chí nghiệm thu

- Unit test: `usdPricing.ts` parse đúng `latestRoundData()`, xử lý đúng khi quote asset không khớp feed nào (trả `null`), cache đúng TTL.
- Unit test: FDV = `totalSupply × price`, xử lý đúng khi `totalSupply()` lỗi/trả về kiểu dữ liệu không mong đợi.
- Integration test: endpoint danh sách/chi tiết trả đúng trường mới cho launch có đủ dữ liệu, trả `null` (không phải 0) cho launch thiếu dữ liệu (quote asset lạ, pool curve chưa hỗ trợ TVL).
- Test với dữ liệu thật: gọi RPC thật tới feed Chainlink đã xác minh ở mục 2, xác nhận giá trả về hợp lý (không âm, không quá cũ theo `updatedAt`).
- Chạy lint, typecheck, unit/integration test, build, OpenAPI check — khớp quy trình đã dùng cho các phần backend trước.

## Nguồn chính

- [Robinhood Chain — Oracles & Price Feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/)
- [Chainlink Price Feed Addresses — Robinhood network](https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood)
- [Chainlink AggregatorV3Interface](https://docs.chain.link/data-feeds/getting-started)
- Dữ liệu tham chiếu thật từ Uniswap Launches (app.uniswap.org/launches) và trang chi tiết token, xem trực tiếp trong phiên làm việc 01/10/2026.
