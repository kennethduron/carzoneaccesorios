/* global firebase */

importScripts("https://www.gstatic.com/firebasejs/12.15.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.15.0/firebase-messaging-compat.js");

const firebaseConfigPromise = fetch("/api/push/firebase-config", { credentials: "same-origin", cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((payload) => {
    if (!payload?.configured || !payload?.firebaseConfig) {
      return null;
    }

    firebase.initializeApp(payload.firebaseConfig);
    return firebase.messaging();
  })
  .catch(() => null);

firebaseConfigPromise.then((messaging) => {
  if (!messaging) return;

  messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || payload.data?.title || "Car Zone Accesorios";
    const body = payload.notification?.body || payload.data?.body || "Tienes una nueva notificacion.";
    const url = payload.data?.url || "/admin";

    self.registration.showNotification(title, {
      body,
      data: { url },
      icon: "/favicon.png",
      badge: "/favicon.png",
      tag: payload.data?.notification_id || payload.messageId,
    });
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || "/admin", self.location.origin).href;

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client && client.url.startsWith(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }

        return clients.openWindow(targetUrl);
      }),
  );
});
