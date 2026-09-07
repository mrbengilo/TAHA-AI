# TAHA AI

TAHA AI là trung tâm vận hành nội dung và sản phẩm đa kênh dành cho một doanh nghiệp:

Một lần xác nhận → đối chiếu Sheet và thư mục Drive theo SKU → AI viết bài, mô tả, hashtag → tự lên lịch → tự đăng Facebook. Admin có thể sửa hoặc chặn trước khi bắt đầu gửi.

## Trạng thái MVP

Đã có:

- Dashboard vận hành bằng tiếng Việt, font Arial, responsive cho máy tính và điện thoại; bố cục gồm thanh điều hướng, chỉ số thật, trạng thái kết nối, công việc AI, lịch sắp tới và hoạt động gần đây.
- Trung tâm kết nối Google, Facebook Page, Zalo cá nhân, Shopee, TikTok Shop và website.
- Khu vực **Quản lý từng kênh** có dữ liệu thật, tách riêng Google Drive, Google Sheets, Facebook, Zalo, TikTok Shop, Shopee và Website.
- Mỗi kho kênh cho phép xem ảnh/video, bài viết, hàng đợi và sản phẩm; tạo bản nháp, tải media vào R2 và dùng lại ảnh Drive ở nhiều kênh mà không nhân bản tệp.
- OAuth có `state` dùng một lần; token kết nối được mã hóa AES-GCM trước khi lưu.
- Đồng bộ Google Sheet thành sản phẩm/biến thể và gắn ảnh theo thư mục SKU trên Google Drive.
- Trung tâm **AI Automation** tự viết nội dung, mô tả sản phẩm và hashtag từ dữ liệu Sheet; sử dụng từ 1 đến 10 ảnh gốc đúng thư mục `SKU <SKU>` trên Drive. Không tạo ảnh mới.
- Trước khi viết và đăng, hệ thống đồng bộ lại nguồn, đối chiếu SKU, thư mục, ảnh và dấu vân tay thông tin sản phẩm. Sai nguồn hoặc dữ liệu đã đổi sẽ chặn đăng.
- Worker automation có lease, retry giới hạn, chống chạy trùng, theo dõi từng bước nội dung/hoàn tất và tạo bản nháp đã duyệt cho các kênh được chọn.
- Đăng bài Facebook Page bằng API chính thức, gồm bài chữ và tối đa 10 ảnh.
- Gửi nội dung sang website bằng webhook ký HMAC.
- Zalo cá nhân ở chế độ hỗ trợ: chuẩn bị caption, tải ảnh, chờ người dùng đăng và xác nhận.
- Mô hình dữ liệu D1 cho sản phẩm, media, nội dung, lịch đăng, hàng đợi, ánh xạ kênh và nhật ký.
- Chống đăng trùng bằng idempotency key và lưu toàn bộ trạng thái publish job.
- API tạo, kích hoạt và tạm dừng lịch; scheduler tạo job theo giờ Việt Nam.
- Dispatcher có lease, retry giới hạn và tự gửi job Facebook/website đến hạn. Zalo cá nhân luôn là tác vụ hỗ trợ cần chủ tài khoản bấm đăng.

Đang chờ cấu hình/quyền từ nền tảng:

- Hồ sơ Shopee Open Platform và TikTok Shop Partner/App vẫn đang chờ nền tảng xét duyệt. Hệ thống chỉ tạo listing draft; không báo kết nối/live giả và không gọi API ghi sản phẩm trước khi quyền thật được cấp.
- OpenAI chỉ chạy khi `OPENAI_API_KEY` được cấu hình trong secret của VPS. Khóa không nằm trong repository và không được trả về trình duyệt hoặc log.

## Các trang chính

- `/` — tổng quan vận hành.
- `/channels` — danh sách bảy kho kênh độc lập.
- `/channels/:provider` — ảnh, bài viết, hàng đợi và sản phẩm của một kênh. Giá trị `provider` hợp lệ: `google_drive`, `google_sheets`, `facebook`, `zalo_personal`, `tiktok_shop`, `shopee`, `website`.
- `/connections` — trạng thái kết nối và thao tác OAuth.
- `/connections/guide` — hướng dẫn kết nối từng nền tảng theo từng bước.
- `/automation` — xác nhận SKU và kênh; theo dõi bước viết bài, hoàn tất và lịch đăng.
- `/products/:id` — thư mục riêng của SKU, tách ảnh gốc, mô tả Sheet, bài AI, lịch đăng và kết quả; admin sửa/chặn tại đây.
- `/content` — danh sách thư mục nội dung theo SKU.

## Mức tự động hiện tại

