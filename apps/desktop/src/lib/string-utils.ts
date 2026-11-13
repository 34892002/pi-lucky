import { translate, type Translate } from "../i18n";

export function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatRelativeTime(value: string, t: Translate = translate): string {
  if (!value) {
    return "";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return t("time.now");
  if (diffMinutes < 60) return t("time.minutes", { count: diffMinutes });
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return t("time.hours", { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return t("time.days", { count: diffDays });
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return t("time.weeks", { count: diffWeeks });
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return t("time.months", { count: diffMonths });
  const diffYears = Math.floor(diffDays / 365);
  return t("time.years", { count: diffYears });
}
