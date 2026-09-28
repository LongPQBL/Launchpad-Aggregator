# Đặc tả 1 — Luồng dữ liệu pons chỉ đọc và web app

**Ngày:** 28/09/2026

**Trạng thái:** Đã dùng để triển khai; cập nhật định nghĩa buyback ngày 29/09/2026, chờ duyệt phần sửa đổi

**Bối cảnh:** Một lập trình viên, ưu tiên chạy local trước

## 1. Mục tiêu và phạm vi

Xây dựng một lát cắt sản phẩm hoàn chỉnh, có thể kiểm chứng từ đầu đến cuối: tìm tất cả token từng được và mới được ra mắt qua pons trên Robinhood Chain, theo dõi vòng đời giao dịch chính thức của chúng và hiển thị trên web app đáp ứng cả desktop lẫn điện thoại. Lát cắt này phải chứng minh rằng có thể thêm adapter của sàn khác mà không phải thay đổi mô hình dữ liệu chung của API và giao diện. Đây là nền tảng để sau đó tích hợp full.fun trên tất cả chain mà sàn này hỗ trợ tạo token.

Hoàn thành nghĩa là người dùng tìm được một token pons và xem được sàn xuất phát, phiên bản giao thức, tài sản ghép cặp dùng để định giá, trạng thái vòng đời, biểu đồ chính thức, giao dịch chính thức, volume chính thức trong 24 giờ và trạng thái đồng bộ dữ liệu. Đặc tả 1 không bao gồm mua/bán thật hoặc mô phỏng.

**Trong phạm vi:** Hai factory v1 (cũ và hiện hành), factory v2, toàn bộ launch từ block triển khai đã kiểm chứng, lịch sử giao dịch tại nơi giao dịch chính thức trước/sau tốt nghiệp, quét lịch sử, cập nhật gần realtime, khôi phục sau mất kết nối, API và FE tối thiểu. **Ngoài phạm vi:** Tạo token, kết nối ví, mua/bán, phí nền tảng, dữ liệu holder, chấm điểm rủi ro, sàn/chain khác, pool không chính thức, chuyển tiền khác chain và triển khai production. Đây là các giai đoạn sau, không phải những yêu cầu bị bỏ đi.

## 2. Công nghệ đã chọn

- Hai thư mục sản phẩm chính là `fe/` và `be/`; tài liệu ở `docs/`.
- `fe/`: Next.js, React, TypeScript, Tailwind CSS và shadcn/ui; TradingView Lightweight Charts cho biểu đồ nến. Tuân thủ yêu cầu ghi công của thư viện biểu đồ.
- `be/`: Node.js, TypeScript, Fastify, viem, PostgreSQL và Drizzle để quản lý migration. Indexer chạy liên tục và HTTP API là hai tiến trình riêng nhưng dùng chung module BE và database.
- Kiểm thử: Vitest cho logic adapter và dữ liệu chuẩn hóa; integration test với PostgreSQL; Playwright cho luồng trên trình duyệt. Khi phù hợp, fixture lấy từ các khoảng log on-chain thật và cố định.
- Không cần Redis, Kafka, Elasticsearch hay một microservice cho mỗi chain ở giai đoạn này. PostgreSQL lưu checkpoint bền vững và dữ liệu đã tính. Có thể cung cấp cấu hình Compose tùy chọn để chạy PostgreSQL local; FE/BE chạy trực tiếp trên máy và cũng hỗ trợ PostgreSQL cài trực tiếp. Docker Desktop không phải điều kiện bắt buộc.
- Schema của route Fastify là hợp đồng API. Xuất OpenAPI và sinh kiểu dữ liệu FE từ đó để FE/BE không âm thầm lệch nhau.
- Thêm GitHub Actions CI cùng mốc code đầu tiên: khi có pull request hoặc push lên nhánh `main`, chạy cài dependency, lint, kiểm tra TypeScript, test adapter/domain xác định trước, integration test PostgreSQL và build FE/BE. Thêm browser smoke test khi đã có các route FE. CI không phụ thuộc RPC công khai đang chạy và không gửi giao dịch thật. Chưa làm CD cho đến khi chọn nơi deploy và chính sách quản lý thông tin đăng nhập.
- **Quy ước ngôn ngữ:** Tài liệu đặc tả này viết tiếng Việt; tên file/thư mục, biến, hàm, kiểu dữ liệu, trường API, test và chú thích trong code dùng tiếng Anh.

## 3. Ranh giới các thành phần

