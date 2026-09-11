import type { Observation } from '@techpulse/contracts';
import type { MetricObservationRecord, MetricObservationRepositoryPort } from '@techpulse/domain';

export interface MetricComparisonInput {
  readonly subject: string;
  readonly current: readonly MetricObservationRecord[];
  readonly baseline: readonly MetricObservationRecord[];
}

function aggregateComparableRows(rows: readonly MetricObservationRecord[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const row of rows) {
    if (row.isIncomplete) continue;
    const key = `${row.metricType}\u0000${row.unit}`;
    values.set(key, (values.get(key) ?? 0) + row.value);
  }
  return values;
}

export function computeMetricObservations(input: MetricComparisonInput): readonly Observation[] {
  const current = aggregateComparableRows(input.current);
  const baseline = aggregateComparableRows(input.baseline);
  const observations: Observation[] = [];

  for (const [key, value] of current) {
    const [metric, unit] = key.split('\u0000');
    if (!metric || !unit) continue;
    const baselineValue = baseline.get(key);
    const change =
      baselineValue === undefined || baselineValue === 0
        ? null
        : (value - baselineValue) / baselineValue;
    observations.push({
      subject: input.subject,
      metric: metric as Observation['metric'],
      value,
      unit,
      change,
    });
  }

  return observations.sort(
    (left, right) => left.metric.localeCompare(right.metric) || left.unit.localeCompare(right.unit),
  );
}

export async function loadComparisonObservations(input: {
  readonly repository: MetricObservationRepositoryPort;
  readonly subjects: readonly string[];
  readonly from: Date;
  readonly to: Date;
}): Promise<readonly Observation[]> {
  const durationMs = input.to.getTime() - input.from.getTime();
  const baselineFrom = new Date(input.from.getTime() - durationMs);
  const results: Observation[] = [];

  for (const subject of input.subjects) {
    const [currentPage, baselinePage] = await Promise.all([
      input.repository.listBySubject(subject, {
        windowStartAfter: input.from,
        windowEndBefore: input.to,
      }),
      input.repository.listBySubject(subject, {
        windowStartAfter: baselineFrom,
        windowEndBefore: input.from,
      }),
    ]);
    results.push(
      ...computeMetricObservations({
        subject,
        current: currentPage.items,
        baseline: baselinePage.items,
      }),
    );
  }

  return results;
}
