import type { ScheduledTaskRecord, ScheduledTaskSchedule } from "../../../contracts/scheduled-tasks";
import { translate, type Translate } from "../../i18n";

/**
 * Display copy for scheduled tasks. Lives in the renderer rather than
 * `contracts/` because every string here follows the app language, while the
 * parsers in `contracts/scheduled-tasks.ts` stay language-neutral for the host.
 */

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Full weekday names, Sunday first, in the app language. */
export function weekdayNames(locale: string): readonly string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  // 2024-01-07 is a Sunday, so index 0 is Sunday like `Weekday`.
  return WEEKDAYS.map((day) => format.format(new Date(Date.UTC(2024, 0, 7 + day))));
}

function weekdayShortNames(locale: string): readonly string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  return WEEKDAYS.map((day) => format.format(new Date(Date.UTC(2024, 0, 7 + day))));
}

/** Wall-clock time for a schedule, in the user's 12/24-hour convention. */
export function formatClockTime(hour: number, minute: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2024, 0, 7, hour, minute)));
}

function joinNames(names: readonly string[], t: Translate): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return t("scheduledTasks.list.two", { first: names[0]!, second: names[1]! });
  return t("scheduledTasks.list.many", {
    rest: names.slice(0, -1).join(", "),
    last: names[names.length - 1]!,
  });
}

export function formatScheduledTaskRecurrence(
  schedule: ScheduledTaskSchedule,
  locale: string,
  t: Translate = translate,
): string {
  if (schedule.kind === "once") {
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) {
      return t("scheduledTasks.freq.once");
    }
    return t("scheduledTasks.freq.onceAt", {
      time: new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(at)),
    });
  }
  if (schedule.kind === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % (24 * 60) === 0) {
      return t("scheduledTasks.freq.everyDays", { count: minutes / (24 * 60) });
    }
    if (minutes % 60 === 0) {
      return t("scheduledTasks.freq.everyHours", { count: minutes / 60 });
    }
    return t("scheduledTasks.freq.everyMinutes", { count: minutes });
  }
  const time = formatClockTime(schedule.hour, schedule.minute, locale);
  if (schedule.kind === "daily") {
    return t("scheduledTasks.freq.dailyAt", { time });
  }
  const shortNames = weekdayShortNames(locale);
  const names = [...schedule.days].sort((left, right) => left - right).map((day) => shortNames[day]!);
  return t("scheduledTasks.freq.weeklyAt", { days: joinNames(names, t), time });
}

export function formatScheduledTaskNextRun(
  nextRunAt: string,
  locale: string,
  t: Translate = translate,
  now = new Date(),
): string {
  const timestamp = Date.parse(nextRunAt);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  const diffMs = timestamp - now.getTime();
  if (diffMs <= 0) {
    return t("scheduledTasks.next.dueNow");
  }
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) {
    return t("scheduledTasks.next.underMinute");
  }
  if (diffMinutes < 60) {
    return t("scheduledTasks.next.minutes", { count: diffMinutes });
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return t("scheduledTasks.next.hours", { count: diffHours });
  }
  return t("scheduledTasks.next.days", { count: Math.floor(diffHours / 24) });
}

export function formatScheduledTaskRowMeta(
  task: ScheduledTaskRecord,
  locale: string,
  t: Translate = translate,
  now = new Date(),
): string {
  const recurrence = formatScheduledTaskRecurrence(task.schedule, locale, t);
  if (task.status === "completed") {
    return recurrence;
  }
  if (task.status === "paused") {
    return t("scheduledTasks.row.paused", { recurrence });
  }
  if (!task.nextRunAt) {
    return recurrence;
  }
  return t("scheduledTasks.row.next", {
    recurrence,
    next: formatScheduledTaskNextRun(task.nextRunAt, locale, t, now),
  });
}

export { formatClockTime as formatTaskClockTime };
