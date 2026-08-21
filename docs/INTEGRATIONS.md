# Thiết lập các kênh

## Quy tắc chung

- Domain callback phải là HTTPS và trùng chính xác với URL đã đăng ký trong developer console.
- Các giá trị secret chỉ được nhập vào môi trường triển khai.
- Không gửi secret, access token, refresh token hoặc cookie qua chat và không commit vào GitHub.
- Thử một tài khoản/kênh và một sản phẩm trước khi bật lịch tự động.

## Google Drive và Google Sheet

Google Cloud Project cần bật Drive API và Sheets API. OAuth callback:

```text
/api/integrations/google/callback
```

Quyền đọc nguồn mặc định là `drive.readonly`; `openid`, `email` và `profile` chỉ dùng để đặt nhãn đúng tài khoản cho connection. Nếu endpoint profile tạm lỗi, token Drive vẫn được lưu và kết nối nguồn vẫn hoàn tất. Với mô hình một chủ sở hữu, có thể chuyển sang service account và chỉ chia sẻ đúng thư mục/Sheet nguồn ở giai đoạn sau.

Sau khi kết nối, gọi `POST /api/integrations/google/sync` để:

1. Đọc bảng sản phẩm.
2. Tạo/cập nhật sản phẩm và biến thể mặc định.
3. Tìm thư mục Drive có tên trùng SKU.
4. Lưu metadata ảnh và liên kết chúng với sản phẩm.

## Facebook Page

Tạo Meta App với use case **Manage everything on your Page**, sau đó thêm các quyền:

- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_posts`

Trong **Facebook Login for Business → Configurations**, tạo một configuration loại `General`, chọn `User access token`, thêm đúng ba quyền trên và lưu `Configuration ID`. TAHA AI dùng ID này qua `META_LOGIN_CONFIG_ID`; luồng Facebook Login for Business truyền `config_id` thay cho danh sách `scope` trong URL OAuth.

Callback:

```text
/api/integrations/facebook/callback
```

Thêm callback chính xác vào **Facebook Login for Business → Settings → Valid OAuth Redirect URIs**. Cấu hình máy chủ cần `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_GRAPH_API_VERSION` và `META_REDIRECT_URI`.

Người cấp quyền phải có quyền tạo nội dung trên Page. Khi OAuth hoàn tất, TAHA AI lưu từng Page như một connection riêng. Endpoint `POST /api/publish/facebook` nhận nội dung, media ID và idempotency key; ảnh Drive được tải bằng quyền Google rồi upload nhị phân lên Meta.

## Zalo cá nhân

Không có OAuth/API chính thức để máy chủ tự đăng Nhật ký cá nhân. Connector dùng `manual_assist`:

- `POST /api/publish/zalo-personal/prepare`
- Sao chép caption và tải ảnh từ các URL trả về.
- Người dùng đăng bằng ứng dụng Zalo chính thức.
- `POST /api/publish-jobs/:id/confirm` để xác nhận kết quả.

Không thêm cookie, QR session, emulator hoặc browser bot.

## Shopee Seller

Shopee live app tại thị trường Việt Nam cần module Shop/Auth, Product read/write, Media Space và Push Mechanism. Callback:

```text
/api/integrations/shopee/callback
```

TAHA AI đã tạo URL ký HMAC, đổi authorization code và lưu token/shop ID. Việc `add_item` chỉ bật sau khi live app được duyệt và sản phẩm có đủ leaf category, thuộc tính bắt buộc, vận chuyển, cân nặng/kích thước và image ID từ Media Space.

## TikTok Shop

Phạm vi tối thiểu:

- `seller.authorization.info`
- `seller.product.basic`
- `seller.product.write`

Callback:

```text
/api/integrations/tiktok-shop/callback
```

TAHA AI đổi code lấy token và lưu dữ liệu seller/shop. Việc tạo listing chỉ bật sau khi kiểm tra listing prerequisites, category/attributes, image upload URI và yêu cầu KYC/audit của shop Việt Nam.

## Website bán hàng

Website nhận JSON tại `WEBSITE_PUBLISH_ENDPOINT`. TAHA AI gửi:

```text
Content-Type: application/json
X-TAHA-Signature: sha256=<HMAC-SHA256(raw-body)>
X-TAHA-Idempotency-Key: <unique-key>
```

Website phải kiểm tra chữ ký bằng `WEBSITE_WEBHOOK_SECRET`, chống xử lý trùng và trả JSON có thể gồm `id` và `url`.
