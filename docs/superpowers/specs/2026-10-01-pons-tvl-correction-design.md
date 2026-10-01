# Đặc tả điều chỉnh TVL của Pons

**Ngày:** 01/10/2026

**Trạng thái:** Thiết kế đã thống nhất trong hội thoại; chờ duyệt tài liệu trước khi lập kế hoạch triển khai.

**Thay thế:** Chỉ phần TVL ở mục 4 của `2026-10-01-uniswap-parity-stats-design.md`. Plan thống kê hiện tại đã hoàn thành các phần khác và không còn là hướng dẫn triển khai TVL.

## Mục tiêu

Trang danh sách và chi tiết launch đều hiển thị một trường có nhãn **TVL**. Giá trị này phải dựa trên tài sản thực thuộc venue chính thức hiện tại của launch. Curve Pons V2 và pool Uniswap có cơ chế khác nhau, nên công thức theo venue khác nhau; UI dùng cùng nhãn và giải thích công thức tương ứng trong tooltip. Không dùng số ảo, không biến dữ liệu thiếu thành `0`.

## Định nghĩa theo giai đoạn

| Venue hiện tại | Giá trị hiển thị dưới nhãn TVL | Giới hạn |
|---|---|---|
| Pons V2 curve (`phase = 0`) | `realQuoteReserve × quoteUsd` | Chỉ tính quote thực còn được curve hạch toán để giao dịch. Không cộng phantom quote, phí đã phát sinh chờ sweep hoặc token launch chưa bán theo giá do curve tự tạo. |
| Pons V2 swept/rescued (`phase = 1/3`) | `null` | Curve đã đóng; chưa có pool chính thức có thể định giá. |
| Pons V2 V4 pool (`phase = 2`) | `poolTokenAmount × launchTokenUsd + poolQuoteAmount × quoteUsd` | Đọc lượng tài sản thuộc đúng pool ID, không dùng `PoolManager.balanceOf` hay tham số `liquidity`. |
| Pons V1 V3 pool | `poolTokenAmount × launchTokenUsd + poolQuoteAmount × quoteUsd` | Đọc ERC-20 `balanceOf(pool)` cho cả hai token. Số này gồm tài sản thực do pool nắm giữ, kể cả phí chưa thu và donation; công bố cơ sở `pool_custody`. |

TVL trên curve là giá trị quote thực thu được; TVL ở pool là giá trị theo thị trường của vị thế hai tài sản. Đây là quy ước hiển thị theo giai đoạn, không phải một chuỗi số có cùng cơ sở kế toán. Khi tốt nghiệp, giá trị có thể nhảy vì token từ tồn kho phát hành trở thành tài sản của vị thế thanh khoản. UI không làm mượt hoặc cộng trùng hai giai đoạn.

## Nguồn dữ liệu và phép tính

1. Lấy venue chính thức hiện tại cùng trạng thái vòng đời đã được index và xác thực. Không dùng venue curve đã đóng để tính launch đã tốt nghiệp.
2. Chốt một block đọc cho toàn bộ số lượng tài sản của một launch. Với curve, gọi `realQuoteReserve()` trên `venues.ref`. `getReserves()` chỉ dùng để tính giá; `quoteReserve` trong đó gồm phantom quote và không được dùng làm TVL. Kiểm tra `phase` tại block đọc; nếu DB và chain lệch trạng thái thì trả `null` và lý do chưa đồng bộ.
3. Với V4, dựng chính xác `PoolKey` từ token, quote, fee, tick spacing và hook đã xác thực; kiểm tra pool ID trùng `venues.ref`. Dùng Uniswap `ReservesLens` trên Robinhood Chain để đọc số lượng gốc theo pool. Hook Pons bật `afterSwapReturnDelta` để thu phí sau swap; cờ `hasCustomAccounting` của lens vì vậy là `true` dù phần gốc của pool vẫn có thể đọc và định giá. Chỉ dùng `coreAmount0/1` cho `pool_principal`, không cộng phí/hook balance vào TVL. Nếu triển khai hook khác quản lý tài sản ngoài pool hoặc lens không hoàn tất thì trả `null`. Khi lens phải phân trang, mọi trang dùng cùng block và chỉ xuất kết quả khi `done = true`.
4. Với V3, đọc `balanceOf(pool)` của launch token và WETH tại cùng block, sau khi xác minh `token0`/`token1` của pool khớp launch. Đây là giá trị tài sản pool đang nắm giữ, gồm phí chưa thu và donation. V4 ReservesLens trả phần gốc, nên metadata phân biệt `pool_custody` với `pool_principal`; UI không tuyên bố hai giá trị có phạm vi phí giống hệt nhau.
5. Định giá quote theo `(chainId, address)`, không theo symbol. ETH/WETH dùng feed đã xác minh. USDG dùng feed USDG/USD trên Robinhood Chain khi còn tươi; không mặc định $1. Stock Token được đối chiếu địa chỉ contract trong API `/rhj/assets` của Robinhood (chain ID 4663) với feed USD cùng ticker trong danh mục Chainlink Robinhood mainnet; feed đã bao gồm corporate-action multiplier. Bộ đối chiếu làm mới định kỳ và khi gặp quote chưa biết, nên quote Stock Token mới được phát hiện mà không cần sửa code. Quote ngoài danh mục xác minh trả `null` với lý do, được ghi nhận để bổ sung nguồn sau; tuyệt đối không ghép bằng symbol của ERC-20 không xác minh.
6. Giá launch token trong pool được suy từ trạng thái pool chính thức tại block đọc và quy đổi bằng giá quote USD. Đây là định giá theo giá giao ngay, không bảo đảm bán toàn bộ lượng token ở giá đó. Không dùng giá cũ sau khi venue chuyển giai đoạn.

