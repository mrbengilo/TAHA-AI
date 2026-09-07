# Triển khai production trên VPS

TAHA AI production dùng duy nhất domain quản trị `https://tahashoes.store`; không triển khai OpenAI Sites. Website bán hàng nhận dữ liệu là `https://tahashoes.vn` và là một hệ thống/connector riêng.

## Kiến trúc

```text
Trình duyệt quản trị
        │ HTTPS
        ▼
Reverse proxy trên VPS (TLS + xác thực quản trị)
        │
        ▼
Docker: Vinext/Worker runtime qua Wrangler local :8787
        │
        ├── /data · D1 local bền vững
        ├── /data · R2 local bền vững
        └── Google · OpenAI · Meta · TikTok · Shopee · tahashoes.vn

systemd timer/cron root-only
        └── POST https://tahashoes.store/api/internal/cron/tick
```

`deploy/vps/Dockerfile` build bằng Node 22 và chạy `deploy/vps/start.sh`. Khi container khởi động, Wrangler áp dụng toàn bộ D1 migration theo thứ tự rồi phục vụ `wrangler dev --local --persist-to=/data`. Không xóa hoặc thay volume `/data` khi cập nhật image.

## Trình tự phát hành

1. Chạy typecheck/lint/test/build và kiểm tra không có secret trong diff.
2. Sao lưu `/data` trên VPS.
3. Build image từ commit cần phát hành; không copy `.env.local` hoặc file secret vào build context.
4. Mount volume bền vững vào `/data`.
5. Mount file môi trường root-only vào `/app/.dev.vars` ở chế độ chỉ đọc.
6. Khởi động container; kiểm tra log migration `0000` → `0003` và health của trang chủ/API.
7. Cấu hình reverse proxy HTTPS cho `tahashoes.store` đến `127.0.0.1:8787`.
8. Đăng ký callback production chính xác ở Google/Meta/TikTok/Shopee.
9. Kết nối lại Google để nhận quyền Drive ghi, rồi đồng bộ một SKU thử.
10. Chạy một SKU có ảnh Drive đúng thư mục; kiểm tra bài/hashtag, lịch và biên nhận Facebook.
11. Bật cron mỗi phút; theo dõi log và chỉ thử publish kênh đã được nền tảng phê duyệt.

## Migration và dữ liệu bền vững

- D1 mới phải áp dụng **tất cả** file trong `drizzle/`, không chỉ migration mới nhất.
- `0003_lazy_hellcat.sql` tạo `automation_runs` và `automation_steps`.
- `/data` chứa D1, R2 media và trạng thái Wrangler local; sao lưu nhất quán trước deploy/rollback.
- Rollback image không được tự hạ schema. Nếu code cũ không tương thích migration mới, phục hồi cả image và bản sao `/data` tương ứng trong cửa sổ bảo trì.

## File secret root-only

Tạo file secret ngoài repository, ví dụ `/root/taha-ai/.dev.vars`, chủ sở hữu `root:root`, mode `600`, rồi bind-mount read-only đến `/app/.dev.vars`. Không đưa nội dung file vào command history, log CI, ảnh chụp màn hình hoặc chat.

Các nhóm biến bắt buộc:

```dotenv
PUBLIC_APP_URL=https://tahashoes.store

OAUTH_STATE_SECRET=<RANDOM_INDEPENDENT_SECRET>
INTEGRATION_TOKEN_ENCRYPTION_KEY=<BASE64URL_32_BYTE_KEY>
INTERNAL_API_SECRET=<RANDOM_INDEPENDENT_SECRET>
TRUSTED_PROXY_SECRET=<RANDOM_INDEPENDENT_SECRET>
SITES_OPERATOR_USER_IDS=<BASIC_AUTH_USERNAME>

GOOGLE_CLIENT_ID=<...>
GOOGLE_CLIENT_SECRET=<...>
GOOGLE_REDIRECT_URI=https://tahashoes.store/api/integrations/google/callback
GOOGLE_OAUTH_SCOPES=openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets.readonly
GOOGLE_DRIVE_FOLDER_ID=<...>
GOOGLE_SHEET_ID=<...>
GOOGLE_SHEET_NAME=Products
GOOGLE_SHEET_RANGE=Products!A:Z

META_REDIRECT_URI=https://tahashoes.store/api/integrations/facebook/callback
TIKTOK_SHOP_REDIRECT_URI=https://tahashoes.store/api/integrations/tiktok-shop/callback
SHOPEE_REDIRECT_URI=https://tahashoes.store/api/integrations/shopee/callback

WEBSITE_BASE_URL=https://tahashoes.vn
WEBSITE_PUBLISH_ENDPOINT=https://tahashoes.vn/api/taha/publish
WEBSITE_WEBHOOK_SECRET=<RANDOM_SHARED_SECRET>

OPENAI_API_KEY=<SERVER_SECRET>
OPENAI_TEXT_MODEL=gpt-5.6-luna
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_QUALITY=medium
```

Điền App ID/secret/key còn lại theo `.env.example`. Không commit `OPENAI_API_KEY`, Google Client Secret, Meta App Secret, TikTok App Secret, Shopee Partner Key hay webhook secret. `OPENAI_API_KEY` chỉ cần ở runtime server; không đặt tiền tố public và không truyền vào HTML/JavaScript trình duyệt. Khi xoay key, cập nhật file root-only, restart container, chạy một job thử, rồi vô hiệu hóa key cũ.

