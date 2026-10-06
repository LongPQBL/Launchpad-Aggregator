# Đặc tả — Tab Transactions/Pools hợp nhất cho trang launch detail

**Ngày:** 06/10/2026

**Trạng thái:** Đã duyệt thiết kế trong chat; chờ triển khai.

**Phụ thuộc:** [Đặc tả Pons chỉ đọc](2026-09-28-pons-readonly-design.md), [Vòng đời Pons V2 / pool V4](2026-09-29-pons-v2-lifecycle-design.md). Tài liệu này không thay đổi logic vòng đời/venue chính thức đã có; chỉ thêm 1 view hợp nhất và restyle UI giao dịch.

## 1. Mục tiêu và phạm vi

Trang launch detail (`fe/src/app/launches/[chainId]/[tokenAddress]`) hiện có 2 khối tách rời: "Official trading venues" + `TradeList` (chỉ trade chính thức), và "Other pools" (`PoolList` lọc theo `tokenAddress`, `excludeOfficial=true`). Mục tiêu: gộp 2 khối này thành 1 UI dạng tab "Transactions / Pools" giống tham khảo Uniswap mà người dùng cung cấp — tab Transactions là lịch sử giao dịch **gộp theo thời gian** giữa trade chính thức và swap của mọi pool khác chứa token này; tab Pools giữ nguyên `PoolList` hiện có.

Ngoài ra: restyle bảng transaction theo layout ảnh mẫu (cột Time/Type/`<SYMBOL>`/For/USD/Wallet/Explorer), đổi quy tắc làm tròn số cho các cột số tiền, sửa `formatPrice()` để ra đúng 3 chữ số có nghĩa, và thêm theme toggle sáng/tối (mặc định vẫn sáng theo quyết định light-UI đã chốt trong `CLAUDE.md`).

**Ngoài phạm vi:** không đổi logic venue chính thức, không đổi cách tính `officialVolume24h`/FDV/TVL ở trang chủ hay card pool, không thêm trading thật, không đổi route `/pools/...` của trang pool riêng lẻ.

## 2. Phương án được chọn

Thêm 1 endpoint backend mới gộp 2 nguồn bằng SQL `UNION ALL`, trả về 1 trang kết quả đã sắp xếp đúng `(blockNumber, txHash, logIndex)` toàn cục, dùng lại định dạng cursor sẵn có ở `be/src/api/cursor.ts`. Đây là phương án được chọn (so với gộp ở FE bằng cách gọi nhiều endpoint pool riêng lẻ rồi merge-sort client-side): dữ liệu có thể có rất nhiều pool cho 1 token, phân trang độc lập nhiều nguồn ở FE sẽ lệch thứ tự và lệch trang ngay từ "load more" thứ 2; gộp ở SQL giữ đúng tinh thần "giữ thứ tự `(blockNumber, logIndex)` chính xác" đã ghi trong `CLAUDE.md`.

**Quan trọng — không đếm trùng:** một pool V4 do Pons chỉ định (official venue) cũng tồn tại trong `pool_catalog`. Nhánh "pool" của UNION phải loại trừ pool đó, dùng lại đúng điều kiện `excludeOfficial` đang có ở `listPools` (`be/src/api/poolStore.ts`), nếu không swap chính thức sẽ bị đếm 2 lần (1 lần trong nhánh official, 1 lần trong nhánh pool) — vi phạm trực tiếp rule đã chốt "không đếm trùng 1 swap".

## 3. Thành phần và dữ liệu

### 3.1 Backend — endpoint mới

`GET /v1/launches/:chainId/:tokenAddress/transactions`, thêm vào `be/src/api/routes/launches.ts`, validate tham số giống route `/trades` hiện có (`tokenParams`, `listQuery`).

Query SQL (đặt trong `be/src/api/store.ts`, hàm `listTransactions`):

