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

`POST /api/integrations/facebook/verify` yêu cầu operator và body `{ "connectionId": "facebook-connection-id" }`. Endpoint đọc quyền thực tế từ Meta, cập nhật trạng thái đúng connection và trả `ready`, mã lỗi an toàn cùng quyền còn thiếu. Không tạo bài hoặc thử lại publish job; token vẫn ở máy chủ. OAuth, chuẩn bị công việc mới và gửi bài cũng kiểm tra quyền Facebook thực tế.

## Dữ liệu nguồn

- `POST /api/integrations/google/sync`

Body tùy chọn:

```json
{ "connectionId": "google-connection-id" }
```

Endpoint đọc Sheet, chuẩn hóa SKU, từ chối SKU trùng, chỉ lấy ảnh trong thư mục chuẩn `SKU <SKU>`; bỏ qua ảnh thư mục gốc và thư mục thiếu tiền tố, rồi cập nhật sản phẩm/biến thể/media. Response gồm số sản phẩm, media, SKU folder khớp, file gốc khớp và sản phẩm chưa có ảnh.

### API xuất media cũ (không thuộc automation hiện tại)

- `POST /api/integrations/google/drive/import`
- `Content-Type: application/json`
- Request tối đa `16 KB`.

```json
{
  "connectionId": "google-connection-id-tuy-chon",
  "productId": "product-id",
  "mediaId": "generated-media-id",
  "filename": "SKU-001-AI-01.png"
}
```

Chỉ media ảnh `generated` hoặc `derived`, ở trạng thái `ready` và đã gắn đúng sản phẩm mới được nhận. Sản phẩm phải đến từ lần đồng bộ Google và có thư mục Drive đích đã xác định. Hệ thống tải ảnh vào đúng thư mục SKU, lưu app property `tahaMediaId` để gọi lại không tạo bản sao, rồi cập nhật metadata/audit. HTTP `201` nghĩa là vừa upload; HTTP `200` với `alreadyUploaded: true` nghĩa là file đã tồn tại.

Kết nối Google phải có quyền ghi `https://www.googleapis.com/auth/drive` hoặc `drive.file`. Cấu hình production hiện dùng quyền `drive`; connection cũ chỉ có `drive.readonly` nhận `GOOGLE_WRITE_SCOPE_REQUIRED`/`GOOGLE_REAUTH_REQUIRED` và phải kết nối lại.

## AI Automation

### Tạo và theo dõi công việc

- `GET /api/automation-runs?limit=20` — viewer/operator xem tối đa 50 công việc gần nhất.
- `POST /api/automation-runs` — operator tạo công việc, giới hạn body `32 KB`.
- `GET /api/automation-runs/:id` — xem run, từng step và các draft đã tạo.
- `POST /api/automation-runs/:id/cancel` — hủy run còn `queued` hoặc `processing`.

```json
{
  "productId": "product-id",
  "sourceMediaId": "media-id-tuy-chon",
  "idempotencyKey": "ai:product-id:2026-08-21:v1",
  "imageCount": 0,
  "targetProviders": ["facebook", "zalo_personal", "website", "tiktok_shop", "shopee"]
}
```

- `productId` và `idempotencyKey` là bắt buộc; khóa chống trùng phải dài ít nhất 8 ký tự.
- `sourceMediaId` có thể bỏ; chỉ nhận ảnh gốc Drive đã đối chiếu thư mục SKU.
- `imageCount` được giữ để tương thích client cũ nhưng luôn được chuẩn hóa về `0`; không tạo bước ảnh.
- `targetProviders` mặc định là cả năm kênh ở ví dụ. Hệ thống chỉ giữ năm identifier hợp lệ; nếu sau khi lọc không còn kênh nào thì request bị từ chối.
- Lần đầu trả HTTP `202`; gửi lại đúng key và đúng payload trả HTTP `200` cùng run với `replayed: true`. Dùng lại key cho payload khác trả `409`.

