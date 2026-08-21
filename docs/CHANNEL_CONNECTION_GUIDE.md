# Hướng dẫn kết nối từng kênh TAHA AI

Tài liệu này áp dụng cho bản TAHA AI đang triển khai tại:

- Hệ thống: `https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site`
- Trung tâm kết nối: `https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/connections`
- Ngày đối chiếu tài liệu nền tảng: **21/08/2026**

> Không gửi App Secret, Partner Key, access token, refresh token, mật khẩu, cookie, mã OTP hoặc mã QR qua chat. Chủ tài khoản tự đăng nhập và bấm chấp thuận trên trang chính thức. Bí mật phải được nhập trực tiếp vào secret manager của máy chủ/hosting.

## 1. Thứ tự triển khai nên dùng

1. Google Drive: chuẩn bị thư mục ảnh đúng cấu trúc SKU.
2. Google Sheets: chuẩn bị bảng sản phẩm và xác nhận quyền truy cập.
3. Google OAuth: cấp quyền chung cho Drive và Sheets, sau đó chạy đồng bộ thử.
4. Website: cung cấp nền tảng/repository để cài endpoint nhận bài.
5. Facebook Page: tạo Meta App, cấp quyền Page và đăng một bài thử.
6. Zalo cá nhân: bật trợ lý đăng thủ công có xác nhận.
7. TikTok Shop và Shopee: hoàn tất hồ sơ đối tác, ứng dụng và quyền API trước; sau đó mới ủy quyền shop.

Google Drive và Google Sheets xuất hiện thành hai khu vực dữ liệu riêng, nhưng bản hiện tại dùng **một phiên Google OAuth** vì cùng một tài khoản Google cấp quyền cho cả hai API.

## 2. Google Drive — kho hình ảnh gốc

### 2.1. Việc chủ tài khoản cần làm

