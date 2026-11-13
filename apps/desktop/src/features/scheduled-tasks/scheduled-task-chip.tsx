import type { ScheduledTaskRecord } from "../../../contracts/desktop-state";
import { formatScheduledTaskRowMeta } from "./task-format";
import { useI18n, useTranslation } from "../../i18n";

interface ScheduledTaskChipProps {
  readonly task: ScheduledTaskRecord;
  readonly onOpen: () => void;
}

export function ScheduledTaskChip({ task, onOpen }: ScheduledTaskChipProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  return (
    <div className="scheduled-task-chip" data-testid="scheduled-task-chip">
      <span>{formatScheduledTaskRowMeta(task, locale, t)}</span>
      <button className="button button--secondary" type="button" onClick={onOpen}>
        {t("scheduledTasks.open")}
      </button>
    </div>
  );
}
