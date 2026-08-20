# Yêu cầu kết nối tài khoản TAHA AI

Tài liệu này là danh sách thông tin chủ hệ thống cần chuẩn bị. Không gửi App Secret, Partner Key, access token, refresh token, cookie hoặc mã QR qua chat. Nhập các giá trị bí mật trực tiếp vào secret manager hoặc tệp môi trường chỉ tồn tại trên máy chủ.

Thay `https://app.your-domain.vn` bằng domain HTTPS thật của TAHA AI trước khi đăng ký callback.

## 1. Google Drive và Google Sheet

- Tạo/chọn dự án tại [Google Cloud – OAuth Clients](https://console.cloud.google.com/auth/clients).
- Bật Google Drive API và Google Sheets API.
- Tạo OAuth Client loại **Web application**.
- Callback cần đăng ký: `https://app.your-domain.vn/api/integrations/google/callback`.
- Chuẩn bị: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, ID thư mục Drive, ID Google Sheet và tên/range sheet.
- Tài khoản kết nối phải có quyền đọc thư mục và Sheet đã chọn.

## 2. Facebook Page

- Tạo/chọn ứng dụng tại [Meta for Developers – My Apps](https://developers.facebook.com/apps/).
- Thêm Facebook Login và đăng ký callback: `https://app.your-domain.vn/api/integrations/facebook/callback`.
- Xin các quyền: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
- Chuẩn bị: `META_APP_ID`, `META_APP_SECRET`, phiên bản Graph API đang dùng.
- Người bấm kết nối phải có task tạo nội dung trên Facebook Page.

## 3. Zalo cá nhân

- Không cần App ID, token, cookie hoặc QR cho TAHA AI.
- Dùng [Zalo chính thức](https://chat.zalo.me/) để đăng bài đã được TAHA AI chuẩn bị.
- Trong TAHA AI, bấm **Bật trợ lý**; hệ thống cung cấp caption, bộ ảnh tải xuống và bước xác nhận đã đăng.
- Không dùng bot, giả lập hay phần mềm điều khiển Zalo cá nhân.

## 4. Shopee Seller

- Đăng ký/chọn ứng dụng tại [Shopee Open Platform](https://open.shopee.com/).
- Thị trường: Việt Nam; cần Shop/Auth, Product read/write, Media Space và Push.
- Callback cần đăng ký: `https://app.your-domain.vn/api/integrations/shopee/callback`.
- Chuẩn bị: `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, API base URL của ứng dụng live.
- Sau khi ứng dụng được duyệt, cần thêm ánh xạ danh mục, thuộc tính bắt buộc, vận chuyển và ảnh Media Space trước khi bật tạo listing.

## 5. TikTok Shop

- Tạo Custom App tại [TikTok Shop Partner Center](https://partner.tiktokshop.com/).
- Callback cần đăng ký: `https://app.your-domain.vn/api/integrations/tiktok-shop/callback`.
- Quyền tối thiểu: `seller.authorization.info`, `seller.product.basic`, `seller.product.write`.
- Chuẩn bị: `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`, `TIKTOK_SHOP_SERVICE_ID`.
- Shop cần hoàn tất KYC/audit; sản phẩm phải có category, thuộc tính và ảnh upload hợp lệ.

## 6. Website bán hàng

- Chuẩn bị domain website và một endpoint HTTPS nhận JSON, ví dụ `https://shop.your-domain.vn/api/taha/publish`.
- Tạo một khóa webhook mạnh dùng chung giữa website và TAHA AI.
- Website phải kiểm tra `X-TAHA-Signature`, chống xử lý trùng bằng `X-TAHA-Idempotency-Key`, rồi trả về ID/URL bài hoặc sản phẩm.

## Sau khi nhập cấu hình trên máy chủ

1. Mở `https://app.your-domain.vn/connections`.
2. Bấm **Kết nối** ở Google, Facebook, Shopee và TikTok Shop để cấp quyền trên trang chính thức.
3. Bấm **Bật trợ lý** cho Zalo cá nhân.
4. Kết nối website và thử một sản phẩm/bài viết.
5. Với Google, bấm **Đồng bộ ngay** và kiểm tra SKU, giá, tồn kho cùng ảnh trước khi lên lịch tự động.
