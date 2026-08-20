# API nội bộ

Các endpoint ghi dữ liệu chỉ chấp nhận người dùng đã xác thực của Site, request localhost khi phát triển, hoặc header:

```text
Authorization: Bearer <INTERNAL_API_SECRET>
```

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
