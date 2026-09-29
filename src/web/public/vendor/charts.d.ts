// Types for the page's type check only: scripts/vendor/charts-entry.js, which
// scripts/vendor-charts.mjs bundles into charts.js beside this file, with the
// types lightweight-charts publishes. The check reads this instead of the
// minified bundle. Never served: /vendor/ admits charts.js and
// charts.LICENSES.txt only, and a release leaves out .d.ts files.
export { createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode } from "lightweight-charts";
