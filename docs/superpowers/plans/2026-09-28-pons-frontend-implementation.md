# Pons Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tạo web app nền tối, chỉ đọc, hiển thị launch pons, giao dịch và chart chính thức với trạng thái đồng bộ rõ ràng.

**Architecture:** Next.js App Router tải dữ liệu ban đầu từ Fastify API ở server; các phần chart/bảng realtime chạy phía client. Kiểu API sinh từ `be/openapi.json`; lớp `fe/src/api/` là biên duy nhất gọi BE, để về sau thêm sàn/chain không phải sửa các component hiển thị.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS, shadcn/ui, TradingView Lightweight Charts 5, openapi-typescript, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-pons-readonly-design.md` — đọc toàn bộ trước khi thực hiện. Phụ thuộc hợp đồng API của `docs/superpowers/plans/2026-09-28-pons-backend-implementation.md` Task 10.

## Global Constraints

- Thư mục sản phẩm là `fe/` và `be/`; FE không truy cập RPC hay PostgreSQL trực tiếp.
- Token URL dùng chain ID và token address; không nhận dạng token bằng symbol/tên.
- Mọi volume/giá hiển thị theo quote asset của launch; không quy đổi USD, không cộng volume khác đơn vị.
- `null`/coverage thiếu phải hiện “Chưa có dữ liệu”/“Đang đồng bộ”, không biến thành 0.
- Không có ví, nút mua/bán, nút giao dịch thử hoặc khung giao dịch vô hiệu hóa ở Spec 1.
- Code identifiers, filenames, comments và tests bằng tiếng Anh; copy hiển thị tiếng Việt.
- Mỗi task: test đỏ → code tối thiểu → test xanh → commit; sau kế hoạch, người dùng đã yêu cầu tự triển khai và push mốc đã kiểm chứng, không deploy.

## Review Focus

1. Server-side fetch thất bại khi BE tắt phải hiện lỗi phục hồi được, không crash trang trống → Task 2.
2. Cùng địa chỉ token ở hai chain phải có link khác nhau → Task 2.
3. Quote asset ERC-20 khác 18 decimals phải hiện đúng ký hiệu/chuỗi giá do API trả, không ép `Number` để tính tiền → Task 3.
4. Chart thiếu coverage hoặc không có giao dịch không được tạo nến/volume giả → Task 3.
5. SSE ngắt/nối lại hoặc nhận lặp event không được nhân đôi trade, và vẫn làm mới qua polling → Task 4.

## Bản đồ file chính

- `fe/package.json`, `fe/tsconfig.json`, `fe/next.config.ts`, `fe/src/app/{layout,page,globals.css}`, `fe/src/components/` — shell và primitives giao diện.
- `fe/src/api/{schema,client,format}.ts` — kiểu sinh OpenAPI, fetch có kiểm tra lỗi và định dạng chuỗi tiền.
- `fe/src/features/launches/` — danh sách, tìm kiếm, phân trang và bộ lọc theo danh mục nguồn.
- `fe/src/features/launch/` — chi tiết, chart, bảng giao dịch, trạng thái dữ liệu.
- `fe/src/hooks/use-live-refresh.ts` — SSE, refetch và polling dự phòng.
- `fe/e2e/`, `fe/playwright.config.ts`, `fe/src/**/*.test.tsx` — browser smoke và component tests.

---

### Task 1: Workspace FE và dark app shell

**Files:** Sửa `package.json`, `package-lock.json`, `.github/workflows/ci.yml`; tạo `fe/package.json`, `fe/tsconfig.json`, `fe/next.config.ts`, `fe/postcss.config.mjs`, `fe/src/app/{layout.tsx,page.tsx,globals.css}`, `fe/src/components/app-shell.tsx`, `fe/src/components/app-shell.test.tsx`, `fe/vitest.config.ts`.

**Interfaces:** `AppShell({ children }: { children: React.ReactNode }): React.JSX.Element`; shell có tên ứng dụng, khu vực nội dung chính, theme tối mặc định và vùng attribution Lightweight Charts khi chart xuất hiện.

- [ ] **Step 1 — Test đỏ:** `app-shell.test.tsx` xác nhận tên ứng dụng, landmark `main`, theme tối và không có nút ví/giao dịch.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w fe -- app-shell.test.tsx`; mong đợi FAIL khi component chưa có.
- [ ] **Step 3 — Code:** Thêm `fe` vào npm workspaces; tạo Next app shell responsive, Tailwind và các shadcn/ui primitives cần dùng (không nhập nguyên một template). Đặt Node 24 theo BE.
- [ ] **Step 4 — Chạy xanh:** Component test, `npm run typecheck -w fe`, `npm run build -w fe` exit 0; CI build FE không cần BE đang chạy.
- [ ] **Step 5 — Commit:** Stage FE shell/root workspace/CI và commit `feat: add dark frontend shell`.

### Task 2: Typed API và danh sách launch

**Files:** Tạo `fe/src/api/{schema.ts,client.ts,format.ts}`, `fe/src/api/client.test.ts`, `fe/src/features/launches/{launch-list.tsx,launch-list.test.tsx}`, sửa `fe/src/app/page.tsx`, `fe/package.json`.

**Interfaces:** `getLaunches(query: LaunchQuery): Promise<LaunchPage>` và `getSources(): Promise<SourceList>` dùng kiểu từ `be/openapi.json`; `launchHref(chainId: number, tokenAddress: string): string`; `formatQuote(value: string | null, symbol: string): string`. `BE_API_URL` dành cho server fetch; browser SSE dùng `NEXT_PUBLIC_BE_API_URL`.

