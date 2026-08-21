# API và luồng nội bộ

Các endpoint đọc hoặc ghi dữ liệu vận hành chỉ chấp nhận người dùng đã xác thực của Site, request localhost khi phát triển, hoặc header nội bộ:

```text
Authorization: Bearer <INTERNAL_API_SECRET>
```

Không gửi token nền tảng, App Secret hoặc khóa webhook trong body hay query string của các API dưới đây. Response lỗi có dạng:

```json
{
  "error": { "code": "ERROR_CODE", "message": "Mô tả an toàn" },
  "requestId": "uuid"
}
```

## Trang thao tác

- `GET /channels` — danh sách bảy kho kênh độc lập.
- `GET /channels/:provider` — giao diện làm việc của một kênh.
- `GET /connections` — trung tâm kết nối.
- `GET /connections/guide` — hướng dẫn kết nối từng bước.

Các `provider` hợp lệ cho kho kênh:

```text
google_drive · google_sheets · facebook · zalo_personal · tiktok_shop · shopee · website
```

Google Drive và Google Sheets dùng chung connection provider `google`, nhưng media, bản nháp và số liệu của hai kho vẫn được tách bằng channel ID.

## Kết nối

- `GET /api/integrations` — trạng thái và mức sẵn sàng của từng kênh.
- `POST /api/integrations/:provider/connect` — bắt đầu OAuth hoặc bật connector trực tiếp.
- `GET /api/integrations/google/callback`
- `GET /api/integrations/facebook/callback`
- `GET /api/integrations/shopee/callback`
- `GET /api/integrations/tiktok-shop/callback`

## Dữ liệu nguồn

- `POST /api/integrations/google/sync`

Body tùy chọn:

```json
{ "connectionId": "google-connection-id" }
```

## Kho nội dung theo kênh

### Danh sách kênh

- `GET /api/channels`

Trả về trạng thái kết nối, các kết nối an toàn không chứa token, số media/bản nháp/job đang chờ/đã đăng, thời điểm hoạt động gần nhất và danh sách thao tác được hỗ trợ của từng kênh.

```json
{
  "data": {
    "channels": [
      {
        "id": "facebook",
        "name": "Facebook Page",
        "status": "connected",
        "connectionId": "connection-id",
        "counts": { "media": 12, "products": 3, "drafts": 4, "queued": 1, "published": 8 },
        "actions": ["connect", "upload", "create_draft", "schedule", "publish"]
      }
    ]
  }
}
```

### Chi tiết một kênh

- `GET /api/channels/:provider?limit=50`

`limit` mặc định là `50`, tối đa `100`. Response gồm `channel`, `stats`, `media`, `drafts`, `jobs` và `products`. Danh sách `products` là bộ chọn sản phẩm của workspace hiện tại để tạo bản nháp; không phải danh sách sản phẩm đã xuất bản lên kênh.

Ảnh/video trả về `downloadUrl` riêng tư. Việc tải tệp dùng `GET /api/media/:id/download` và cũng yêu cầu xác thực.

### Tạo bản nháp

- `POST /api/channels/:provider/drafts`
- `Content-Type: application/json`
- Request tối đa `64 KB`.

```json
{
  "productId": "product-id-trong-workspace",
  "title": "Tiêu đề tùy chọn",
  "body": "Nội dung bài viết",
  "contentType": "social_post",
  "hashtags": ["TAHA", "SanPhamMoi"]
}
```

`productId` là bắt buộc theo mô hình dữ liệu hiện tại. Phải có ít nhất `title` hoặc `body`. Nếu bỏ `contentType`, hệ thống dùng loại mặc định của kênh:

| Kênh | Loại nội dung cho phép |
|---|---|
| Google Drive | `website_article` |
| Google Sheets | `product_listing`, `website_article` |
| Facebook | `social_post` |
| Zalo cá nhân | `social_post` |
| TikTok Shop | `short_video_caption`, `product_listing` |
| Shopee | `product_listing` |
| Website | `website_article`, `product_listing` |

Response thành công dùng HTTP `201` và trả về `{ "data": { "draft": ... } }`.

### Tải ảnh hoặc video

- `POST /api/channels/:provider/upload`
- `Content-Type: multipart/form-data`

Các field:

- `file` — bắt buộc.
- `altText` — mô tả ảnh, tối đa 500 ký tự.
- `productId` — tùy chọn; nếu có, media được gắn vào sản phẩm cùng workspace.
- `draftId` — tùy chọn; nếu có, bản nháp phải thuộc đúng kho kênh đang tải lên.

Định dạng và giới hạn:

| Nhóm | MIME được chấp nhận | Giới hạn mỗi tệp |
|---|---|---|
| Ảnh | JPEG, PNG, WEBP, GIF | 15 MB |
| Video | MP4, WEBM, QuickTime/MOV | 50 MB |

Hệ thống kiểm tra MIME, dung lượng và chữ ký đầu tệp. Bytes được lưu riêng tư trong R2; D1 chỉ lưu metadata, channel ID và quan hệ sản phẩm/bản nháp. Nếu ghi D1 thất bại sau upload, object R2 được xóa bù. Response thành công dùng HTTP `201` và trả về `{ "data": { "media": ... } }`.