```text
fe/src/app + fe/src/features + fe/src/api
              │ HTTP đọc dữ liệu ban đầu / SSE nhận cập nhật
              ▼
be/src/api ──────────────── PostgreSQL
                              ▲
be/src/indexer ───────────────┘
       │
       ├── be/src/launchpads/pons/v1
       ├── be/src/launchpads/pons/v2
       └── be/src/chains (RPC/WSS Robinhood và danh mục chain)
```

`launchpads/pons/v1` và `launchpads/pons/v2` biết địa chỉ contract, ABI, cách tìm launch, vòng đời và cách giải mã giao dịch của từng giao thức. Cả hai trả về cùng định dạng launch, nơi giao dịch, giao dịch và trạng thái đã chuẩn hóa. `chains/` quản lý chain ID, endpoint RPC, giới hạn tốc độ và tình trạng provider; không chứa logic riêng của pons. `indexer/` chịu trách nhiệm quét theo khoảng block, nhận sự kiện mới, lưu checkpoint, loại trùng và đối chiếu dữ liệu; không tự giải mã giao thức. `api/` đọc dữ liệu chuẩn hóa, không gọi hàng loạt launchpad/pool mỗi khi người dùng mở trang.

Giao diện adapter dựa trên năng lực: liệt kê nguồn launch, giải mã sự kiện launch, xác định vòng đời và nơi giao dịch chính thức, giải mã giao dịch chính thức. Một sàn có thể cần nhiều adapter theo phiên bản giao thức nhưng dùng chung provider của chain. Sau này thêm full.fun nghĩa là thêm adapter và ba cấu hình chain, không sao chép toàn bộ BE ba lần.

## 4. Nguồn dữ liệu riêng của pons

Event từ factory và nơi giao dịch trên chain là nguồn xác thực cho launch/giao dịch. Metadata được đọc từ contract của token/launch và lưu kèm nguồn gốc. Địa chỉ factory, phiên bản giao thức, block bắt đầu, ABI và chain hỗ trợ nằm trong danh mục cấu hình, không rải điều kiện khắp logic nghiệp vụ.

