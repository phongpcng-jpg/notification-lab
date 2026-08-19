# Transport Report: Web Push

**Technique:** Web Push (Push API + Service Worker + Notification API)

**Architecture:**
Khác hoàn toàn 4 transport kia — không có "kết nối đang mở". Client đăng ký
1 lần qua `PushManager.subscribe()` (browser), gửi `PushSubscription` về
`POST /push/subscribe` để lưu vào bảng `push_subscriptions`. Khi có
notification mới, `sendWebPushForNotification()` gửi payload qua thư viện
`web-push` (VAPID) tới **Push Service của trình duyệt** (FCM/Mozilla
Autopush/...) — KHÔNG gửi trực tiếp tới browser, đúng như research report
mục 2.5 đã phân tích. Push Service sau đó đánh thức Service Worker
(`public/sw.js`) của trình duyệt, kể cả khi tab đã đóng, để hiển thị
notification cấp hệ điều hành qua `Notification API`.

## Điểm khác biệt kiến trúc quan trọng nhất
Không có `Hub` (SseHub/WsHub) ở transport này — vì không có gì để "publish
vào 1 kết nối đang mở". Thay vào đó chỉ có 1 hàm gửi
(`webPushSender.ts`), gọi trực tiếp trong listener của
`NotificationService`, độc lập hoàn toàn với việc user có đang mở tab hay
không — đây chính là lý do Web Push là **transport duy nhất trong 5 loại
đạt được "offline/background delivery"**.

## Strengths
- Duy nhất hoạt động khi tab/trang web đóng (đúng mục tiêu chính của kỹ
  thuật này, khác hẳn 4 transport còn lại vốn chỉ phục vụ khi tab đang mở).
- Không giữ kết nối liên tục từ client → tiết kiệm tài nguyên server hơn
  SSE/WebSocket cho notification không thường xuyên.
- Xử lý đúng lifecycle subscription: tự động đánh dấu `invalid_at` khi Push
  Service trả 404/410 (subscription hết hạn), không gửi lại vô ích lần sau
  — đã test riêng cho case này.

## Weaknesses
- Yêu cầu permission người dùng chủ động chấp thuận — không thể ép buộc,
  và trình duyệt chỉ cho gọi `Notification.requestPermission()` từ user
  gesture (không tự động hoá được khi component mount, khác hẳn 4 hook kia).
- Không đảm bảo delivery — best-effort qua Push Service bên thứ 3, hệ thống
  hoàn toàn không kiểm soát được nếu Push Service chậm/lỗi.
- Giới hạn payload (~4KB tuỳ Push Service, project hiện chưa test payload
  lớn — để dành Scenario I).
- Cần HTTPS bắt buộc — dev local dùng ngoại lệ `localhost` (Assumption A3
  đã xác nhận với bạn từ đầu Phase 2).

## Implementation complexity
Cao — nhiều thành phần phối hợp (Service Worker, Push API, VAPID, subscription
lifecycle) đúng như đánh giá "Cao (nhiều thành phần)" trong research report
gốc và bảng so sánh Section 3.

## Testing
`backend/src/routes/webPush.test.ts` — **mock toàn bộ thư viện `web-push`**
(`vi.mock("web-push")`) vì test không được phép gọi Push Service thật (không
có network trong sandbox, và cũng không nên phụ thuộc dịch vụ bên thứ 3 để
unit test pass/fail — đúng nguyên tắc research methodology). 9 test: public
key trả null/có giá trị tuỳ cấu hình, subscribe lưu đúng, upsert theo
endpoint, unsubscribe xoá đúng, gọi `sendNotification` đúng subscription khi
VAPID đã cấu hình, bỏ qua êm khi chưa cấu hình VAPID (route `/posts` vẫn
201), **subscription hết hạn (410) → đánh dấu invalid + không gửi lại lần
sau** (test 2 bước), thiếu field bắt buộc → 400, `userId` không tồn tại → 404.

**Chưa test được / không thể test bằng unit test** (ghi rõ, không giấu):
- Hành vi Service Worker thật (`public/sw.js`) — chỉ chạy được trong môi
  trường trình duyệt thật, không chạy trong Node.js/vitest. Cần test thủ
  công: mở app, bật Web Push, đóng tab, gọi API tạo post từ user khác theo
  dõi, kiểm tra notification hệ điều hành xuất hiện.
- Độ trễ/tỷ lệ delivery thật qua Push Service (FCM/Mozilla Autopush) — phụ
  thuộc hạ tầng bên thứ 3, không đo được bằng benchmark nội bộ, chỉ có thể
  quan sát qua test thủ công trên nhiều trình duyệt/OS thật.
- Hành vi khác biệt giữa trình duyệt/OS (đặc biệt Safari/iOS chỉ hỗ trợ đầy
  đủ từ iOS 16.4 + cần "Add to Home Screen" — đã ghi trong research report
  4.4) — chưa kiểm chứng lại, cần test thiết bị thật.

**Chưa chạy thật** trong sandbox này (không có network để `npm install`, và
kể cả khi cài được cũng không nên test Push Service thật từ CI).

## Benchmark status
PENDING. Ghi chú thêm: Web Push có bản chất "không đồng bộ, best-effort" nên
benchmark latency sẽ đo 2 giai đoạn tách biệt — (1) thời gian server gửi
xong request tới Push Service (đo được), (2) thời gian Push Service thực sự
đánh thức Service Worker (KHÔNG đo được từ phía server, chỉ quan sát được
qua test thủ công trên client thật) — sẽ ghi rõ giới hạn này trong báo cáo
benchmark cuối cùng khi tới Phase 9, không gộp 2 con số này thành 1
"latency" duy nhất.

## Best suất for
Thông báo cần đến tay người dùng dù họ không mở tab — đúng domain chính của
project (user đăng bài, follower cần biết dù không đang mở app).

## Poorly suited for
Cập nhật UI liên tục khi user đang thao tác trong app (SSE/WebSocket phù
hợp hơn nhiều); trường hợp cần đảm bảo 100% delivery tuyệt đối.

---

| Category | Assessment |
|---|---|
| Complexity | Cao (nhiều thành phần: SW, Push API, VAPID, subscription lifecycle) |
| Latency | Không đo được đầy đủ từ phía server (phụ thuộc Push Service) — PENDING |
| Throughput | Chưa đo (PENDING) |
| Scalability | Tốt về lý thuyết (không giữ kết nối) — chưa benchmark xác nhận |
| Reliability | Best-effort, KHÔNG đảm bảo delivery — khác hẳn 4 transport kia |
| Browser support | Tốt trên Chrome/Firefox; hạn chế trên Safari/iOS (cần iOS 16.4+, Add to Home Screen) |
| Infrastructure | Cần VAPID key, phụ thuộc Push Service bên thứ 3 |
| Operational complexity | Cao |
| Best use case | Notification khi user offline/tab đóng |