1. Đăng nhập [Google Drive](https://drive.google.com/) bằng tài khoản sẽ kết nối với TAHA AI.
2. Tạo một thư mục gốc, ví dụ `TAHA-AI-SAN-PHAM`.
3. Bên trong thư mục gốc, tạo **một thư mục cho mỗi SKU**. Tên thư mục phải trùng chính xác với SKU trong Google Sheets, không phân biệt chữ hoa/thường.
4. Đưa ảnh của sản phẩm vào thư mục SKU tương ứng.
5. Mở thư mục gốc và sao chép ID nằm sau `/folders/` trong URL.

Cấu trúc mẫu:

```text
TAHA-AI-SAN-PHAM/                 ← GOOGLE_DRIVE_FOLDER_ID
├── SP-001/
│   ├── anh-chinh.jpg
│   └── anh-phu-01.jpg
├── SP-002/
│   ├── anh-chinh.jpg
│   └── anh-phu-01.png
└── SP-003/
    └── anh-chinh.webp
```

TAHA AI hiện đọc tối đa 200 thư mục SKU và tối đa 20 ảnh cho mỗi sản phẩm. Ảnh đặt thẳng ở thư mục gốc không được tự gắn vào một SKU, vì vậy nên luôn dùng thư mục con theo SKU.

### 2.2. Giá trị cần nhập trên máy chủ

```dotenv
GOOGLE_DRIVE_FOLDER_ID=<ID_THU_MUC_GOC>
```

### 2.3. Điểm cần chủ tài khoản xác nhận

- Tài khoản Google dùng để bấm **Kết nối** phải xem được toàn bộ thư mục gốc và các thư mục con.
- Nếu thư mục thuộc tài khoản khác hoặc Shared Drive, chủ thư mục phải cấp quyền xem cho tài khoản kết nối.
- Không đặt thông tin bí mật trong tên file hoặc metadata ảnh.

## 3. Google Sheets — kho dữ liệu sản phẩm và bài viết nguồn

### 3.1. Chuẩn bị bảng

1. Tạo một Google Spreadsheet, ví dụ `TAHA AI - Sản phẩm`.
2. Đổi tên tab đầu tiên thành `Products`.
3. Tạo hàng tiêu đề theo mẫu dưới đây.
4. Mỗi sản phẩm phải có `SKU` duy nhất và SKU đó phải trùng tên thư mục ảnh trong Drive.
5. Sao chép Spreadsheet ID nằm giữa `/spreadsheets/d/` và `/edit` trong URL.

Các cột được bản hiện tại nhận diện:

| Cột | Bắt buộc | Ví dụ |
|---|---:|---|
| `SKU` | Có | `SP-001` |
| `Tên sản phẩm` | Có | `Áo sơ mi linen` |
| `Thương hiệu` | Không | `TAHA` |
| `Danh mục` | Không | `Thời trang nam` |
| `Mô tả` | Không | `Linen mềm, form regular...` |
| `Giá bán` | Không | `399000` |
| `Giá sale` | Không | `349000` |
| `Tồn kho` | Không | `25` |
| `Trạng thái` | Không | `Sẵn sàng`, `Tạm dừng` hoặc `Nháp` |

`Sẵn sàng`, `ready` hoặc `active` sẽ được hiểu là đang hoạt động; `Tạm dừng` hoặc `pause` được hiểu là tạm dừng; giá trị khác được đưa về nháp.

### 3.2. Giá trị cần nhập trên máy chủ

```dotenv
GOOGLE_SHEET_ID=<SPREADSHEET_ID>
GOOGLE_SHEET_NAME=Products
GOOGLE_SHEET_RANGE=Products!A:Z
```

### 3.3. Điểm cần chủ tài khoản xác nhận

- Tài khoản Google dùng để kết nối phải có quyền xem Spreadsheet.
- Không đổi SKU sau khi đã đồng bộ nếu không muốn TAHA AI coi đó là một mã nguồn khác.
- Sau lần đồng bộ đầu tiên, cần đối chiếu thủ công ít nhất một sản phẩm: tên, giá, tồn kho và số ảnh.

## 4. Google OAuth — kết nối chung cho Drive và Sheets

### 4.1. Callback phải đăng ký chính xác

```text
https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/google/callback
```

Không thêm dấu `/` ở cuối. Google yêu cầu redirect URI khớp chính xác cả giao thức, chữ hoa/thường và dấu gạch chéo.

### 4.2. Tạo cấu hình trên Google Cloud

1. Mở [Google Cloud Console](https://console.cloud.google.com/) và tạo/chọn một project dành riêng cho TAHA AI.
2. Vào **APIs & Services → Library** và bật:
   - Google Drive API;
   - Google Sheets API.
3. Vào **Google Auth Platform → Branding**, nhập tên ứng dụng `TAHA AI`, email hỗ trợ và thông tin liên hệ.
4. Vào **Audience**:
   - nếu dùng Google Workspace cùng tổ chức, ưu tiên `Internal`;
   - nếu dùng Gmail cá nhân, chọn `External` và thêm chính email kết nối vào **Test users** để thử nghiệm.
5. Vào **Data Access** và thêm các scope đọc:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/spreadsheets.readonly`
6. Vào **Clients → Create Client → Web application**.
7. Trong **Authorized redirect URIs**, dán đúng callback ở mục 4.1.
8. Tạo client và lấy `Client ID` cùng `Client Secret`.

Scope `drive.readonly` cho phép đọc/tải tất cả file Drive mà tài khoản có quyền truy cập và được Google xếp loại restricted. Dùng tài khoản ngoài tổ chức để vận hành lâu dài có thể phát sinh quy trình xác minh của Google. Phương án hẹp hơn là `drive.file` kết hợp Google Picker, nhưng bản TAHA AI hiện tại chưa có bước Picker nên chưa sử dụng phương án đó.

### 4.3. Giá trị cần nhập trên máy chủ

```dotenv
GOOGLE_CLIENT_ID=<CLIENT_ID>
GOOGLE_CLIENT_SECRET=<CLIENT_SECRET>
GOOGLE_REDIRECT_URI=https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/google/callback
GOOGLE_OAUTH_SCOPES=openid email profile https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly
```

Kết hợp với `GOOGLE_DRIVE_FOLDER_ID` và `GOOGLE_SHEET_ID` ở hai phần trước.

### 4.4. Bước chủ tài khoản bắt buộc tự thực hiện

1. Sau khi các secret đã được nhập, mở [Trung tâm kết nối TAHA AI](https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/connections).
2. Tại Google, bấm **Kết nối**.
3. Tự chọn tài khoản Google đúng và đọc màn hình consent.
4. Chấp thuận quyền đọc Drive và Sheets.
5. Khi trở lại TAHA AI, bấm **Đồng bộ ngay**.

### 4.5. Kiểm tra hoàn tất

- Trạng thái Google chuyển thành đã kết nối.
- Đồng bộ không báo `redirect_uri_mismatch` hoặc thiếu quyền.
- Sản phẩm từ Sheet xuất hiện và mỗi SKU nhận đúng ảnh trong thư mục Drive tương ứng.

Tài liệu chính thức: [tạo OAuth client](https://developers.google.com/workspace/guides/create-credentials), [OAuth cho web server](https://developers.google.com/identity/protocols/oauth2/web-server), [scope Google Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [scope Google Sheets](https://developers.google.com/workspace/sheets/api/scopes).

## 5. Facebook Page

### 5.1. Không dùng nhầm trang

Điểm bắt đầu là [Meta for Developers — My Apps](https://developers.facebook.com/apps/), không phải `work.meta.com` và không phải màn hình đăng nhập Workplace.

### 5.2. Callback phải đăng ký chính xác

```text
https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/facebook/callback
```

### 5.3. Tạo Meta App

1. Đăng nhập [Meta for Developers](https://developers.facebook.com/apps/) bằng Facebook cá nhân đang quản lý Page.
2. Bấm **Create App** và chọn use case **Manage everything on your Page**. Nếu giao diện hỏi loại ứng dụng, dùng loại `Business`.
3. Liên kết Business Portfolio của doanh nghiệp nếu Meta yêu cầu.
4. Trong **App settings → Basic**:
   - ghi lại `App ID`;
   - mở và ghi lại `App Secret` vào secret manager;
   - thêm app domain `taha-ai-commerce-vn.mrbengilo-76.chatgpt.site` nếu có trường tương ứng.
5. Trong **Use cases → Manage everything on your Page → Customize → Permissions and features**, bật/request đúng ba quyền:
   - `pages_show_list` — tìm danh sách Page mà người dùng quản lý;
   - `pages_read_engagement` — đọc thông tin/engagement cần cho Page;
   - `pages_manage_posts` — tạo, sửa và xóa bài của Page.
6. Trong **Facebook Login for Business → Settings**, bật **Client OAuth Login**, **Web OAuth Login**, **Enforce HTTPS** và **Strict Mode for Redirect URIs**; thêm callback mục 5.2 vào **Valid OAuth Redirect URIs**.
7. Trong **Facebook Login for Business → Configurations**, tạo configuration tên `TAHA AI Page OAuth`, chọn login variation `General`, chọn `User access token`, thêm đúng ba quyền ở bước 5 và lưu lại `Configuration ID`.
8. Chọn một Graph API version vẫn còn được Meta hỗ trợ cho ứng dụng và nhập nguyên dạng, ví dụ `vXX.X`; không tự đoán phiên bản.

Facebook Login for Business dùng `Configuration ID` qua tham số `config_id`; không truyền danh sách `scope` trong URL OAuth. Connector hiện tại là luồng redirect phía máy chủ nên không cần bật JavaScript SDK. Tạm để **Require App Secret** tắt cho đến khi mọi Graph API request của hệ thống gửi `appsecret_proof`.

Nếu chỉ kết nối Page của chính chủ hệ thống trong giai đoạn thử nghiệm, tài khoản Facebook đó phải là Admin/Developer/Tester của Meta App. Nếu cho tài khoản bên ngoài kết nối, cần đưa app sang Live và hoàn tất các yêu cầu hiện hành của Meta như Business Verification, App Review/Advanced Access, privacy policy và data deletion instructions.

### 5.4. Kiểm tra quyền Page của người kết nối

1. Trên Facebook, chuyển sang Page cần kết nối.
2. Vào **Settings & privacy → Settings → Page setup → Page access**.
3. Xác nhận tài khoản đang đăng nhập có Facebook access hoặc task access cho **Content**.
4. Nếu Page thuộc Business Portfolio khác, người có full control của Page phải cấp quyền trước.

TAHA AI chỉ lưu những Page mà phản hồi Meta cho thấy tài khoản có task tạo nội dung. Một Page chỉ có quyền xem/insights sẽ không được lưu làm kênh đăng.

### 5.5. Giá trị cần nhập trên máy chủ

```dotenv
META_APP_ID=<APP_ID>
META_APP_SECRET=<APP_SECRET>
META_LOGIN_CONFIG_ID=<FACEBOOK_LOGIN_FOR_BUSINESS_CONFIGURATION_ID>
META_GRAPH_API_VERSION=<PHIEN_BAN_DANG_DUOC_APP_SU_DUNG,_VI_DU_vXX.X>
META_REDIRECT_URI=https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/facebook/callback
```

### 5.6. Bước chủ tài khoản bắt buộc tự thực hiện

1. Mở Trung tâm kết nối TAHA AI và bấm **Kết nối** ở Facebook.
2. Đăng nhập Facebook cá nhân có quyền nội dung trên Page.
3. Chọn/cho phép Page cần quản lý và chấp thuận ba quyền ở trên.
4. Trở lại TAHA AI, xác nhận đúng tên Page.
5. Duyệt và đăng một bài thử chỉ có chữ; sau đó thử một bài có ảnh.

Tài liệu chính thức: [Meta App Dashboard](https://developers.facebook.com/apps/), [permission reference](https://developers.facebook.com/docs/permissions), [Meta Facebook API collection — Page access token](https://www.postman.com/meta/facebook/request/bqfxwbp/get-access-tokens-of-pages-you-manage), [quyền truy cập Page](https://www.facebook.com/help/289207354498410), [xem quyền Page](https://www.facebook.com/help/510247025775149).

## 6. Zalo cá nhân

### 6.1. Giới hạn chính thức và chế độ của TAHA AI

Zalo for Developers hiện mô tả **Zalo Social** cho đăng nhập/chia sẻ có thao tác người dùng, còn OpenAPI vận hành tự động được hướng vào **Zalo Official Account**. TAHA AI vì vậy không nhận App ID, access token, cookie hay QR của Zalo cá nhân và không điều khiển Zalo Web.

Zalo Help nêu tài khoản có thể bị tạm vô hiệu hóa khi bị coi là tài khoản tự động, sử dụng thiết bị giả lập hoặc công cụ/phần mềm bên thứ ba không do Zalo phát hành. Vì vậy Zalo cá nhân được giữ ở chế độ `manual_assist`.

### 6.2. Cách sử dụng

1. Trong Trung tâm kết nối TAHA AI, tại Zalo cá nhân bấm **Bật trợ lý**.
2. TAHA AI lưu riêng bản nội dung dành cho Zalo và bộ ảnh đi kèm.
3. Khi tới giờ, mở tác vụ Zalo, sao chép caption và tải ảnh.
4. Chủ tài khoản tự mở [Zalo chính thức](https://chat.zalo.me/) hoặc ứng dụng Zalo trên điện thoại.
5. Tự tạo bài Nhật ký, kiểm tra lại rồi bấm đăng.
6. Quay lại TAHA AI và bấm xác nhận đã đăng.

Không có callback và không có secret Zalo cá nhân nào cần nhập. Nếu sau này chuyển sang Zalo OA, đó phải là một connector riêng với App/OA access token và quy trình duyệt riêng; không dùng chung connector cá nhân.

Tài liệu chính thức: [Zalo for Developers](https://developers.zalo.me/), [Zalo Share có thao tác người dùng](https://developers.zalo.me/docs/social/share), [cảnh báo tài khoản bot/phần mềm bên thứ ba](https://help.zalo.me/huong-dan/chuyen-muc/quan-ly-tai-khoan-zalo/loi-thuong-gap/tai-khoan-zalo-bi-tam-thoi-vo-hieu-hoa/).

## 7. Website bán hàng

Website dùng webhook do chính website cung cấp; không có OAuth callback.

### 7.1. Thông tin chủ website cần cung cấp

- Domain website thật, có HTTPS.
- Nền tảng: WooCommerce, Shopify, Haravan, Sapo hoặc website tự viết.
- Repository hoặc quyền triển khai để thêm endpoint.
- Cách ánh xạ sản phẩm: SKU, danh mục, biến thể, giá, tồn kho và thư viện ảnh.
- Endpoint mong muốn, ví dụ `https://shop.example.vn/api/taha/publish`.

### 7.2. Hợp đồng webhook hiện tại

TAHA AI gửi:

```http
POST /api/taha/publish
Content-Type: application/json
X-TAHA-Signature: sha256=<HMAC_SHA256_HEX>
X-TAHA-Idempotency-Key: <KHOA_KHONG_TRUNG>
```

Chữ ký là HMAC-SHA256 của **nguyên văn request body** bằng secret dùng chung. Body gồm snapshot nội dung đã duyệt như `provider`, `contentType`, `title`, `message`, `hashtags`, `mediaIds`, `platformData`, `publishOptions`, `occurrenceAt` và `tahaJobId`.

Website phải:

1. đọc raw body trước khi parse JSON;
2. tính lại và so sánh chữ ký an toàn;
3. chống đăng trùng bằng `X-TAHA-Idempotency-Key`;
4. trả HTTP `2xx` khi thành công;
5. nên trả JSON `{ "id": "...", "url": "https://..." }` để TAHA AI lưu liên kết bài/sản phẩm.

### 7.3. Giá trị cần nhập trên máy chủ

```dotenv
WEBSITE_BASE_URL=https://shop.example.vn
WEBSITE_PUBLISH_ENDPOINT=https://shop.example.vn/api/taha/publish
WEBSITE_WEBHOOK_SECRET=<SECRET_NGAU_NHIEN_MANH>
```

### 7.4. Điểm cần chủ tài khoản hỗ trợ

Chủ website cần cấp quyền repository/VPS hoặc đề nghị đội kỹ thuật website cài endpoint theo hợp đồng trên. Sau đó chủ website phải kiểm tra một bài thử trong CMS trước khi cho phép lịch tự động.

## 8. TikTok Shop

### 8.1. Callback phải đăng ký chính xác

```text
https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/tiktok-shop/callback
```

### 8.2. Tạo ứng dụng

1. Hoàn tất developer onboarding và đăng nhập [TikTok Shop Partner Center](https://partner.tiktokshop.com/).
2. Vào **App & Service → Create app & service**.
3. Với một shop của chính doanh nghiệp, chọn **Custom App**.
4. Chọn service category gần nhất với `Catalog → Product Listing`; nếu chọn Connector, TikTok có thể yêu cầu review.
5. Chọn market `Vietnam` và seller type phù hợp với shop.
6. Bật **Enable API**.
7. Nhập callback mục 8.1 vào **Redirect URL**.
8. Bật/request các scope mà connector hiện dùng:
   - `seller.authorization.info`
   - `seller.product.basic`
   - `seller.product.write`
9. Tạo/publish app theo trạng thái Partner Center. App chưa publish có thể chưa hiện authorization link.
10. Trên trang chi tiết app/service, lấy:
   - App Key;
   - App Secret;
   - Service ID.

### 8.3. Giá trị cần nhập trên máy chủ

```dotenv
TIKTOK_SHOP_MARKET=VN
TIKTOK_SHOP_APP_KEY=<APP_KEY>
TIKTOK_SHOP_APP_SECRET=<APP_SECRET>
TIKTOK_SHOP_SERVICE_ID=<SERVICE_ID>
TIKTOK_SHOP_REDIRECT_URI=https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/tiktok-shop/callback
TIKTOK_SHOP_API_BASE_URL=https://open-api.tiktokglobalshop.com
TIKTOK_SHOP_AUTH_BASE_URL=https://auth.tiktok-shops.com
TIKTOK_SHOP_AUTHORIZE_URL=https://services.tiktokshop.com/open/authorize
```

### 8.4. Bước chủ shop bắt buộc tự thực hiện

1. Tại Trung tâm kết nối TAHA AI, bấm **Kết nối** ở TikTok Shop.
2. Đăng nhập bằng TikTok Shop Seller của shop Việt Nam.
3. Kiểm tra tên ứng dụng và phạm vi quyền, rồi bấm chấp thuận.
4. TikTok trả về callback; TAHA AI đổi code lấy token, gọi Get Authorized Shops và lưu `shop_cipher`.
5. Xác nhận đúng tên shop xuất hiện trong TAHA AI.

Mã ủy quyền có thời hạn ngắn và chỉ dùng một lần; không sao chép mã đó vào chat.

### 8.5. Điều kiện trước khi đăng sản phẩm thật

Kết nối thành công chưa đồng nghĩa đã có thể tạo listing. Còn phải kiểm tra khả năng nhận listing, upload ảnh vào TikTok Shop, xác định leaf category, lấy schema/thuộc tính bắt buộc, qualification và quy tắc ngành hàng. Bản TAHA AI hiện hoàn tất kết nối/token nhưng chưa bật thao tác ghi listing TikTok Shop.

Tài liệu chính thức: [tạo ứng dụng](https://partner.tiktokshop.com/docv2/page/create-your-app), [authorization overview](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407), [Get Authorized Shops](https://partner.tiktokshop.com/docv2/page/call-get-authorized-shops), [upload ảnh sản phẩm](https://partner.tiktokshop.com/docv2/page/upload-product-image), [quy trình tạo sản phẩm](https://partner.tiktokshop.com/docv2/page/category-expansion-l7-migration-guide).

## 9. Shopee Seller

### 9.1. Callback phải đăng ký chính xác

```text
https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/shopee/callback
```

### 9.2. Đăng ký đối tác và ứng dụng

1. Đăng ký/đăng nhập [Shopee Open Platform](https://open.shopee.com/) bằng tài khoản đối tác của doanh nghiệp.
2. Nếu Shopee đưa sang quy trình Đối tác dịch vụ, chủ doanh nghiệp phải tự hoàn tất:
   - tài khoản đối tác;
   - hồ sơ doanh nghiệp và tài liệu pháp lý;
   - hồ sơ chuyên môn dịch vụ;
   - chờ email kết quả xét duyệt.
3. Trong Developer Console, tạo/chọn app dành cho thị trường Việt Nam.
4. Khai báo callback mục 9.1.
5. Request các API group cần cho chức năng dự kiến: shop authorization, product read/write, media/image và các push event cần thiết. Shopee dùng quyền theo API group/app, không dùng chuỗi OAuth scope giống Google.
6. Hoàn tất kiểm thử/review để app có `Partner ID` và `Partner Key` dùng được với môi trường production.
7. Không dùng key sandbox với production base URL.

### 9.3. Giá trị cần nhập trên máy chủ

```dotenv
SHOPEE_ENV=production
SHOPEE_REGION=VN
SHOPEE_BASE_URL=https://partner.shopeemobile.com
SHOPEE_PARTNER_ID=<PARTNER_ID>
SHOPEE_PARTNER_KEY=<PARTNER_KEY>
SHOPEE_REDIRECT_URI=https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site/api/integrations/shopee/callback
```

### 9.4. Bước chủ shop bắt buộc tự thực hiện

1. Tại Trung tâm kết nối TAHA AI, bấm **Kết nối** ở Shopee.
2. Shopee Seller đăng nhập shop chính chủ.
3. Kiểm tra ứng dụng và bấm ủy quyền shop.
4. Shopee trả về `code` và `shop_id`; TAHA AI đổi chúng lấy access/refresh token.
5. Xác nhận đúng `Shopee Shop <shop_id>` xuất hiện trong hệ thống.

### 9.5. Điều kiện trước khi đăng sản phẩm thật

Sau khi kết nối, vẫn phải ánh xạ leaf category, thuộc tính bắt buộc, thương hiệu, logistics, biến thể, giá/tồn kho và upload ảnh qua API media của Shopee. Bản TAHA AI hiện hoàn tất luồng kết nối/token nhưng chưa bật thao tác ghi listing Shopee.

Tài liệu chính thức: [Shopee Open Platform](https://open.shopee.com/), [hướng dẫn bắt đầu nền tảng Đối tác dịch vụ Shopee](https://help.shopee.vn/portal/4/article/158953-H%C6%B0%E1%BB%9Bng-d%E1%BA%ABn-B%E1%BA%AFt-%C4%91%E1%BA%A7u-s%E1%BB%AD-d%E1%BB%A5ng-n%E1%BB%81n-t%E1%BA%A3ng-%C4%90%E1%BB%91i-t%C3%A1c-d%E1%BB%8Bch-v%E1%BB%A5-Shopee).

## 10. Phân tách lưu trữ theo kênh

Không dùng một thư mục chung để coi là “đã đăng ở mọi nơi”. Mỗi kênh phải có connection, nội dung, lịch, trạng thái và mã bài bên ngoài riêng:

| Khu vực | Dữ liệu nguồn | Dữ liệu đầu ra cần lưu riêng |
|---|---|---|
| Google Drive | file ảnh và thư mục SKU | media ID, checksum, thời điểm đồng bộ |
| Google Sheets | SKU, mô tả, giá, tồn kho | product/variant và hàng nguồn |
| Facebook | Page connection | caption Facebook, media, Page Post ID/URL |
| Zalo cá nhân | trợ lý thủ công | caption Zalo, bộ ảnh, trạng thái chờ/xác nhận |
| Website | webhook connection | payload website, ID/URL do website trả về |
| TikTok Shop | shop connection + `shop_cipher` | listing mapping, product/SKU ID và lỗi duyệt |
| Shopee | shop connection + `shop_id` | item/model mapping và lỗi ngành hàng |

Một nội dung sửa cho Facebook không được tự ghi đè bản Zalo/TikTok/Shopee/Website. Việc đăng lại cũng phải tạo job/idempotency riêng cho đúng connection.

## 11. Checklist thông tin cần chủ hệ thống cung cấp tiếp

- [ ] Email Google sẽ cấp quyền và `GOOGLE_DRIVE_FOLDER_ID`.
- [ ] `GOOGLE_SHEET_ID`, tên tab/range và xác nhận cột SKU.
- [ ] Google OAuth Client ID; Client Secret nhập trực tiếp vào secret manager.
- [ ] Meta App ID, Graph API version và xác nhận tài khoản Facebook có quyền Content trên Page; App Secret nhập trực tiếp vào secret manager.
- [ ] Nền tảng/domain/repository của website bán hàng.
- [ ] TikTok Shop App Key, Service ID và trạng thái app; App Secret nhập trực tiếp vào secret manager.
- [ ] Shopee Partner ID và trạng thái app production; Partner Key nhập trực tiếp vào secret manager.
- [ ] Chủ tài khoản có mặt để tự đăng nhập và bấm chấp thuận ở Google, Meta, TikTok Shop và Shopee.