- **v1:** Quét `TokenLaunched` từ cả hai factory v1 được tài liệu hóa; đăng ký pool Uniswap V3 trong event và quét `Swap` của pool đó. Trạng thái tốt nghiệp thay đổi khi `graduationStatus(token)` của factory xác nhận; giao dịch vẫn diễn ra ở cùng pool. Không tự tạo event di chuyển thanh khoản hay pool chính thức mới. [Tài liệu pons v1](https://docs.ponsfamily.com/).
- **v2:** Quét `TokenLaunched` từ factory, `CurveBuy`/`CurveSell` và `BuybackLocked` trên curve của từng launch, cùng trạng thái `phase`. `phase = 0` giao dịch trên curve; `phase = 1` (`Swept`) chưa có pool hoạt động; `phase = 2` dùng `poolId` Uniswap V4 chính thức đã tái tạo; `phase = 3` (`Rescued`) được hiển thị riêng. Sau tốt nghiệp, tính mọi swap thực sự khớp tại đúng pool V4 đó, gồm swap nội bộ của Pons để mua lại token hoặc đổi phí sang tài sản ghép cặp. Tài sản ghép cặp có thể là ETH gốc hoặc ERC-20 được phê duyệt; không mặc định là WETH. [Tài liệu pons v2](https://docs.ponsfamily.com/v2).
- Trước khi tuyên bố dữ liệu volume/chart sau tốt nghiệp của v2 đã đầy đủ, việc kiểm tra nguồn phải xác minh địa chỉ V4 PoolManager, cách tái tạo pool key/ID, cách giải mã swap và ít nhất một launch đã tốt nghiệp thực tế. Tài liệu pons mô tả cách tái tạo, nhưng tự nó chưa chứng minh indexer của dự án đúng.
- Giao diện ghi tên nguồn là **pons** (chữ thường) và liên kết về ứng dụng của họ; phiên bản nằm trong thông tin kỹ thuật. Không tạo ấn tượng đây là đối tác hay sản phẩm chính thức của pons. [Điều khoản ghi công của pons](https://docs.ponsfamily.com/).

## 5. Dữ liệu chuẩn hóa và định nghĩa chỉ số

Mọi định danh đều kèm chain. Token được xác định bằng `(chainId, tokenAddress)`, không dùng tên hoặc symbol. Bản ghi launch liên kết token với sàn xuất phát, phiên bản giao thức, factory, giao dịch tạo token, tài sản ghép cặp và vòng đời. Bản ghi nơi giao dịch phải biểu diễn được địa chỉ pool V3, contract bonding curve hoặc ID của pool V4; một trường `poolAddress` không đủ cho cả ba. Mỗi nơi giao dịch chính thức có thời điểm bắt đầu/kết thúc hiệu lực trong vòng đời launch. Nhờ vậy, v1 dùng một pool xuyên suốt, còn v2 nối curve với pool mà không ghi đè lịch sử.

Mỗi giao dịch chuẩn hóa lưu chain, token, nơi giao dịch, định danh block/transaction/log, thời gian, chiều mua/bán, lượng token và tài sản ghép cặp thực sự đã khớp, tài sản ghép cặp, event nguồn, loại hoạt động và nguồn xác định giá. Loại hoạt động phân biệt giao dịch thông thường với buyback và đổi phí của giao thức; nếu chưa chứng minh được nguyên nhân của một swap nội bộ, gắn nhãn trung tính “Giao dịch nội bộ Pons” thay vì đoán là buyback. Lưu lượng on-chain dưới dạng số nguyên kèm decimals; API trả chuỗi thập phân, không dùng số thực dấu phẩy động để tính tiền. Log gốc vẫn có thể đối chiếu. Khi log bị thay thế do reorg, hệ thống phải rút lại log cũ rồi tính lại dữ liệu bị ảnh hưởng.

**Volume chính thức** là tổng lượng tài sản ghép cặp thực sự giao dịch tại nơi giao dịch chính thức trong khoảng thời gian chọn, không phân biệt người mua/bán là user hay giao thức. Trước tốt nghiệp v2, `BuybackLocked` thể hiện Pons đã dùng tài sản ghép cặp mua token từ curve: cộng `quoteSpent` vào volume curve một lần và ghi một hoạt động buyback, dù nó không phát `CurveBuy`. Sau tốt nghiệp, mọi `PoolManager.Swap` thực sự khớp tại pool V4 chính thức đều cộng vào volume pool, kể cả swap do hook Pons khởi tạo để buyback hoặc đổi phí. Chỉ event phân bổ/chuyển phí, khóa token vào vault, tiền hoàn lại, buyback bị bỏ qua vì không thực hiện được và pool không liên quan mới không tạo volume; không đếm thêm lần nữa từ event thông báo sweep/buyback nếu swap tương ứng đã được ghi. Với v2, volume nối giao dịch curve rồi đến pool V4 chính thức mà không đếm cùng một swap hai lần. Trang danh sách hiện volume chính thức 24 giờ. Trang pool phụ ở giai đoạn sau sẽ hiện volume riêng của pool đang xem.

Nến giá được tạo theo thứ tự event, từ giá đã xác minh của nơi giao dịch và biểu thị theo tài sản ghép cặp của launch. V3 của v1 và V4 của v2 dùng trạng thái pool sau mọi swap đã giải mã, gồm swap nội bộ của Pons. Giá curve v2 được tái tạo từ trạng thái lúc launch và chuỗi event theo thứ tự, gồm cả `BuybackLocked`, lượng tài sản thực khớp, phí và thuế; đối chiếu với một số lần đọc `getReserves()` tại block lịch sử. Nếu không xác minh được, đánh dấu đoạn chart chưa đầy đủ và yêu cầu provider có dữ liệu trạng thái lưu trữ, thay vì dùng giá khớp đã méo vì phí làm giá thị trường. Không tự tạo nến cho khoảng không có giao dịch; buyback thực sự khớp là giao dịch và có thể tạo/cập nhật nến. Trên chart v2, đánh dấu điểm chuyển curve → pool nhưng giữ lịch sử chính thức liền mạch.

Đặc tả 1 hiển thị giá và volume theo tài sản ghép cặp của từng launch; **chưa quy đổi USD và chưa xếp hạng volume giữa các tài sản ghép cặp khác nhau**. Điều này tránh so sánh volume ETH với một ERC-20 như thể cùng đơn vị. Mặc định danh sách sắp theo launch mới nhất; volume chính thức 24 giờ luôn kèm ký hiệu tài sản ghép cặp. Một đặc tả sau có thể thêm nguồn tỷ giá lịch sử phù hợp để quy đổi USD và xếp hạng chung. Dữ liệu volume chưa có là `null`/“Chưa có dữ liệu”, không phải 0.

## 6. Quét lịch sử, cập nhật mới và xử lý lỗi

Với mỗi luồng factory và nơi giao dịch chính thức, quét từ block triển khai/block launch đã xác minh đến một mốc block an toàn đã ghi nhận, dùng các khoảng `eth_getLogs` có giới hạn và tự điều chỉnh kích thước. Chỉ lưu checkpoint riêng cho từng nguồn sau khi bản ghi và dữ liệu tổng hợp của khoảng đó đã ghi thành công. Lỗi provider tạm thời được thử lại với thời gian chờ tăng dần có giới hạn; nếu vượt giới hạn số log, giảm khoảng block. Khi khởi động lại, worker tiếp tục từ checkpoint, không đếm trùng dữ liệu đã lưu.

Dùng WSS để phát hiện nhanh log mới nếu provider hỗ trợ. Độc lập với WSS, dùng HTTP để quét bù từ checkpoint đã lưu đến mốc block an toàn sau khi kết nối lại, theo lịch định kỳ và khi tiến trình khởi động. Log sát đầu chain có thể xuất hiện với trạng thái tạm thời; số block chờ xác nhận được cấu hình theo chain. Khi reorg, rút log thuộc các block bị thay thế và tính lại dữ liệu liên quan trước khi đánh dấu đã xác nhận. Không hứa một độ trễ cố định mà RPC công khai không đảm bảo; ứng dụng hiển thị độ trễ đồng bộ đo được bằng số block/thời gian.

Mỗi nguồn có trạng thái `backfilling`, `caught_up` hoặc `degraded`, block đã quét/đã xác nhận cuối cùng và những khoảng còn thiếu. API trả trạng thái bao phủ dữ liệu cùng chỉ số. Khi lịch sử liên quan chưa đầy đủ, FE hiện “Đang đồng bộ” hoặc lỗi phù hợp; không gắn nhãn số liệu chưa đủ là số liệu hoàn chỉnh và không biến dữ liệu thiếu thành 0. Lỗi provider phải quan sát được nhưng không ngăn người dùng xem token đã được lập chỉ mục.

RPC công khai của Robinhood có giới hạn tốc độ; hướng dẫn chính thức khuyến nghị endpoint archive để lập chỉ mục lịch sử. Bản local bắt đầu bằng endpoint miễn phí, nhưng **chỉ công nhận đã lấy đủ lịch sử khi kiểm chứng được**, không mặc định là đủ. Nếu RPC công khai cản trở quét đầy đủ, worker ghi rõ khoảng còn thiếu và dự án báo nhu cầu provider trước khi tuyên bố hoàn thành. [Hướng dẫn kết nối Robinhood Chain](https://docs.robinhood.com/chain/connecting/).

## 7. API và hành vi web app

Fastify cung cấp API chỉ đọc có phiên bản: danh sách chain/sàn được hỗ trợ; danh sách launch phân trang bằng cursor kèm tìm kiếm, lọc trạng thái và sắp xếp; chi tiết launch; lịch sử nơi giao dịch chính thức; giao dịch, nến và độ bao phủ đồng bộ theo nguồn. URL token ổn định dùng chain ID và địa chỉ token. SSE gửi thay đổi launch/giao dịch/trạng thái đến trình duyệt; nếu SSE mất kết nối, FE tải lại dữ liệu và có thể polling đến khi kết nối lại. Trang tải dữ liệu ban đầu qua Next.js; chart và bảng cập nhật mới là các phần chạy phía trình duyệt.

FE dùng dashboard giao dịch nền tối, tương phản rõ, lấy các block của shadcn/ui làm cơ sở rồi tùy biến cho aggregator, không sao chép một app hoàn chỉnh. Desktop ưu tiên bảng launch dễ quét; trên điện thoại dùng bố cục token gọn. Trang launch hiển thị định danh, nguồn pons, chain, tài sản ghép cặp, vòng đời (gồm `Swept`/`Rescued` của v2), giá/chart/giao dịch/volume 24 giờ chính thức và trạng thái đồng bộ. Lịch sử giao dịch gắn nhãn rõ “Buyback bởi Pons”, “Đổi phí bởi Pons” hoặc “Giao dịch nội bộ Pons” khi tương ứng; không trình bày các hoạt động này như lệnh của ví người dùng. Thiết kế có bộ lọc nguồn nhưng không hiện các điều khiển chỉ có một lựa chọn trong giai đoạn một sàn/một chain này. Đặc tả 1 không đặt kết nối ví, nút giao dịch thử hay khung mua bị vô hiệu hóa lên giao diện.

## 8. Kiểm chứng và tiêu chí nghiệm thu

1. **Danh mục nguồn:** Xác minh factory, block triển khai, ABI, cách lấy tài sản ghép cặp của từng launch, cách nhận diện pool V3, tái tạo pool key/ID V4 và một giao dịch tham chiếu cho mỗi trạng thái vòng đời quan trọng. Bao gồm cả factory v1 cũ và hiện hành.
2. **Độ bao phủ lịch sử:** Quét từ block bắt đầu của từng nguồn đến mốc block an toàn đã ghi nhận, không có khoảng trống không giải thích được; dùng lượt quét lặp/đối chiếu độc lập hoặc tổng số on-chain nếu có để kiểm tra số launch. Đối chiếu mẫu launch với log gốc và trạng thái contract. Nếu RPC sẵn có không cho phép chứng minh độ bao phủ, lát cắt chưa được coi là hoàn thành.
3. **Vòng đời và chỉ số:** Fixture test bao gồm v1 tốt nghiệp nhưng ở cùng pool; giao dịch curve v2, buyback `BuybackLocked` trước tốt nghiệp, giao dịch mua cuối bị khớp một phần/hoàn tiền, chuyển trạng thái, tài sản ghép cặp tùy chỉnh, swap người dùng và swap nội bộ Pons tại pool V4 sau tốt nghiệp. Xác nhận buyback/đổi phí thực sự khớp có trong volume và chart đúng một lần, còn chuyển phí/khóa vault/buyback bị bỏ qua/hoàn tiền thì không; không cộng những đơn vị volume không tương thích. Đối chiếu mẫu giá và volume với dữ liệu nguồn thô.
4. **Độ bền:** Quét lại cùng khoảng block không đổi kết quả; khởi động lại worker, mất WSS rồi quét bù, giảm khoảng block khi RPC giới hạn và reorg mô phỏng đều tạo ra dữ liệu chuẩn giống lượt quét sạch.
5. **API/FE:** Kiểm tra phân trang cursor, định danh/nguồn gốc token, sự nhất quán giữa chart và giao dịch, thông báo dữ liệu chưa đủ, bố cục desktop/mobile và SSE kết nối lại/dự phòng. Test Playwright chỉ đọc, không gửi giao dịch thật.
6. **Chạy local và CI:** Có hướng dẫn khởi chạy FE, API, indexer và PostgreSQL local từ bản checkout sạch; migration và test suite chạy được. Compose tùy chọn, không bắt buộc. GitHub Actions chạy được các phép kiểm tra xác định trước trên cùng revision mà không cần thông tin đăng nhập RPC thật.

## 9. Thứ tự bàn giao và phần làm sau

Trong phạm vi đặc tả này, làm danh mục nguồn/mô hình dữ liệu và fixture test trước; sau đó tích hợp launch/pool v1 để chứng minh luồng từ đầu đến cuối theo cách đơn giản hơn; tiếp theo là v2 curve/tốt nghiệp/V4; rồi API và FE tối thiểu; cuối cùng là đối chiếu và tăng độ bền. Có thể phát triển UI song song bằng response fixture có kiểu dữ liệu, nhưng chỉ nghiệm thu khi hiển thị dữ liệu thật đã được lập chỉ mục.

Kế hoạch backend và frontend cho Đặc tả 1 đã được viết. Sau khi bạn duyệt sửa đổi về buyback trong tài liệu này, cập nhật kế hoạch backend cho đúng định nghĩa volume/loại hoạt động, rồi viết test và sửa indexer/metric trước khi hoàn thiện API và FE. Các đặc tả sau bao gồm full.fun trên Robinhood/Arc/BNB với đối chiếu lịch sử đủ cả ba chain; tìm và mở trang pool phụ; holder/rủi ro đã kiểm chứng; mua/bán thử và thật tại nơi giao dịch đã chọn với phí nền tảng ban đầu bằng 0 và có thể cấu hình; chuyển tiền khác chain. Khi thêm sàn hoặc chain, mở rộng adapter/danh mục cấu hình và test mà không làm thay đổi hành vi pons hiện có.

## Tài liệu tham khảo

- [Báo cáo nghiên cứu](../../../launchpad-aggregator-research-report.md)
- [Tài liệu tích hợp và điều khoản pons v1](https://docs.ponsfamily.com/)
- [Vòng đời, event và pool của pons v2](https://docs.ponsfamily.com/v2)
- [Hướng dẫn kết nối Robinhood Chain](https://docs.robinhood.com/chain/connecting/)
- [Các block giao diện shadcn/ui](https://ui.shadcn.com/blocks)
- [Tài liệu TradingView Lightweight Charts](https://tradingview.github.io/lightweight-charts/docs/5.0)