- [ ] **Step 1 — Test đỏ:** Mock API xác nhận cursor, tìm kiếm, trạng thái, mặc định mới nhất; hai chain cùng address có URL khác; chỉ một chain/sàn thì ẩn bộ lọc tương ứng; BE tắt hiện lỗi và nút thử lại; volume `null` hiện “Chưa có dữ liệu”.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w fe -- client.test.ts launch-list.test.tsx`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Sinh `schema.ts` bằng `openapi-typescript be/openapi.json`; client dùng `fetch` có timeout/error; page server-render gọi BE; danh sách desktop dạng bảng, mobile dạng card, pagination cursor và filters chỉ hiện khi có nhiều lựa chọn. Không có dữ liệu demo giả trong giao diện thật.
- [ ] **Step 4 — Chạy xanh:** Unit/component tests, generated-schema check, typecheck và build exit 0.
- [ ] **Step 5 — Commit:** Stage API/list/page và commit `feat: browse indexed pons launches`.

### Task 3: Chi tiết launch, chart và giao dịch

**Files:** Tạo `fe/src/app/launches/[chainId]/[tokenAddress]/page.tsx`, `fe/src/features/launch/{launch-detail,official-chart,trade-list,coverage-badge}.tsx`, `fe/src/features/launch/launch-detail.test.tsx`, `fe/src/api/format.test.ts`; sửa `fe/src/api/client.ts`.

**Interfaces:** `getLaunchDetail(chainId: number, tokenAddress: string)`, `getLaunchTrades(...)`, `getLaunchCandles(...)`; `OfficialChart({ candles, graduationTime, quoteSymbol, coverageStatus })` dùng Lightweight Charts và series markers cho chuyển curve→V4.

- [ ] **Step 1 — Test đỏ:** Detail hiện pons, v1/v2, Robinhood, quote asset, phase `swept`/`rescued`, official venues, volume 24h; chart không tự sinh nến ở khoảng trống; dữ liệu thiếu có badge; trade và chart dùng cùng venue ID; `activityKind` gắn nhãn “Buyback bởi Pons”, “Đổi phí bởi Pons” hoặc “Giao dịch nội bộ Pons” mà không giả làm ví người dùng; ERC-20 6 decimals giữ decimal string từ API; route/token sai hiện not-found.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w fe -- launch-detail.test.tsx format.test.ts`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Server fetch chi tiết; client chart/bảng giao dịch; attribution TradingView theo yêu cầu thư viện; link pons/explorer có nhãn nguồn, không ngụ ý quan hệ đối tác. Không dùng `Number` để tính giá/volume; chỉ chuyển giá đã chuẩn hóa sang giá trị biểu đồ tại biên render và gắn nhãn xấp xỉ nếu cần.
- [ ] **Step 4 — Chạy xanh:** Component/unit tests, typecheck, build exit 0; kiểm tra thủ công viewport desktop/mobile.
- [ ] **Step 5 — Commit:** Stage detail/chart/tests và commit `feat: show official launch market history`.

### Task 4: Realtime, browser tests và local handoff

**Files:** Tạo `fe/src/hooks/use-live-refresh.ts`, `fe/src/hooks/use-live-refresh.test.ts`, `fe/e2e/{launch-list,launch-detail}.spec.ts`, `fe/e2e/mock-api.ts`, `fe/playwright.config.ts`; sửa `.github/workflows/ci.yml`, `README.md`, `fe/.env.example`.

**Interfaces:** `useLiveRefresh(resourceKeys: readonly string[], refresh: () => void): LiveStatus`; SSE `/v1/events` báo ID/key để refetch, polling theo chu kỳ khi SSE lỗi, cleanup khi unmount.

- [ ] **Step 1 — Test đỏ:** Mock EventSource phát lặp `trade.created` chỉ gây một refetch hợp nhất; ngắt SSE kích hoạt polling và nối lại dừng polling; Playwright với mock API server kiểm tra list→detail, coverage thiếu, desktop/mobile, không có giao dịch hoặc wallet UI.
- [ ] **Step 2 — Chạy đỏ:** `npm test -w fe -- use-live-refresh.test.ts`; `npm run test:e2e -w fe`; mong đợi FAIL.
- [ ] **Step 3 — Code:** Hook SSE/refetch/poll; mock API process cho Playwright vì Next server-side fetch không bị `page.route` chặn; CI chạy browser smoke không cần RPC/BE thật. README hướng dẫn FE + API + indexer + PostgreSQL local, env và giới hạn coverage.
- [ ] **Step 4 — Chạy xanh:** `npm run lint -w fe`, `npm run typecheck -w fe`, `npm test -w fe`, `npm run build -w fe`, `npm run test:e2e -w fe` exit 0; kiểm tra trang thật chỉ sau khi BE có dữ liệu.
- [ ] **Step 5 — Commit:** Stage hook/e2e/CI/docs và commit `feat: refresh launch UI and test browser flows`.

## Frontend exit gate

Chạy full CI trên checkout sạch; kiểm tra API BE thật và một launch v1/v2 trên desktop/mobile khi có dữ liệu đã xác minh. Nếu BE chưa đạt coverage lịch sử hoặc V4 gate, FE vẫn hiển thị trạng thái thiếu rõ ràng; không gọi đó là sản phẩm dữ liệu đầy đủ. Chỉ push mốc đã kiểm chứng, không deploy.