Mỗi run chỉ có `content` và `finalize`. AI trả mô tả, hashtag, nội dung theo kênh và SKU khớp nguồn. Dữ liệu Sheet được đồng bộ lại trước khi viết. Run lưu dấu vân tay sản phẩm và danh sách ảnh gốc; trước đăng phải đồng bộ và khớp lại các giá trị này.

Facebook/Website/Zalo cần đúng một connection đang kết nối trước khi xếp run (có thể chỉ định bằng `connectionIds`). Khi hoàn tất, draft tự chuyển `approved`; lịch Facebook 08:00, Zalo 09:00, Website 12:00 giờ Việt Nam gần nhất tiếp theo. Zalo vẫn assisted. TikTok/Shopee chỉ tạo listing draft.

- `GET /api/products/:id`: dữ liệu thư mục SKU, ảnh, bài viết, lịch, jobs và quyền admin.
- `PATCH /api/content-drafts/:id`: `{ "action": "edit", "version": 1, "title": "...", "body": "...", "hashtags": ["#TAHA"] }` hoặc `{ "action": "reject", "version": 1 }`. Cập nhật có kiểm tra version; từ chối nếu đã bắt đầu gửi/đã đăng. Chặn bài sẽ tạm dừng lịch và hủy jobs còn chờ trong cùng transaction.
- `POST /api/publish/facebook` và `/website` nhận `draftId`, `connectionId`; nội dung và ảnh luôn đọc từ draft đã kiểm tra phía máy chủ. HTTP 202 nghĩa là đã lên lịch, chưa phải biên nhận đăng thành công.
- `POST /api/automation-trial`: admin chạy đúng một SKU lên Facebook cho đợt triển khai này. Khóa cố định `trial:drive-only-facebook-v2`, gọi lại trả cùng run; không chọn sản phẩm khác. Lịch thử cách lúc hoàn tất 5 phút để admin có thời gian can thiệp. Xem `jobs.external_post_id` và `jobs.external_url` để xác nhận bài thật.

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

Trước khi dùng `/api/channels`, phải áp dụng **toàn bộ** migration trong `drizzle/` theo thứ tự `0000`, `0001`, `0002`, ... . Local/VPS D1 mới hoàn toàn không có các bảng nền nên không được chỉ chạy migration mới nhất. Migration `0003_lazy_hellcat.sql` tạo `automation_runs` và `automation_steps`.

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
- TikTok Shop và Shopee: connector OAuth/token refresh đã có trong mã nguồn, nhưng trạng thái live phụ thuộc phê duyệt bên ngoài. Không được coi app/connection là hoạt động chỉ vì đã tạo key hoặc draft.

### Đăng sản phẩm lên sàn bằng một nút

- `POST /api/commerce/:provider/products/:productId/publish`
- `provider` chỉ nhận `tiktok_shop` hoặc `shopee`.

Body tùy chọn:

```json
{ "connectionId": "commerce-connection-id" }
```

Shopee hiện trả `409 SHOPEE_APPROVAL_PENDING` vì hồ sơ Open Platform chưa được duyệt; không gọi `add_item`. TikTok Shop chỉ xếp job `listing_upsert` khi đồng thời có connection `connected`, draft `product_listing` đã duyệt, ảnh sẵn sàng, chưa có mapping sản phẩm từ xa và preflight đủ danh mục, kho, khối lượng/thuộc tính biến thể. Thiếu điều kiện trả lỗi `409` kèm danh sách `issues`; thành công trả HTTP `202` và job. Dedupe key dựa trên connection, product version và draft version nên bấm lại không tạo job trùng.

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

## Tick chạy nền

- `POST /api/internal/cron/tick`
- Bắt buộc `Authorization: Bearer <INTERNAL_API_SECRET>`.

Mỗi tick chạy theo thứ tự:

1. `runAutomationWorker({ limit: 1 })` — xử lý tối đa một step AI để tránh chiếm worker quá lâu;
2. scheduler tạo publish job đến hạn;
3. dispatcher phát các job đủ điều kiện.

Response trả riêng `automation`, `scheduler` và `dispatcher`. Secret chỉ được đặt trong tiến trình cron/root-only trên VPS, không dùng trong JavaScript trình duyệt.
