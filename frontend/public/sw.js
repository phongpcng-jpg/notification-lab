/**
 * Service Worker cho Web Push.
 *
 * Đây là script chạy NGOÀI vòng đời tab trình duyệt — nó là lý do Web Push
 * hoạt động được cả khi tab đóng. Không dùng TypeScript/bundler ở đây (Vite
 * copy nguyên file trong public/ ra root khi build), vì service worker cần
 * là 1 file JS độc lập, đơn giản, không phụ thuộc module resolution phức tạp.
 */

const WEB_PUSH_TRACE = "[WebPush][SW]";

function trace(...args) {
  console.log(WEB_PUSH_TRACE, ...args);
}

self.addEventListener("push", (event) => {
  const receivedAt = Date.now();
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    console.error(WEB_PUSH_TRACE, "payload parse failed", err);
    // Payload không phải JSON hợp lệ — vẫn cố hiển thị 1 notification tối
    // thiểu thay vì im lặng bỏ qua (tốt hơn cho debugging).
    payload = { title: "Thông báo mới", body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "Thông báo mới";
  const notificationId = payload.notificationId ?? null;
  const options = {
    body: payload.body || "",
    icon: "/vite.svg",
    data: {
      postId: payload.postId ?? null,
      notificationId,
    },
  };

  trace("push received", {
    notificationId,
    postId: payload.postId ?? null,
    receivedAt,
  });

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options).then(() => {
        trace("showNotification completed", { notificationId });
      }),
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clientsArr) => {
          trace("clients matched", {
            notificationId,
            count: clientsArr.length,
            clients: clientsArr.map((client) => ({
              url: client.url,
              visibilityState: client.visibilityState,
              focused: client.focused,
            })),
          });

          for (const client of clientsArr) {
            trace("postMessage", {
              notificationId,
              url: client.url,
              visibilityState: client.visibilityState,
            });
            client.postMessage({
              type: "notification",
              notificationId,
            });
          }
        }),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  const notificationId = event.notification?.data?.notificationId ?? null;
  trace("notificationclick", { notificationId });
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      trace("notificationclick clients matched", {
        notificationId,
        count: clientsArr.length,
      });
      if (clientsArr.length > 0) {
        return clientsArr[0].focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