```sql
WITH merged AS (
  SELECT 'official' AS source, t.venue_id, NULL::text AS protocol, NULL::text AS pool_id,
    t.tx_hash, t.log_index, t.block_number, t.timestamp, t.side, t.activity_kind,
    t.token_amount_raw, t.quote_amount_raw, t.trader_address,
    l.quote_asset_address, l.quote_asset_decimals, l.token_decimals
  FROM trades t
  JOIN venues v ON v.id = t.venue_id
  JOIN launches l ON l.chain_id = t.chain_id AND l.token_address = t.token_address
  WHERE t.chain_id = $1 AND t.token_address = $2 AND v.official = true

  UNION ALL

  SELECT 'pool' AS source, NULL AS venue_id, pt.protocol, pt.pool_id,
    pt.tx_hash, pt.log_index, pt.block_number, pt.timestamp, NULL, NULL,
    pt.amount0_raw, pt.amount1_raw, pt.trader_address,
    NULL, NULL, NULL
  FROM pool_trades pt
  JOIN pool_catalog pc ON pc.chain_id = pt.chain_id AND pc.protocol = pt.protocol AND pc.pool_id = pt.pool_id
  WHERE pc.verified = true
    AND EXISTS (SELECT 1 FROM pool_members m WHERE m.chain_id = pc.chain_id AND m.protocol = pc.protocol
      AND m.pool_id = pc.pool_id AND m.token_address = $2)
    -- loại trừ pool đã là official venue, xem mục "không đếm trùng" ở trên
    AND NOT EXISTS (SELECT 1 FROM venues v WHERE v.chain_id = pc.chain_id
      AND v.kind IN ('v4_pool','v3_pool') AND v.ref = pc.pool_id AND v.official = true)
)
SELECT * FROM merged
WHERE ($3::bigint IS NULL OR (block_number, tx_hash, log_index) < ($3::bigint, $4::text, $5::integer))
ORDER BY block_number DESC, tx_hash DESC, log_index DESC
LIMIT $6
```

Tầng JS sau khi có rows thô (giống cấu trúc `listTrades`/`readPoolTrades` hiện tại, không trùng lặp logic định giá):

- Dòng `source='official'`: dùng thẳng `token_amount_raw`/`quote_amount_raw`/`quote_asset_address`/`quote_asset_decimals` đã join sẵn từ `launches`, side lấy từ cột `side`, định giá USD qua `valueTradeUsd(pool, chainId, quoteAssetAddress, {...})` (`be/src/market/quotePricing/tradeValuation.ts`) — y hệt `listTrades` hiện tại.
- Dòng `source='pool'`: cần `currency0/currency1/decimals0/decimals1` của pool đó để biết chiều token hiển thị vs quote (giống `readPoolTrades` trong `be/src/pools/stats.ts`) — query bổ sung 1 lần theo (protocol, poolId) duy nhất xuất hiện trong trang kết quả (dùng `Promise.all`, dedupe theo poolId, không N+1 theo từng dòng). Side suy từ dấu raw amount của chiều hiển thị (amount âm = buy, dương = sell, theo đúng quy ước đang dùng ở `readPoolTrades`). Định giá USD cũng qua `valueTradeUsd` trên chiều có `resolveVerifiedFeed`.
- Trả về cursor tiếp theo bằng `encodeCursor` sẵn có (`be/src/api/cursor.ts`), không tạo format cursor mới.
- Mỗi item thêm field `source: 'official' | 'pool'`, và khi `source='pool'` thêm `pool: { protocol, poolId }` để FE gắn nhãn/link; khi `source='official'` thêm `venueId`.
- Backfill giá "pending": áp dụng đúng cơ chế coalesce-theo-trang hiện có của `listTrades` (1 job bao toàn khoảng `[min-3600, max+3600]` mỗi feed mỗi trang, không phải mỗi dòng) cho CẢ hai nhánh — nếu nhánh pool và nhánh official của cùng trang dùng chung 1 feed quote, gộp chung 1 job thay vì enqueue 2 lần.

