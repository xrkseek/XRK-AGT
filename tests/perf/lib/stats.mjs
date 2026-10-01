/**
 * perf 套件统计：与生产 `#utils/metrics-stats.js` 同源 re-export
 */
export {
  LatencyHistogram,
  evaluateSlo,
  percentileR7,
  WelfordAccumulator,
  ReservoirSampler,
  SlidingErrorWindow,
} from '#utils/metrics-stats.js';
