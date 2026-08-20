const FILLER =
  "Đây là nội dung mô phỏng dùng cho benchmark payload size, lặp lại tới khi đạt độ dài mong muốn. ";

const TARGET_CHARS: Record<"small" | "medium" | "large", number> = {
  small: 50,
  medium: 500,
  large: 3000,
};

export function generateScript(size: "small" | "medium" | "large"): string {
  const target = TARGET_CHARS[size];
  let text = "";
  while (text.length < target) text += FILLER;
  return text.slice(0, target);
}