## Google cho luồng dùng ảnh Drive

Luồng mới chỉ đọc Sheet và ảnh trong thư mục `SKU <SKU>`. Quyền đọc hiện hữu đủ dùng; không bắt buộc kết nối lại để cấp quyền ghi. API xuất media cũ vẫn yêu cầu `drive` hoặc `drive.file` nếu được sử dụng riêng.

## Xác thực API quản trị trên VPS

Production không có bypass localhost cho request bên ngoài. API đọc yêu cầu viewer; API kết nối, sync, automation và publish yêu cầu operator.

Dashboard và API fail-closed nếu thiếu bằng chứng từ reverse proxy. Dùng mẫu [`deploy/vps/nginx.tahashoes.store.conf`](../deploy/vps/nginx.tahashoes.store.conf), HTTP Basic Auth và file `/etc/nginx/snippets/taha-ai-identity.conf` chỉ `root` đọc được. File snippet phải ghi đè `x-taha-proxy-secret` bằng đúng `TRUSTED_PROXY_SECRET`; Nginx ghi đè các header `oai-authenticated-user-*` từ trình duyệt và gắn `$remote_user`. `SITES_OPERATOR_USER_IDS` phải chứa đúng username Basic Auth đó.

Chỉ publish cổng container vào loopback, ví dụ `127.0.0.1:8787:8787`. Không mở trực tiếp cổng Worker ra Internet. Request giả header nhưng thiếu `x-taha-proxy-secret` hợp lệ sẽ bị code từ chối.

Bearer `INTERNAL_API_SECRET` chỉ dành cho backend/cron đáng tin cậy. Không đưa secret này vào localStorage, cookie đọc được bằng JavaScript hoặc mã frontend.

## Cron và automation worker

Gọi mỗi phút:

```http
POST https://tahashoes.store/api/internal/cron/tick
Authorization: Bearer <INTERNAL_API_SECRET>
```

Mỗi tick ưu tiên scheduler và dispatcher, sau đó lập kế hoạch và xử lý worker. Run mới có hai bước viết nội dung/hoàn tất, không có bước tạo ảnh. Lưu Bearer trong file environment chỉ root đọc được, không ghi trực tiếp secret vào unit/timer hoặc crontab có quyền đọc rộng.

Theo dõi các mã lỗi an toàn và run/step ID; không log request header, token, raw response nhà cung cấp hoặc nội dung file secret.

## Ranh giới trạng thái kênh

- Facebook/Website chỉ tự gửi khi connection thật ở trạng thái `connected` và payload đã duyệt.
- Zalo cá nhân luôn `assisted`; chủ tài khoản tự đăng và xác nhận.
- TikTok Shop Partner/App/scopes và Shopee Open Platform profile vẫn đang chờ nền tảng phê duyệt. Deploy connector hoặc có key không đồng nghĩa kênh đã live.
- Shopee hiện trả `SHOPEE_APPROVAL_PENDING`. TikTok chỉ xếp listing job sau connection thật và preflight đầy đủ; không bỏ kiểm tra để thử production.

## Kiểm tra sau deploy

- `https://tahashoes.store/` và `/automation` tải đúng giao diện Arial, không lỗi asset/font.
- Request không xác thực không thể gọi API operator.
- `POST /api/internal/cron/tick` sai Bearer trả `401`; đúng Bearer trả ba nhóm kết quả `automation`, `scheduler`, `dispatcher`.
- Google sync trả đúng SKU/media; bài thử có ảnh Drive của đúng SKU, mô tả/hashtag và Post ID thật.
- Secret scan của repository không tìm thấy giá trị thật; file secret VPS là `root:root` mode `600`.
- Không hiển thị TikTok/Shopee là “đã đăng” khi nền tảng chưa phê duyệt hoặc chưa trả external product ID.

## Phát hành đã kiểm thử

Workflow `TAHA validated VPS release` chạy lint, typecheck, build và test trước khi triển khai đúng SHA trên main. `deploy/vps/release.sh` dùng legacy Docker builder tương thích VPS, thử migration trên bản sao SQLite nhất quán và kiểm tra trang/API có xác thực. Khi chuyển bản, dừng timer, chờ cron đang chạy hoàn tất, dừng container cũ rồi sao lưu `/var/lib/taha-ai` dưới `/var/backups/taha-ai`. Container cũ được giữ để rollback; không prune image hoặc xóa dữ liệu dùng chung.

Migration `0004` chỉ hủy run tạo ảnh cũ và tạm dừng lịch/jobs dùng ảnh generated; giữ nguyên sản phẩm, ảnh và lịch sử. Nếu health check thất bại sau cutover, khôi phục container cũ, giữ các hủy bỏ và để cron dừng để không chạy lại luồng ảnh cũ.

Bài Facebook thử chỉ chạy khi commit merge chứa `[facebook-trial]` hoặc workflow dispatch bật tùy chọn tương ứng. Script `facebook-trial.py` gửi một yêu cầu idempotent rồi chỉ theo dõi; cron thực tế tự viết và đăng. Script chỉ thành công khi có đúng một job published kèm Post ID. Không bật thử cho các đợt phát hành khác nếu không có yêu cầu. Lập kế hoạch tự chọn SKU hằng ngày chỉ chạy cho connection đã bật `dailyAutomationEnabled` rõ ràng.
