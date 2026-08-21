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

Scope production hiện tại phải khớp `.env.example` và code OAuth:

```text
openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets.readonly
```

`drive` được dùng để vừa đọc ảnh nguồn vừa tải ảnh generated về thư mục SKU hiện có; `spreadsheets.readonly` chỉ đọc bảng Products. `openid`, `email` và `profile` chỉ đặt nhãn đúng tài khoản cho connection. Nếu endpoint profile tạm lỗi, token Drive vẫn được lưu và kết nối nguồn vẫn có thể hoàn tất.

Đây là thay đổi từ cấu hình `drive.readonly`. Token cũ không tự nhận thêm quyền: sau khi sửa consent screen và biến `GOOGLE_OAUTH_SCOPES`, phải ngắt/kết nối lại Google và chấp thuận màn hình consent mới. Nếu không, upload trả `GOOGLE_WRITE_SCOPE_REQUIRED` hoặc connection chuyển sang yêu cầu re-auth. Scope `drive` là restricted; ứng dụng External có thể phải hoàn tất Google verification. Không giảm xuống `drive.file` khi chưa bổ sung Google Picker và kiểm tra quyền với thư mục nguồn hiện hữu.

Sau khi kết nối, gọi `POST /api/integrations/google/sync` để:

1. Đọc bảng sản phẩm.
2. Tạo/cập nhật sản phẩm và biến thể mặc định.
3. Chuẩn hóa SKU (Unicode, khoảng trắng, dấu gạch ngang, chữ hoa), từ chối SKU trùng trong Sheet.
4. Ưu tiên thư mục con có tên trùng SKU; nếu không có, khớp file ảnh ở thư mục gốc khi tên file chứa SKU với ranh giới rõ ràng.
5. Lưu metadata ảnh và liên kết chúng với sản phẩm. Tối đa 20 ảnh nguồn được gắn cho mỗi sản phẩm trong một lần đồng bộ.

Ảnh AI/derived được lưu bằng `POST /api/integrations/google/drive/import`. Hệ thống dùng thư mục đã ghi trong metadata lần sync, gắn app property `tahaMediaId` và không tạo bản sao khi gọi lại. Tài khoản phải có quyền chỉnh sửa thư mục SKU. Nếu không tìm thấy thư mục/ảnh nguồn để xác định vị trí đích, hệ thống giữ ảnh trong R2 và báo rõ lỗi thay vì tải sai chỗ.

## OpenAI tạo nội dung và hình ảnh

Các biến runtime:

```dotenv
OPENAI_API_KEY=<SERVER_SECRET>
OPENAI_TEXT_MODEL=gpt-5.6-luna
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_QUALITY=medium
```

`OPENAI_API_KEY` chỉ lưu trong secret root-only của VPS, không commit, không đưa vào image Docker, trình duyệt, response hoặc log. Model text dùng Responses API với JSON Schema nghiêm ngặt để tạo mô tả, hashtag, sáu brief bố cục và nội dung riêng cho từng kênh. Model ảnh dùng Images Edits API với ảnh nguồn, tạo PNG vuông 1024×1024; prompt yêu cầu giữ nguyên hình dáng, tỷ lệ, màu, chất liệu, họa tiết, đường may, logo, nhãn và các chi tiết nhận diện sản phẩm, chỉ thay nền/bối cảnh/ánh sáng/cách trình bày.

Mặc định UI yêu cầu 6 ảnh, nhưng API cho phép từ 1 đến 6. Ảnh hoàn tất được lưu R2 trước rồi mới xuất Drive, vì vậy lỗi Google tạm thời không làm mất kết quả AI.

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

Shopee live app tại thị trường Việt Nam cần module Shop/Auth, Product read/write, Media Space và Push Mechanism. Hồ sơ TAHA AI hiện vẫn **đang được Shopee xét duyệt**, nên không được đánh dấu kênh là live/connected và nút đăng trả `SHOPEE_APPROVAL_PENDING`. Callback dự kiến:

```text
/api/integrations/shopee/callback
```

TAHA AI đã có mã nguồn tạo URL ký HMAC, đổi authorization code và lưu token/shop ID. Việc `add_item` chỉ bật sau khi hồ sơ/live app được duyệt và sản phẩm có đủ leaf category, thuộc tính bắt buộc, vận chuyển, cân nặng/kích thước và image ID từ Media Space. Listing draft có thể được AI chuẩn bị trước, nhưng không đồng nghĩa đã đăng lên Shopee.

## TikTok Shop

Phạm vi tối thiểu (hiện còn chờ TikTok Shop xét duyệt/activate):

- `seller.authorization.info`
- `seller.product.basic`
- `seller.product.write`

Callback:

```text
/api/integrations/tiktok-shop/callback
```

TAHA AI có mã nguồn đổi code lấy token và lưu dữ liệu seller/shop. Partner registration, app và scopes phải được TikTok phê duyệt trước khi có connection thật. Việc tạo listing chỉ xếp job sau khi có connection `connected`, draft đã duyệt, ảnh sẵn sàng và vượt qua kiểm tra category/attributes, warehouse, khối lượng, biến thể, image upload URI cùng yêu cầu KYC/audit của shop Việt Nam. Listing draft có thể được tạo trước; hệ thống không báo đã đăng khi app còn chờ duyệt.

## Website bán hàng

Website nhận JSON tại `WEBSITE_PUBLISH_ENDPOINT`. TAHA AI gửi:

```text
Content-Type: application/json
X-TAHA-Signature: sha256=<HMAC-SHA256(raw-body)>
X-TAHA-Idempotency-Key: <unique-key>
```

Website phải kiểm tra chữ ký bằng `WEBSITE_WEBHOOK_SECRET`, chống xử lý trùng và trả JSON có thể gồm `id` và `url`.
