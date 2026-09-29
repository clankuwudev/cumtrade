// The token page's candlestick chart (docs/specs/tv-candlestick-chart.md, TV0):
// TradingView's Lightweight Charts, bundled by scripts/vendor-charts.mjs into
// src/web/public/vendor/charts.js. Only what the page draws is exported, so
// the rest is tree-shaken away.
//
// The page must create every chart with `layout.attributionLogo: false`. The
// built-in logo is written with innerHTML and an inline <style>, which the
// page's Trusted Types and style-src-elem rules refuse. The page shows the
// licence's attribution notice and link itself, built with its own DOM helpers.
export { createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode } from "lightweight-charts";
