# Kiến trúc triển khai

MVP hiện chạy theo mô hình:

```text
Web UI + API + Scheduler
        Cloudflare Worker
              │
       D1 (dữ liệu có cấu trúc)
       R2 (ảnh/video đã xử lý)
              │
       Google / Meta / Shopee / TikTok / Website APIs
```

VPS đã chuẩn bị phù hợp cho:

- Zalo Personal Bridge trên Windows hoặc dịch vụ thông báo riêng.
- Worker xử lý ảnh/video nặng.
- Reverse proxy, giám sát và tác vụ nền ngoài giới hạn Worker.

Không chạy nguyên build D1 như một ứng dụng Node/PostgreSQL trên VPS. Nếu muốn toàn bộ core chạy ở VPS, cần một nhánh triển khai riêng chuyển D1 sang PostgreSQL và Worker APIs sang Node runtime.

## Trình tự phát hành

1. Build và kiểm tra migration.
2. Tạo D1/R2 bindings `DB` và `MEDIA`.
3. Nhập biến môi trường/secret.
4. Áp dụng migration.
5. Deploy domain HTTPS.
6. Đăng ký callback ở từng nền tảng.
7. Kết nối tài khoản từ `/connections`.
8. Đồng bộ Google thử nghiệm.
9. Đăng một bài Facebook và một payload website thử nghiệm.
10. Chỉ sau khi đối soát mới bật scheduler.

## Kích hoạt lịch đăng

Worker có hàm scheduled chạy theo thứ tự: tạo job đến hạn, sau đó phát job Facebook/website. Môi trường triển khai vẫn phải cấu hình trigger thực tế. Trên VPS, gọi mỗi phút:

```text
POST https://app.your-domain.vn/api/internal/cron/tick
Authorization: Bearer <INTERNAL_API_SECRET>
```

Endpoint nội bộ thực hiện cùng luồng scheduler và dispatcher, không đưa secret vào trình duyệt. Shopee/TikTok chưa có bộ ghi listing nên job của hai kênh sẽ chuyển sang `blocked` để đối soát, không gửi giả hoặc tự thử lại vô hạn.

## Bảo vệ API quản trị

- Trên OpenAI Sites, đặt `SITES_OPERATOR_USER_IDS` thành danh sách phân tách bằng dấu phẩy của đúng các giá trị `oai-authenticated-user-id` theo từng Site, hoặc đặt `SITES_OPERATOR_EMAILS` thành danh sách email ChatGPT đã xác thực được phép vận hành hệ thống. Không dùng account user ID trong chính sách chia sẻ thay cho header ID vì hai giá trị này không giống nhau.
- Ingress phải xóa mọi header `oai-authenticated-user-*` do client tự gửi và chỉ chuyển header danh tính do Sites đã xác thực. Allowlist không thay thế ranh giới tin cậy này.
- Khi chạy độc lập trên VPS/reverse proxy, dùng `Authorization: Bearer <INTERNAL_API_SECRET>` từ một proxy/backend đã xác thực. Không đưa secret này vào JavaScript trình duyệt.
- Bypass cho `localhost`, `127.0.0.1` và `::1` chỉ hoạt động ở build không phải production. Production luôn cần Sites user nằm trong allowlist hoặc Bearer secret hợp lệ.
- Tạo `INTERNAL_API_SECRET`, `OAUTH_STATE_SECRET` và `INTEGRATION_TOKEN_ENCRYPTION_KEY` độc lập, ngẫu nhiên, rồi lưu bằng secret manager của môi trường triển khai.
