/**
 * Service Worker cho Web Push.
 *
 * Đây là script chạy NGOÀI vòng đời tab trình duyệt — nó là lý do Web Push
 * hoạt động được cả khi tab đóng. Không dùng TypeScript/bundler ở đây (Vite
 * copy nguyên file trong public/ ra root khi build), vì service worker cần
 * là 1 file JS độc lập, đơn giản, không phụ thuộc module resolution phức tạp.
 */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    // Payload không phải JSON hợp lệ — vẫn cố hiển thị 1 notification tối
    // thiểu thay vì im lặng bỏ qua (tốt hơn cho debugging).
    payload = { title: "Thông báo mới", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Thông báo mới";
  const options = {
    body: payload.body || "",
    icon: "/vite.svg",
    data: {
      postId: payload.postId ?? null,
      notificationId: payload.notificationId ?? null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      if (clientsArr.length > 0) {
        return clientsArr[0].focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
