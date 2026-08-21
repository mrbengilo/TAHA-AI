import type { Metadata } from "next";
import Link from "../../SiteLink";
import "./guide.css";

type GuideStep = {
  title: string;
  detail: string;
  owner?: boolean;
};

type ChannelGuide = {
  id: string;
  mark: string;
  name: string;
  role: string;
  tone: string;
  officialUrl?: string;
  officialLabel?: string;
  callback?: string;
  required: string[];
  steps: GuideStep[];
  checkpoint: string;
  note?: string;
};

const appOrigin = "https://taha-ai-commerce-vn.mrbengilo-76.chatgpt.site";

const channels: ChannelGuide[] = [
  {
    id: "google-drive",
    mark: "D",
    name: "Google Drive",
    role: "Kho hình ảnh gốc",
    tone: "drive",
    officialUrl: "https://drive.google.com/",
    officialLabel: "Mở Google Drive",
    callback: `${appOrigin}/api/integrations/google/callback`,
    required: ["ID thư mục Drive gốc", "Tài khoản Google có quyền xem", "Thư mục con đặt theo SKU"],
    steps: [
      { title: "Tạo thư mục nguồn", detail: "Tạo thư mục TAHA-AI-SAN-PHAM trong Google Drive.", owner: true },
      { title: "Chia ảnh theo SKU", detail: "Mỗi sản phẩm có một thư mục con; tên thư mục trùng chính xác SKU trong Sheet.", owner: true },
      { title: "Lấy Folder ID", detail: "Mở thư mục gốc và sao chép phần nằm sau /folders/ trong địa chỉ trình duyệt.", owner: true },
      { title: "Nhập cấu hình an toàn", detail: "Nhập Folder ID trực tiếp vào cấu hình máy chủ, không gửi qua biểu mẫu công khai." },
      { title: "Cấp quyền Google", detail: "Đăng nhập đúng tài khoản và chấp thuận quyền đọc khi TAHA AI chuyển sang Google.", owner: true },
    ],
    checkpoint: "Đồng bộ thử một SKU và xác nhận đúng số lượng, thứ tự ảnh.",
    note: "Ảnh đặt thẳng ở thư mục gốc không tự gắn với sản phẩm. Hãy luôn dùng thư mục con theo SKU.",
  },
  {
    id: "google-sheets",
    mark: "S",
    name: "Google Sheets",
    role: "Kho dữ liệu sản phẩm",
    tone: "sheets",
    officialUrl: "https://docs.google.com/spreadsheets/",
    officialLabel: "Mở Google Sheets",
    callback: `${appOrigin}/api/integrations/google/callback`,
    required: ["Spreadsheet ID", "Tab Products", "SKU, tên sản phẩm", "Quyền xem bảng"],
    steps: [
      { title: "Tạo bảng Products", detail: "Dùng các cột SKU, Tên sản phẩm, Thương hiệu, Danh mục, Mô tả, Giá bán, Giá sale, Tồn kho và Trạng thái.", owner: true },
      { title: "Kiểm tra SKU", detail: "SKU phải duy nhất và trùng tên thư mục ảnh tương ứng trong Google Drive.", owner: true },
      { title: "Lấy Spreadsheet ID", detail: "Sao chép phần nằm giữa /spreadsheets/d/ và /edit trong địa chỉ bảng.", owner: true },
      { title: "Nhập range", detail: "Cấu hình mặc định là Products!A:Z; đổi lại nếu tab của bạn dùng tên khác." },
      { title: "Đồng bộ lần đầu", detail: "Sau khi Google đã cấp quyền, bấm Đồng bộ ngay trong Trung tâm kết nối.", owner: true },
    ],
    checkpoint: "Đối chiếu thủ công ít nhất một sản phẩm: tên, giá, tồn kho, trạng thái và ảnh.",
    note: "Drive và Sheets được lưu thành hai nguồn dữ liệu riêng nhưng dùng chung một lần đăng nhập Google.",
  },
  {
    id: "facebook",
    mark: "f",
    name: "Facebook Page",
    role: "Kênh đăng bài tự động",
    tone: "facebook",
    officialUrl: "https://developers.facebook.com/apps/",
    officialLabel: "Mở Meta for Developers",
    callback: `${appOrigin}/api/integrations/facebook/callback`,
    required: ["Meta App ID", "Meta App Secret", "Login Configuration ID", "Graph API version", "Quyền nội dung trên Page"],
    steps: [
      { title: "Mở đúng cổng Meta", detail: "Vào Meta for Developers, không dùng work.meta.com hoặc màn hình Workplace.", owner: true },
      { title: "Tạo app quản lý Page", detail: "Chọn use case Manage everything on your Page và liên kết Business Portfolio nếu Meta yêu cầu.", owner: true },
      { title: "Khai báo callback", detail: "Trong Facebook Login for Business → Settings, bật Web OAuth/HTTPS/Strict Mode và thêm callback bên dưới." },
      { title: "Tạo Login Configuration", detail: "Tạo cấu hình General dùng User access token; lưu Configuration ID vào secret manager." },
      { title: "Bật ba quyền", detail: "Thêm pages_show_list, pages_read_engagement và pages_manage_posts vào configuration." },
      { title: "Ủy quyền Page", detail: "Đăng nhập tài khoản có quyền Content trên Page, chọn đúng Page và chấp thuận quyền.", owner: true },
    ],
    checkpoint: "Đăng một bài chỉ có chữ, sau đó thử một bài có ảnh và kiểm tra Post URL được lưu.",
    note: "Nếu người kết nối không phải Admin/Developer/Tester của app, Meta có thể yêu cầu Business Verification và App Review.",
  },
  {
    id: "zalo",
    mark: "Z",
    name: "Zalo cá nhân",
    role: "Trợ lý đăng có xác nhận",
    tone: "zalo",
    officialUrl: "https://chat.zalo.me/",
    officialLabel: "Mở Zalo chính thức",
    required: ["Không cần App Secret", "Không dùng cookie hoặc QR", "Chủ tài khoản xác nhận mỗi bài"],
    steps: [
      { title: "Bật trợ lý Zalo", detail: "Trong Trung tâm kết nối, bấm Bật trợ lý để tạo khu vực nội dung riêng cho Zalo.", owner: true },
      { title: "Duyệt nội dung", detail: "Kiểm tra caption và tải bộ ảnh mà TAHA AI đã chuẩn bị.", owner: true },
      { title: "Mở ứng dụng chính thức", detail: "Tự mở Zalo trên điện thoại hoặc chat.zalo.me; TAHA AI không điều khiển tài khoản cá nhân.", owner: true },
      { title: "Đăng Nhật ký", detail: "Dán caption, chọn ảnh, kiểm tra lại người xem và tự bấm đăng.", owner: true },
      { title: "Xác nhận hoàn tất", detail: "Quay lại TAHA AI và xác nhận đã đăng để đóng tác vụ.", owner: true },
    ],
    checkpoint: "Bài Zalo chỉ chuyển sang hoàn tất sau khi chủ tài khoản xác nhận.",
    note: "Zalo cảnh báo tài khoản bot, thiết bị giả lập và phần mềm bên thứ ba. Chế độ cá nhân vì vậy không chạy tự động hoàn toàn.",
  },
  {
    id: "website",
    mark: "W",
    name: "Website bán hàng",
    role: "Kênh webhook của doanh nghiệp",
    tone: "website",
    required: ["Domain HTTPS", "Endpoint nhận bài", "Webhook secret", "Quyền sửa website hoặc repository"],
    steps: [
      { title: "Xác định nền tảng", detail: "Cho biết website dùng WooCommerce, Shopify, Haravan, Sapo hay mã nguồn riêng.", owner: true },
      { title: "Cấp quyền triển khai", detail: "Cấp quyền repository/VPS cho người cài endpoint, hoặc chuyển hợp đồng webhook cho đội website.", owner: true },
      { title: "Tạo endpoint HTTPS", detail: "Endpoint nhận POST JSON, kiểm tra chữ ký X-TAHA-Signature và chống trùng bằng X-TAHA-Idempotency-Key." },
      { title: "Nhập secret dùng chung", detail: "Tạo secret mạnh và nhập trực tiếp ở cả website lẫn môi trường TAHA AI." },
      { title: "Đăng bản thử", detail: "Gửi một nội dung đã duyệt và kiểm tra ID/URL website trả về.", owner: true },
    ],
    checkpoint: "Website trả HTTP 2xx và JSON có id/url; gửi lại cùng idempotency key không tạo bài trùng.",
    note: "Để chúng tôi làm trọn bước này, cần domain, nền tảng và quyền truy cập repository hoặc VPS của website.",
  },
  {
    id: "tiktok",
    mark: "T",
    name: "TikTok Shop",
    role: "Kết nối shop và listing",
    tone: "tiktok",
    officialUrl: "https://partner.tiktokshop.com/",
    officialLabel: "Mở TikTok Partner Center",
    callback: `${appOrigin}/api/integrations/tiktok-shop/callback`,
    required: ["App Key", "App Secret", "Service ID", "Custom App cho thị trường VN"],
    steps: [
      { title: "Hoàn tất developer onboarding", detail: "Đăng nhập Partner Center bằng tài khoản doanh nghiệp và hoàn tất hồ sơ nhà phát triển.", owner: true },
      { title: "Tạo Custom App", detail: "Chọn App & Service, market Vietnam và nhóm Catalog / Product Listing.", owner: true },
      { title: "Bật API và callback", detail: "Enable API, nhập callback bên dưới và bật quyền authorization, product basic, product write." },
      { title: "Publish app", detail: "Hoàn tất trạng thái publish/review để lấy App Key, App Secret và Service ID.", owner: true },
      { title: "Ủy quyền shop", detail: "Từ TAHA AI, đăng nhập đúng TikTok Shop Seller và tự bấm chấp thuận.", owner: true },
    ],
    checkpoint: "TAHA AI hiển thị đúng tên shop và lưu shop cipher sau khi callback hoàn tất.",
    note: "Kết nối token không đồng nghĩa listing đã sẵn sàng. Ảnh, leaf category và thuộc tính bắt buộc còn phải được ánh xạ.",
  },
  {
    id: "shopee",
    mark: "S",
    name: "Shopee Seller",
    role: "Kết nối shop và listing",
    tone: "shopee",
    officialUrl: "https://open.shopee.com/",
    officialLabel: "Mở Shopee Open Platform",
    callback: `${appOrigin}/api/integrations/shopee/callback`,
    required: ["Partner ID", "Partner Key", "App production tại VN", "Quyền API product/media"],
    steps: [
      { title: "Đăng ký đối tác", detail: "Tạo tài khoản Open Platform và hoàn tất hồ sơ doanh nghiệp, hồ sơ dịch vụ nếu Shopee yêu cầu.", owner: true },
      { title: "Tạo ứng dụng VN", detail: "Trong Developer Console, tạo app cho Việt Nam và chọn môi trường production.", owner: true },
      { title: "Khai báo callback", detail: "Nhập callback bên dưới và request nhóm API shop authorization, product và media." },
      { title: "Chờ duyệt app", detail: "Hoàn tất kiểm thử/review để Partner ID và Partner Key hoạt động ở production.", owner: true },
      { title: "Ủy quyền shop", detail: "Từ TAHA AI, chủ Shopee Seller đăng nhập đúng shop và tự bấm ủy quyền.", owner: true },
    ],
    checkpoint: "Sau callback, TAHA AI hiển thị đúng Shop ID và không báo lỗi đổi authorization code lấy token.",
    note: "Trước khi tạo sản phẩm thật còn phải ánh xạ ngành hàng, thuộc tính, logistics, biến thể và ảnh Media Space.",
  },
];