### Dùng lại ảnh nguồn Google Drive

- `POST /api/channels/:provider/media/import`
- `Content-Type: application/json`

```json
{ "mediaIds": ["media-id-1", "media-id-2"] }
```

Mỗi lần nhận từ 1 đến 20 media ID. Đích hợp lệ là `facebook`, `zalo_personal`, `tiktok_shop`, `shopee` hoặc `website`. Media phải thuộc kho nguồn Google Drive của cùng workspace và ở trạng thái `ready`. API tạo quan hệ nhiều-kênh, không sao chép bytes; gọi lại cùng danh sách là idempotent. Response trả `{ "data": { "imported": 2, "alreadyLinked": 0 } }`.

### Điều kiện cơ sở dữ liệu

Trước khi dùng `/api/channels`, phải áp dụng **toàn bộ** migration trong `drizzle/` theo thứ tự `0000`, `0001`, `0002`, ... . Local D1 mới hoàn toàn không có các bảng nền nên không được chỉ chạy migration mới nhất. Gói triển khai Sites production chạy toàn bộ migration có trong package.

## Lịch đăng

- `GET /api/schedules?status=active&limit=50` — lấy danh sách lịch trong workspace hiện tại.
- `POST /api/schedules` — tạo lịch ở trạng thái `draft`.
- `POST /api/schedules/:id/activate` — kiểm tra lại nội dung, media và kết nối rồi kích hoạt.
- `POST /api/schedules/:id/pause` — tạm dừng lịch đang hoạt động.

Mỗi lần tạo phải có `idempotencyKey` ổn định. Gửi lại cùng key và cùng dữ liệu trả về lịch cũ; dùng lại key với dữ liệu khác trả về `409`.

Lịch một lần:

```json
{
  "idempotencyKey": "launch-pegasus-facebook-2026-08-22",
  "draftId": "approved-draft-id",
  "connectionId": "facebook-page-connection-id",
  "scheduleKind": "once",
  "runAt": "2026-08-22T09:00:00+07:00",
  "timezone": "Asia/Ho_Chi_Minh",
  "executionMode": "inherit",
  "publishOptions": {}
}
```

Lịch hàng ngày dùng `localTime` theo giờ Việt Nam:

```json
{
  "idempotencyKey": "daily-zalo-0900-v1",
  "draftId": "approved-draft-id",
  "connectionId": "zalo-assisted-connection-id",
  "scheduleKind": "daily",
  "localTime": "09:00",
  "timezone": "Asia/Ho_Chi_Minh",
  "executionMode": "assisted"
}
```

Lịch hàng tuần thêm `weekdays`; thứ Hai đến thứ Bảy là `1` đến `6`, Chủ nhật dùng `0` hoặc `7`:

```json
{
  "idempotencyKey": "weekly-shopee-mon-thu-v1",
  "draftId": "approved-draft-id",
  "connectionId": "shopee-connection-id",
  "scheduleKind": "weekly",
  "localTime": "19:30",
  "weekdays": [1, 4],
  "timezone": "Asia/Ho_Chi_Minh",
  "endsAt": "2026-12-31T23:59:59+07:00"
}
```

Nội dung phải ở trạng thái `approved`, có ít nhất một media `ready`, và kết nối phải ở trạng thái `connected`. Kênh Zalo cá nhân luôn được lưu ở chế độ `assisted`. `nextRunAt` được tính lại khi kích hoạt hoặc kích hoạt lại lịch.

## Xuất bản

Trạng thái thật của connector:

- Facebook Page và Website: dispatcher đã gửi tự động các job hợp lệ đến hạn.
- Zalo cá nhân: chỉ tạo gói nội dung `assisted`; chủ tài khoản tự đăng rồi xác nhận. Không có bot Zalo cá nhân.
- TikTok Shop và Shopee: OAuth/token refresh đã có, nhưng dispatcher cố ý chặn listing write cho tới khi ứng dụng live được duyệt và ánh xạ dữ liệu thị trường hoàn chỉnh.

Facebook:

```json
{
  "connectionId": "facebook-page-connection-id",
  "message": "Nội dung đã duyệt",
  "mediaIds": ["media-id-1"],
  "idempotencyKey": "schedule:abc:1787200000000"
}
```

Website:

```json
{
  "connectionId": "website-connection-id",
  "payload": { "type": "product", "title": "Sản phẩm" },
  "idempotencyKey": "listing:sku:version"
}
```

Zalo cá nhân:

```json
{
  "connectionId": "zalo-assisted-connection-id",
  "message": "Caption đã duyệt",
  "mediaIds": ["media-id-1"],
  "idempotencyKey": "zalo:schedule:time"
}
```

Mọi lần xuất bản tạo một record `publish_jobs`. Cùng một idempotency key không được gửi lại âm thầm; lỗi không rõ kết quả phải đối soát trước khi retry.
