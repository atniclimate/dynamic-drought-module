export interface HeatRiskFrameEventDetail {
  readonly status:
    | 'loading'
    | 'ready'
    | 'degraded'
    | 'error'
    | 'no-data'
    | 'inactive';
  readonly frames: readonly {
    readonly day: number;
    readonly validTime: number;
    readonly name: string;
  }[];
  readonly selectedDay: number | null;
  readonly hasCoverage: boolean | null;
}

interface HeatRiskSequenceModule {
  readonly mountHeatRiskSequence: (
    detail: HeatRiskFrameEventDetail
  ) => void;
}

export function createHeatRiskSequenceLoader(
  load: () => Promise<HeatRiskSequenceModule>,
  onError: (err: unknown) => void
): {
  readonly apply: (detail: HeatRiskFrameEventDetail) => void;
} {
  let latest: HeatRiskFrameEventDetail | null = null;
  let mounted = false;
  let loading = false;
  return {
    apply(detail): void {
      latest = detail;
      if (mounted || loading || detail.status === 'inactive') return;
      loading = true;
      void load()
        .then(({ mountHeatRiskSequence }) => {
          mounted = true;
          const snapshot = latest;
          if (snapshot) mountHeatRiskSequence(snapshot);
        })
        .catch((err: unknown) => {
          loading = false;
          onError(err);
        });
    }
  };
}
