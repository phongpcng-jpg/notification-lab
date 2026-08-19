import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("Đã sinh VAPID key pair mới. Dán 2 dòng dưới vào backend/.env:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(
  "\nLưu ý: KHÔNG commit private key thật vào git. Mỗi môi trường " +
    "(dev/staging/prod) nên có cặp key riêng."
);