Schema response (`be/src/api/schemas.ts`, export `transaction`): hợp nhất field của `trade` và `poolTrade` đã có, cộng thêm `source`, `venueId?`, `pool?: { protocol, poolId }`. Dùng `pageSchema(transaction)` như các endpoint khác. Sau khi thêm route, chạy `npm run openapi:write -w be` rồi `npm run generate:schema -w fe` để cập nhật `fe/src/api/schema.ts`/`client.ts` (quy trình sẵn có, không đổi).

### 3.2 Frontend — tab switcher

Thay 2 section "Official trading venues"+`TradeList` và "Other pools" trong `fe/src/features/launch/launch-detail.tsx` bằng 1 component mới `fe/src/features/launch/transactions-pools-tabs.tsx`, dùng shadcn/ui `Tabs` (thêm qua `npx shadcn add tabs` nếu chưa có trong `fe/src/components/ui`). Tab mặc định "Transactions".

- Tab "Transactions": gọi `getLaunchTransactions(chainId, tokenAddress)` (hàm mới trong `fe/src/api/client.ts`, cùng pattern `getLaunchTrades`) từ `page.tsx` (server component, cùng chỗ đang gọi `getLaunchTrades`/`getLaunchPools`), render bảng mới `transaction-list.tsx`.
- Tab "Pools": render `PoolList` y hệt hiện tại, dùng lại prop `pools` đã fetch sẵn ở `page.tsx` — không đổi logic fetch pool.
- "Official trading venues" (danh sách chip venue) giữ nguyên vị trí hiện tại, phía trên khối tab — không phải nội dung của tab nào.

### 3.3 Frontend — bảng Transactions mới

`transaction-list.tsx` thay cho `trade-list.tsx` trong launch-detail (file `trade-list.tsx` cũ vẫn giữ lại nếu còn chỗ khác dùng — kiểm tra lại khi code; nếu không còn nơi nào dùng thì xoá, theo quy tắc không giữ code chết). Cột theo đúng ảnh mẫu:

| Cột | Nội dung | Format |
|---|---|---|
| Time | `timestamp` | giữ nguyên `toLocaleString` như hiện tại |
| Type | Buy/Sell hoặc nhãn activity (giống `formatActivityKind`/`formatSide` hiện tại); dòng `source='pool'` luôn là Buy/Sell thường, không có activity label | — |
| `<SYMBOL>` (header = ký hiệu token launch) | token amount có dấu | `formatAmount()` mới |
| For | quote amount + icon (ETH/USDG/...) | `formatAmount()` mới, icon qua `TokenLogo` (không có `logoUri` cho quote asset → dùng fallback chữ cái đầu sẵn có trong `TokenLogo`) |
| USD | `usdValue` tại thời điểm giao dịch | `formatAmount()` mới, giữ nguyên tooltip "giá lịch sử" đang có |
| Wallet | `traderAddress` rút gọn `0xAAAA…BBBB`, link `${explorerBase}/address/${traderAddress}` | — |
| Explorer | link tx hiện có, giữ nguyên | — |

Dòng `source='pool'` hiển thị thêm nhãn nguồn nhỏ (vd badge "Pool" cạnh cột Type hoặc tooltip tên cặp pool) để không ngụ ý đây là venue chính thức — nhất quán với rule "label nguồn, không ngụ ý đối tác chính thức" đã có ở `CLAUDE.md`.

### 3.4 Quy tắc làm tròn mới

Trong `fe/src/api/format.ts`:

- Hàm mới `formatAmount(value: string | null, decimals = 2): string` — `null` → `—`; `0` → `0`; `|numeric| < 0.01` → `<0.01`; ngược lại `numeric.toFixed(decimals)`. Dùng cho 3 cột Token/For/USD ở bảng transaction mới. **Không** thay cho `formatUsd()` hiện có (FDV/TVL/market cap ở trang chủ và card pool giữ nguyên quy tắc dynamic-decimals hiện tại, không đổi).
- `formatPrice()`: đổi `dynamicDecimals(numeric, 2)` → `dynamicDecimals(numeric, 3)`. Hàm `dynamicDecimals` hiện có đã đúng công thức tổng quát (`-floor(log10(numeric)) + baseDecimals - 1`); đổi `baseDecimals` từ 2 sang 3 cho ra đúng 3 chữ số có nghĩa: `0.00312344 → 0.00312`, `0.0003426 → 0.000343` (khớp 2 ví dụ người dùng cho). Áp dụng toàn app vì `formatPrice()` dùng chung (current price, 52W high/low, pool price trong quote).

