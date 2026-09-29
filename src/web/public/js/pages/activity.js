import { S } from "../core/store.js";
import { $, html, paint } from "../core/dom.js";
import { clock, dur, int } from "../core/format.js";
import { sessionLog } from "../core/store.js";

// ====================================================================== //
// activity                                                               //
// ====================================================================== //

export function renderActivity() {
  if (S.stats) {
    paint($("#astats"), html`
        <div class="kpi"><small>Uptime</small><b>${dur(S.stats.uptimeSec * 1000)}</b>
          <span>${int(S.stats.rows)} launch${S.stats.rows === 1 ? "" : "es"} tracked</span></div>
        <div class="kpi"><small>RPC calls</small><b>${int(S.stats.rpc.sub)}</b>
          <span>${S.stats.rpc.perMinute} per minute · folded into ${int(S.stats.rpc.http)} round trip${S.stats.rpc.http === 1 ? "" : "s"}</span></div>
        <div class="kpi"><small>Cached reads</small><b>${int(S.stats.cache.permanent + S.stats.cache.ttl)}</b>
          <span>${int(S.stats.cache.permanent)} immutable · ${int(S.stats.cache.ttl)} on a TTL · ${int(S.stats.cache.inflight)} in flight</span></div>
        <div class="kpi"><small>Feed</small><b>${S.stats.ws ? "websocket" : "polling"}</b>
          <span>${S.stats.ws ? "launches push in as they land"
            : "no WS_URL — launches arrive on the refresh sweep"}</span></div>`);
  }

  paint($("#atbody"), sessionLog.length
    ? sessionLog.map((e) => html`<tr><td class="mo">${clock(e.at)}</td><td>${e.event}</td>
          <td style="color:var(--tx3)">${e.detail}</td></tr>`)
    : html`<tr><td colspan="3" style="color:var(--tx3);padding:26px 19px">Nothing yet this session.</td></tr>`);
}