| Kênh | Trạng thái thực tế |
|---|---|
| Google Drive và Google Sheets | OAuth và đồng bộ Sheet; chỉ lấy ảnh gốc trong thư mục chuẩn `SKU <SKU>`. Không yêu cầu ghi ảnh cho automation. |
| Facebook Page | Đã có OAuth, đăng bài chữ/ảnh bằng API chính thức, lưu Post ID và dispatcher tự xử lý job đến hạn. |
| Zalo cá nhân | Chỉ hỗ trợ chuẩn bị caption/ảnh và chờ chủ tài khoản xác nhận đã đăng. Không tự động điều khiển Zalo Web, cookie hay phiên QR. |
| Website | Đã gửi được payload qua webhook ký HMAC và dispatcher tự xử lý job đến hạn. Website nhận phải triển khai endpoint tương thích. |
| TikTok Shop | Đã có connector OAuth và kiểm tra listing tại chỗ, nhưng Partner/App/scopes còn chờ duyệt. Nút đăng chỉ xếp job khi có connection thật, draft đã duyệt, ảnh sẵn sàng và đủ dữ liệu danh mục/kho/khối lượng/biến thể. |
| Shopee | Connector OAuth đã có, nhưng hồ sơ Open Platform còn chờ duyệt. Nút đăng hiện trả trạng thái chờ phê duyệt; chưa gửi `add_item`. |

## Chạy dự án

Yêu cầu Node.js `>=22.13.0`.

```bash
corepack enable
pnpm install
pnpm run dev
pnpm run build
```

Mở địa chỉ Vite in ra khi chạy `pnpm dev` và chọn **Kết nối kênh**.

## Cấu hình an toàn

1. Sao chép `.env.example` thành tệp môi trường chỉ tồn tại trên máy chủ.
2. Thay toàn bộ domain mẫu bằng domain HTTPS thật.
3. Nhập app ID/secret trong secret manager của môi trường triển khai, không commit tệp chứa bí mật.
4. Áp dụng **toàn bộ** migration trong `drizzle/` theo thứ tự tên tệp cho D1 trước khi thực hiện OAuth hoặc mở kho kênh. Local/VPS mới hoàn toàn phải chạy từ `0000`; migration `0003` tạo hàng đợi automation.
5. Đăng ký chính xác callback URL hiển thị trong `.env.example` ở từng developer console.
6. Trên VPS, cấu hình cron/systemd timer gọi `POST /api/internal/cron/tick` mỗi phút bằng Bearer `INTERNAL_API_SECRET` lưu root-only.

Không nhập access token cố định vào source code. Access/refresh token phát sinh sau OAuth được mã hóa trong bảng `channel_connections`.

## Dữ liệu Google

- Google Sheet dùng hàng đầu tiên làm tiêu đề.
- Cột tối thiểu: `SKU`, `Tên sản phẩm`, `Giá bán`, `Tồn kho`, `Trạng thái`.
- Cột nên có thêm: `Thương hiệu`, `Danh mục`, `Mô tả`, `Giá sale`.
- Trong thư mục Drive nguồn, mỗi sản phẩm phải dùng đúng một thư mục `SKU <mã SKU>`, ví dụ Sheet `PH0006` ↔ Drive `SKU PH0006`.
- Ảnh ở thư mục gốc hoặc thư mục thiếu tiền tố `SKU ` không được dùng để tự động đăng.
- Tài khoản Google cần quyền đọc Sheet và thư mục ảnh. Quyền ghi hiện hữu chỉ phục vụ API xuất media cũ, không bắt buộc cho luồng này.

Ví dụ:

```text
/SAN-PHAM-MOI
  /SKU NIKE-PG41-WHITE
    01-mat-truoc.jpg
    02-goc-nghieng.jpg
```

Mỗi sản phẩm cần ít nhất một ảnh gốc. Một bài Facebook dùng tối đa 10 ảnh đã kiểm tra của cùng SKU. Xác nhận tự tạo draft đã sẵn sàng đăng và lịch, không có bước duyệt bắt buộc thứ hai. Admin có thể sửa nội dung/hashtag hoặc chọn **Không cho đăng** khi bài còn chờ.

## Nguyên tắc Zalo cá nhân

TAHA AI không lưu cookie, không điều khiển Zalo Web, không giữ phiên QR và không dùng API nội bộ. Hệ thống chỉ chuẩn bị bài và yêu cầu chủ tài khoản bấm đăng. Khi cần tự động hóa chính thức tin nhắn/webhook, bổ sung Zalo OA như một connector riêng.

## Tài liệu

- [Danh sách liên kết và thông tin cần chuẩn bị](docs/CONNECTION_REQUEST.md)
- [Thiết lập các kênh](docs/INTEGRATIONS.md)
- [API nội bộ và publish flow](docs/API.md)
- [Kiến trúc triển khai](docs/DEPLOYMENT.md)

## Công nghệ

- Vinext + React 19
- Cloudflare Workers runtime
- Cloudflare D1 + Drizzle ORM
- Cloudflare R2 cho media
- CSS responsive không phụ thuộc bộ UI bên ngoài
