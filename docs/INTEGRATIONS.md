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

Luồng tự động chỉ cần đọc ảnh nguồn Drive và đọc bảng Products bằng `spreadsheets.readonly`. Quyền `drive` hiện hữu cũng hỗ trợ API xuất media cũ khi được sử dụng riêng. `openid`, `email` và `profile` chỉ đặt nhãn đúng tài khoản cho connection. Nếu endpoint profile tạm lỗi, token Drive vẫn được lưu và kết nối nguồn vẫn có thể hoàn tất.

Đây là thay đổi từ cấu hình `drive.readonly`. Token cũ không tự nhận thêm quyền: sau khi sửa consent screen và biến `GOOGLE_OAUTH_SCOPES`, phải ngắt/kết nối lại Google và chấp thuận màn hình consent mới. Nếu không, upload trả `GOOGLE_WRITE_SCOPE_REQUIRED` hoặc connection chuyển sang yêu cầu re-auth. Scope `drive` là restricted; ứng dụng External có thể phải hoàn tất Google verification. Không giảm xuống `drive.file` khi chưa bổ sung Google Picker và kiểm tra quyền với thư mục nguồn hiện hữu.

Sau khi kết nối, gọi `POST /api/integrations/google/sync` để:

1. Đọc bảng sản phẩm.
2. Tạo/cập nhật sản phẩm và biến thể mặc định.
3. Chuẩn hóa SKU (Unicode, khoảng trắng, dấu gạch ngang, chữ hoa), từ chối SKU trùng trong Sheet.
4. Chỉ lấy ảnh trong đúng một thư mục chuẩn `SKU <SKU>`; bỏ qua tên file ở thư mục gốc.
5. Lưu metadata ảnh và liên kết chúng với sản phẩm. Tối đa 20 ảnh nguồn được gắn cho mỗi sản phẩm trong một lần đồng bộ.

API xuất media cũ, không được automation gọi: ảnh AI/derived được lưu bằng `POST /api/integrations/google/drive/import`. Hệ thống dùng thư mục đã ghi trong metadata lần sync, gắn app property `tahaMediaId` và không tạo bản sao khi gọi lại. Tài khoản phải có quyền chỉnh sửa thư mục SKU. Nếu không tìm thấy thư mục/ảnh nguồn để xác định vị trí đích, hệ thống giữ ảnh trong R2 và báo rõ lỗi thay vì tải sai chỗ.

## OpenAI viết nội dung

Runtime cần `OPENAI_API_KEY` và có thể chọn `OPENAI_TEXT_MODEL`. Khóa chỉ lưu root-only trên VPS. Responses API dùng JSON Schema nghiêm ngặt để viết mô tả, hashtag và bài theo kênh từ dữ liệu Sheet. Output phải khớp SKU. Automation không gọi Images API, không cần cấu hình model ảnh và không xuất ảnh mới về Drive.

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

Người cấp quyền phải có quyền tạo nội dung trên Page. Khi OAuth hoàn tất, TAHA AI kiểm tra token thực tế qua `debug_token`: đúng app, đúng Page, còn hiệu lực, đủ ba quyền và đúng Page trong các quyền chi tiết. Chỉ kết nối đủ quyền mới được đánh dấu sẵn sàng đăng. Nút **Kiểm tra quyền đăng bài** kiểm tra lại token hiện hữu qua `POST /api/integrations/facebook/verify`; token thiếu quyền được giữ để chẩn đoán nhưng connection chuyển sang lỗi, không dùng để đăng.

Nếu token chỉ có `pages_show_list`, vào **Facebook Login for Business → Configurations**, thêm `pages_read_engagement` và `pages_manage_posts` cho configuration đang dùng, rồi chủ Page bấm **Kết nối lại** và cấp quyền. Token đã cấp không tự nhận các quyền mới. Không thêm `scope` vào URL để thay cho cấu hình Business Login.

Endpoint `POST /api/publish/facebook` nhận `draftId`, `connectionId` và idempotency key; server lấy nội dung và ảnh đã duyệt của đúng SKU. Ảnh Drive được tải bằng quyền Google rồi upload nhị phân lên Meta.

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

Website nhận JSON tại `WEBSITE_PUBLISH_ENDPOINT`. TAHA AI gửi hợp đồng phiên bản
`taha.website.product.v1` với thao tác `upsert_product`, khóa chính nghiệp vụ là SKU,
giá/tồn kho/thuộc tính lấy từ Google Sheet và tối đa 6 ảnh đúng thư mục SKU. Mô tả
website được tạo riêng theo bố cục sản phẩm hiện có trên tahashoes.vn. Các bộ đếm
đánh giá/đã bán chỉ được gửi khi quản trị viên nhập rõ trong Sheet; nếu thiếu, website
giữ giá trị hiện có hoặc khởi tạo 0/ẩn.

TAHA AI gửi:

```text
Content-Type: application/json
X-TAHA-Signature: sha256=<HMAC-SHA256(raw-body)>
X-TAHA-Idempotency-Key: <unique-key>
```

Website phải kiểm tra chữ ký bằng `WEBSITE_WEBHOOK_SECRET`, chống xử lý trùng và trả JSON có thể gồm `id` và `url`.

Sau khi receiver đã được triển khai và kiểm thử, đặt `WEBSITE_READY_BACKFILL_ENABLED=1`.
Khi đó mọi SKU có bài Facebook trạng thái `approved` nhưng chưa có bản website sẽ
được tạo bản website độc lập và đưa vào hàng đợi ngay trong tick kế tiếp; không chờ
lịch một bài mỗi ngày. Upsert cùng SKU phải cập nhật sản phẩm hiện có thay vì tạo bản
trùng.