### 3.5 Theme toggle

- `fe/src/app/globals.css`: thêm bộ token màu dưới selector `.dark` (nhân bản bảng màu hiện tại với giá trị tối tương ứng, giữ cùng tên biến `--color-*`).
- Component mới `fe/src/components/theme-toggle.tsx` (client component): đọc/ghi `localStorage('theme')`, toggle class `dark` trên `<html>`. Thêm 1 inline script nhỏ trong `fe/src/app/layout.tsx` (`<head>`, chạy trước paint) đọc `localStorage` để set class `dark` ngay, tránh FOUC — pattern chuẩn cho dark-mode bằng class với Next.js App Router.
- Mặc định không có `localStorage` → light (giữ đúng quyết định light-UI mặc định đã chốt). Đặt toggle ở `AppShell` (header).
- Đây là bổ sung thêm tuỳ chọn, không đảo ngược quyết định "Light UI với accent xanh dương" — cập nhật 1 dòng trong `CLAUDE.md` ghi nhận quyết định bổ sung này sau khi code xong.

## 4. Luồng và xử lý tình huống đặc biệt

- Token không có pool nào khác ngoài venue chính thức: nhánh "pool" của UNION trả 0 dòng, tab Transactions chỉ còn trade chính thức — hành vi giống `TradeList` hiện tại, không regression.
- Token có `coverageStatus` chưa `caught_up` cho 1 trong các pool: endpoint mới không tự ý trộn trạng thái coverage của nhiều pool thành 1 cờ duy nhất ở bước này (ngoài phạm vi); UI chỉ hiển thị dữ liệu đã có, giống cách `TradeList`/`PoolList` hiện tại không chặn render khi coverage chưa đầy đủ.
- `usdValueStatus='pending'`: giữ nguyên hiển thị "Calculating…" đang có trong `trade-list.tsx`, áp dụng cho cả dòng `source='pool'`.
- Reorg: endpoint mới chỉ đọc (`SELECT`), không có state riêng cần fence — tính đúng đắn kế thừa từ `trades`/`pool_trades` đã được fence ở tầng ghi (ngoài phạm vi tài liệu này).
- Phân trang: nút "Next"/"Load more" dùng lại pattern `<a href=...&cursor=...>` server-rendered đang dùng ở `pool-detail.tsx`, không giới thiệu client-side fetch mới — nhất quán với cách trang launch detail hiện là server component.
- `formatAmount()` không được dùng nhầm cho `formatUsd()`/`formatPrice()` ở nơi khác — review riêng khi code để không vô tình đổi hành vi FDV/TVL/market cap.

## 5. Kiểm thử

- **Backend:** unit test `listTransactions` trong `be/src/api/store.test.ts` (nếu tách riêng thì file mới cạnh đó) — thứ tự gộp đúng `(block, tx, logIndex)` khi trộn 2 nguồn, cursor phân trang đúng ranh giới, loại trừ pool official khỏi nhánh pool (test trực tiếp case đếm trùng), `usdValueStatus` priced/pending/unavailable cho cả 2 nhánh. Integration test Postgres (`be/src/api/store.integration.test.ts`) với fixture có cả trade chính thức lẫn pool khác cho cùng token.
- **Frontend:** test `formatAmount()` với các ngưỡng `<0.01`/`=0`/bình thường; test `formatPrice()` với đúng 2 ví dụ người dùng cho (`0.00312344`, `0.0003426`) cộng 1 case `>=1` để đảm bảo không đổi hành vi cũ; test `transaction-list.tsx` render cột đúng, nhãn nguồn pool; test chuyển tab Transactions/Pools; test theme toggle set/đọc đúng `localStorage` và class `dark`.