export const metadata: Metadata = {
  title: "Hướng dẫn kết nối từng kênh | TAHA AI",
  description: "Các bước kết nối Google Drive, Google Sheets, Facebook, Zalo, website, TikTok Shop và Shopee với TAHA AI.",
};

function BrandMark() {
  return <span className="guide-brand-mark" aria-hidden="true"><i /><b>TA</b></span>;
}

function ChannelSection({ channel, index }: { channel: ChannelGuide; index: number }) {
  return (
    <article className={`guide-channel guide-tone-${channel.tone}`} id={channel.id}>
      <header className="guide-channel-header">
        <span className="guide-channel-mark" aria-hidden="true">{channel.mark}</span>
        <div>
          <span className="guide-kicker">KÊNH {String(index + 1).padStart(2, "0")}</span>
          <h2>{channel.name}</h2>
          <p>{channel.role}</p>
        </div>
        {channel.officialUrl ? (
          <a className="guide-official-link" href={channel.officialUrl} target="_blank" rel="noreferrer">
            {channel.officialLabel} <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <Link className="guide-official-link" href="/connections">Mở kết nối website <span aria-hidden="true">→</span></Link>
        )}
      </header>

      <div className="guide-requirements" aria-label={`Thông tin cần có cho ${channel.name}`}>
        <strong>Cần chuẩn bị</strong>
        <div>{channel.required.map((item) => <span key={item}>✓ {item}</span>)}</div>
      </div>

      {channel.callback ? (
        <div className="guide-callback">
          <div><span>CALLBACK CHÍNH XÁC</span><small>Không thêm dấu / ở cuối</small></div>
          <code>{channel.callback}</code>
        </div>
      ) : null}

      <ol className="guide-steps">
        {channel.steps.map((step, stepIndex) => (
          <li key={step.title}>
            <span className="guide-step-number">{stepIndex + 1}</span>
            <div>
              <div className="guide-step-title">
                <strong>{step.title}</strong>
                {step.owner ? <span className="guide-owner-badge">BẠN TỰ THỰC HIỆN</span> : <span className="guide-system-badge">TAHA AI / KỸ THUẬT</span>}
              </div>
              <p>{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="guide-checkpoint">
        <span aria-hidden="true">✓</span>
        <div><strong>Điểm kiểm tra hoàn tất</strong><p>{channel.checkpoint}</p></div>
      </div>
      {channel.note ? <p className="guide-channel-note"><strong>Lưu ý:</strong> {channel.note}</p> : null}
      <div className="guide-channel-action">
        <Link href="/connections">Đi đến Trung tâm kết nối <span aria-hidden="true">→</span></Link>
        <a href="#top">Lên đầu trang ↑</a>
      </div>
    </article>
  );
}

export default function ConnectionGuidePage() {
  return (
    <main className="connection-guide-page" id="top">
      <aside className="guide-sidebar">
        <Link className="guide-brand" href="/"><BrandMark /><div><strong>TAHA</strong><span>AI Commerce</span></div></Link>
        <Link className="guide-back" href="/connections"><span aria-hidden="true">←</span> Trung tâm kết nối</Link>
        <nav className="guide-nav" aria-label="Danh mục hướng dẫn">
          <span>HƯỚNG DẪN TỪNG KÊNH</span>
          {channels.map((channel, index) => (
            <a href={`#${channel.id}`} key={channel.id}><i>{index + 1}</i><span>{channel.name}</span></a>
          ))}
        </nav>
        <div className="guide-sidebar-help">
          <span aria-hidden="true">!</span>
          <div><strong>Không gửi khóa bí mật</strong><p>App Secret, Partner Key, token, OTP và QR chỉ nhập tại trang chính thức hoặc secret manager.</p></div>
        </div>
      </aside>

      <section className="guide-workspace">
        <header className="guide-hero">
          <div className="guide-hero-copy">
            <span className="guide-kicker">TRUNG TÂM HỖ TRỢ KẾT NỐI</span>
            <h1>Kết nối từng kênh,<br /><em>đúng ngay từ đầu.</em></h1>
            <p>Làm theo thứ tự bên dưới. Nhãn màu cam là bước bắt buộc chủ tài khoản tự đăng nhập, cấp quyền hoặc xác nhận.</p>
            <div className="guide-hero-actions">
              <Link href="/connections">Mở Trung tâm kết nối <span aria-hidden="true">→</span></Link>
              <a href="#google-drive">Bắt đầu với Google Drive</a>
            </div>
          </div>
          <div className="guide-hero-panel" aria-label="Quy trình bốn bước">
            <span className="guide-hero-panel-label">QUY TRÌNH CHUNG</span>
            <ol>
              <li><b>01</b><div><strong>Chuẩn bị</strong><span>Tài khoản, ID và dữ liệu nguồn</span></div></li>
              <li><b>02</b><div><strong>Cấu hình</strong><span>Callback và khóa trên máy chủ</span></div></li>
              <li><b>03</b><div><strong>Cấp quyền</strong><span>Chủ tài khoản tự đăng nhập</span></div></li>
              <li><b>04</b><div><strong>Kiểm tra</strong><span>Chạy một sản phẩm hoặc bài thử</span></div></li>
            </ol>
          </div>
        </header>

        <section className="guide-security-banner" aria-label="Lưu ý bảo mật">
          <span className="guide-security-icon" aria-hidden="true">✓</span>
          <div><strong>Phần chúng tôi có thể làm giúp</strong><p>Chuẩn bị callback, cấu hình hệ thống, endpoint website và kiểm tra kỹ thuật. Bạn chỉ cần hỗ trợ những bước có nhãn “Bạn tự thực hiện”.</p></div>
          <div className="guide-legend"><span><i className="owner" /> Bạn thao tác</span><span><i className="system" /> TAHA AI / kỹ thuật</span></div>
        </section>

        <section className="guide-storage-map" aria-labelledby="storage-title">
          <div className="guide-section-heading"><span className="guide-kicker">LƯU TRỮ ĐỘC LẬP</span><h2 id="storage-title">Mỗi kênh có nội dung và trạng thái riêng</h2><p>Sửa bài Facebook sẽ không ghi đè bản Zalo, TikTok, Shopee hoặc website.</p></div>
          <div className="guide-storage-grid">
            {channels.map((channel) => (
              <a href={`#${channel.id}`} key={channel.id}><span className={`guide-mini-mark guide-tone-${channel.tone}`}>{channel.mark}</span><div><strong>{channel.name}</strong><small>{channel.role}</small></div><i aria-hidden="true">→</i></a>
            ))}
          </div>
        </section>

        <section className="guide-channel-list" aria-label="Hướng dẫn chi tiết từng kênh">
          {channels.map((channel, index) => <ChannelSection channel={channel} index={index} key={channel.id} />)}
        </section>

        <footer className="guide-footer">
          <div><BrandMark /><div><strong>Đã sẵn sàng bắt đầu?</strong><p>Mở Trung tâm kết nối và thực hiện Google Drive trước.</p></div></div>
          <Link href="/connections">Mở Trung tâm kết nối <span aria-hidden="true">→</span></Link>
        </footer>
      </section>
    </main>
  );
}