Toàn bộ số lượng token giữ dạng số nguyên và decimals; các phép nhân/chia tiền dùng decimal hoặc rational, API trả chuỗi thập phân. Không dùng `Number` cho raw token amount. Cache theo venue, block và nguồn giá trong thời gian ngắn; không quét RPC nền cho toàn bộ launch.

## API và UI

Giữ trường `tvlUsd: string | null` hiện có để tương thích. Bổ sung metadata tối thiểu cho cách diễn giải: `tvlBasis` (`curve_real_quote`, `pool_principal`, hoặc `pool_custody`), `tvlBlockNumber`, `tvlPriceSource`, `tvlPriceUpdatedAt`, và `tvlUnavailableReason` khi `null`. Nếu quote được định giá theo mệnh giá, metadata phải phân biệt với oracle thị trường.

UI luôn dùng nhãn **TVL**. Tooltip của curve: “Giá trị quote thực trong bonding curve; không gồm reserve ảo và token chưa bán.” Tooltip của pool: “Giá trị ước tính của hai token trong pool theo giá hiện tại.” Nếu thiếu dữ liệu, hiển thị trạng thái chưa có dữ liệu, không hiển thị `$0`.

## Kiểm chứng

- Curve USDG đã đối chiếu trên Robinhood Chain: `getReserves().quote = 3,251.700717 USDG`, `realQuoteReserve() = 15.700717 USDG` ở một thời điểm đọc. TVL curve phải dùng giá trị thứ hai nhân giá USDG hợp lệ; phép tính với giá trị thứ nhất phải bị test loại trừ.
- Kiểm tra curve ETH và ERC-20 (USDG), cùng `decimals` khác nhau; kiểm tra venue chuyển `curve → swept → V4` không cộng trùng hoặc dùng curve cũ.
- Đối chiếu lượng V3/V4 với trạng thái chain ở cùng block; V4 có hook custom accounting hoặc lens phân trang phải có kết quả hoàn chỉnh hoặc `null`.
- Test giá quote thiếu, cũ, mệnh giá USDG, RPC lỗi và launch đơn lẻ lỗi trong một trang nhiều launch; các trường khác vẫn trả bình thường.
- Kiểm tra API schema, trang danh sách, trang chi tiết, typecheck và các test liên quan trước khi tuyên bố hoàn thành.

## Cơ sở tham chiếu

- [Pons V2: reserve ảo, `realQuoteReserve()` và vòng đời curve → V4](https://docs.ponsfamily.com/v2)
- [Uniswap V4: đọc reserve theo pool bằng ReservesLens](https://developers.uniswap.org/docs/protocols/v4/guides/reading-pool-reserves)
- [Uniswap V4: địa chỉ triển khai trên Robinhood Chain](https://developers.uniswap.org/docs/protocols/v4/deployments)
- [Pons V2 hook: thu phí sau swap bằng `afterSwapReturnDelta`](https://github.com/ponsdotdev/pons-labs/blob/main/contractsV2/src/v2/hooks/PonsV2MemeHook.sol)
- [DefiLlama: quy ước TVL và giới hạn tài sản tự tạo](https://docs.llama.fi/list-your-project/what-to-include-as-tvl)
- [Robinhood Chain: giá Stock Token và hệ số corporate action](https://docs.robinhood.com/chain/stock-token-apis/)
- [Robinhood Chain: Chainlink feed directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json)
