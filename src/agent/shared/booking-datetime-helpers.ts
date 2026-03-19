type TimeParts = { hh: number; mm: number };
type IstanbulDateParts = {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
};

export type PendingDateOnlyPatch = {
  nextPendingDateOnly: string;
};

export type DateTimeCommitPatch = {
  nextStartAt: string;
  nextPendingStartAt: string;
  clearPendingDateOnly: true;
};

export function mergePendingDateOnlyWithTime(
  pendingDateOnly: string | undefined,
  rawNorm: string,
  deps: {
    parseTimeBest: (text: string) => TimeParts | null;
    clampToFuture: (date: Date) => Date;
    toIstanbulIso: (date: Date) => string;
  },
): string | null {
  if (!pendingDateOnly) return null;

  const onlyTime = deps.parseTimeBest(rawNorm);
  if (!onlyTime) return null;

  const [yy, mm, dd] = pendingDateOnly.split('-').map(Number);
  const dUtc = new Date(
    Date.UTC(yy, mm - 1, dd, onlyTime.hh - 3, onlyTime.mm, 0, 0),
  );
  return deps.toIstanbulIso(deps.clampToFuture(dUtc));
}

export function mergeDateOnlyWithExistingTime(
  dateOnly: string,
  baseStartAtIso: string,
  deps: {
    getTrPartsFromIso: (iso: string) => IstanbulDateParts | null;
    clampToFuture: (date: Date) => Date;
    toIstanbulIso: (date: Date) => string;
  },
): string | null {
  const [yy, mm, dd] = dateOnly.split('-').map(Number);
  const prev = deps.getTrPartsFromIso(baseStartAtIso);
  if (!prev) return null;

  const mergedUtc = new Date(Date.UTC(yy, mm - 1, dd, prev.hh - 3, prev.mm, 0, 0));
  return deps.toIstanbulIso(deps.clampToFuture(mergedUtc));
}

export function buildPendingDateOnlyPatch(
  dateOnly: string,
): PendingDateOnlyPatch {
  return {
    nextPendingDateOnly: dateOnly,
  };
}

export function buildDateTimeCommitPatch(
  startAtIso: string,
): DateTimeCommitPatch {
  return {
    nextStartAt: startAtIso,
    nextPendingStartAt: startAtIso,
    clearPendingDateOnly: true,
  };
}
