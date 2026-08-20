# TAHA AI

TAHA AI là trung tâm vận hành nội dung và sản phẩm đa kênh dành cho một doanh nghiệp:

```text
Google Drive + Google Sheet
              ↓
      Kho sản phẩm trung tâm
              ↓
        Duyệt và lên lịch
              ↓
Facebook · Zalo cá nhân · Website · Shopee · TikTok Shop
```

## Trạng thái MVP

Đã có:

- Dashboard vận hành bằng tiếng Việt, responsive cho máy tính và điện thoại.
- Trung tâm kết nối Google, Facebook Page, Zalo cá nhân, Shopee, TikTok Shop và website.
- OAuth có `state` dùng một lần; token kết nối được mã hóa AES-GCM trước khi lưu.
- Đồng bộ Google Sheet thành sản phẩm/biến thể và gắn ảnh theo thư mục SKU trên Google Drive.
- Đăng bài Facebook Page bằng API chính thức, gồm bài chữ và tối đa 10 ảnh.
- Gửi nội dung sang website bằng webhook ký HMAC.
- Zalo cá nhân ở chế độ hỗ trợ: chuẩn bị caption, tải ảnh, chờ người dùng đăng và xác nhận.
- Mô hình dữ liệu D1 cho sản phẩm, media, nội dung, lịch đăng, hàng đợi, ánh xạ kênh và nhật ký.
- Chống đăng trùng bằng idempotency key và lưu toàn bộ trạng thái publish job.
- API tạo, kích hoạt và tạm dừng lịch; scheduler tạo job theo giờ Việt Nam.
- Dispatcher có lease, retry giới hạn và tự gửi job Facebook/website đến hạn.

Đang chờ cấu hình/quyền từ nền tảng:

- Shopee và TikTok Shop đã có luồng ủy quyền tài khoản. Bước ghi listing chỉ bật sau khi ứng dụng live được duyệt module sản phẩm/media và đã chốt ánh xạ danh mục thuộc tính tại thị trường Việt Nam.
- Phần sinh nội dung/hình ảnh AI chưa gọi nhà cung cấp cho tới khi khóa API được cấu hình an toàn.

## Chạy dự án

Yêu cầu Node.js `>=22.13.0`.

```bash
corepack enable
pnpm install
pnpm run dev
pnpm run build
```

Mở `http://localhost:3000` và chọn **Kết nối kênh**.

## Cấu hình an toàn

1. Sao chép `.env.example` thành tệp môi trường chỉ tồn tại trên máy chủ.
2. Thay toàn bộ domain mẫu bằng domain HTTPS thật.
3. Nhập app ID/secret trong secret manager của môi trường triển khai, không commit tệp chứa bí mật.
4. Áp dụng migration trong `drizzle/` cho D1 trước khi thực hiện OAuth.
5. Đăng ký chính xác callback URL hiển thị trong `.env.example` ở từng developer console.
6. Cấu hình một cron trigger gọi `POST /api/internal/cron/tick` mỗi phút bằng Bearer `INTERNAL_API_SECRET`, hoặc bật Scheduled Worker tương ứng.

Không nhập access token cố định vào source code. Access/refresh token phát sinh sau OAuth được mã hóa trong bảng `channel_connections`.

## Dữ liệu Google

- Google Sheet dùng hàng đầu tiên làm tiêu đề.
- Cột tối thiểu: `SKU`, `Tên sản phẩm`, `Giá bán`, `Tồn kho`, `Trạng thái`.
- Cột nên có thêm: `Thương hiệu`, `Danh mục`, `Mô tả`, `Giá sale`.
- Trong thư mục Drive nguồn, mỗi sản phẩm là một thư mục con có tên đúng bằng SKU.

Ví dụ:

```text
/SAN-PHAM-MOI
  /NIKE-PG41-WHITE
    01-mat-truoc.jpg
    02-goc-nghieng.jpg
```

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
