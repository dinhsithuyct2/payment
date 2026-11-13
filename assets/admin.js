/* Trang quản trị: trạng thái phòng, xác nhận tiền, reset, cấu hình, race test */
(() => {
  'use strict';
  const P = window.PayDemo;
  const { api, esc, vnd } = P;
  const KEY = 'paydemo.adminCode';

  const STATUS_TEXT = {
    available: 'Còn trống', held: 'Đang giữ', sold: 'Đã bán',
    issued: 'Đã cấp QR', won: 'Thắng — đang giữ phòng', lost: 'Thua — bị từ chối', expired: 'Hết hạn',
    reported: 'Báo đã chuyển khoản', paid: 'Đã thanh toán', cancelled: 'Đã huỷ',
  };
  const REASON_TEXT = {
    HELD_BY_OTHER: 'phòng đã có người giữ', SOLD: 'phòng đã bán', QR_TIMEOUT: 'QR quá hạn',
    HOLD_TIMEOUT: 'quá giờ giữ phòng', ADMIN_RELEASE: 'admin huỷ',
  };
  const EVENT_TEXT = {
    QR_ISSUED: 'Cấp QR giữ chỗ', WON: '✅ THẮNG — giữ phòng', LOST: '❌ THUA — bị từ chối',
    RESCAN: 'Quét lại (người thắng)', SCAN_REJECTED: 'Quét lại — bị từ chối', HOLD_EXPIRED: 'Hết giờ giữ phòng',
    QR_EXPIRED: 'QR hết hạn', TRANSFER_REPORTED: 'Khách báo đã chuyển khoản', PAID_CONFIRMED: '💰 Xác nhận đã nhận tiền',
    ADMIN_RELEASE: 'Admin huỷ giữ phòng', RESET: 'Reset demo', SETTINGS_UPDATED: 'Cập nhật cấu hình',
  };

  let code = P.store.get(KEY);
  let state = null;
  let racing = false;
  let stopPoll = null;
  let settingsFilled = false;

  const badge = (st) => `<span class="badge st-${esc(st)}">${esc(STATUS_TEXT[st] || st)}</span>`;
  const device = (ua) => {
    if (!ua) return '';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS/i.test(ua)) return 'Mac';
    return ua.slice(0, 24);
  };

  // ------------------------------------------------------------------
  function showLogin(msg = '') {
    if (stopPoll) { stopPoll(); stopPoll = null; }
    P.$('#dash').hidden = true;
    P.$('#loginCard').hidden = false;
    P.$('#loginErr').textContent = msg;
  }

  async function login(c) {
    try {
      const st = await api.adminState(c);
      code = c;
      P.store.set(KEY, c);
      P.$('#loginCard').hidden = true;
      P.$('#dash').hidden = false;
      render(st);
      stopPoll = P.poll(refresh, 2000, { delayFirst: true });
    } catch (e) {
      P.store.set(KEY, null);
      showLogin(e.message);
    }
  }

  async function refresh() {
    if (racing) return;
    try {
      render(await api.adminState(code));
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.code === '28000') showLogin(e.message);
      else throw e;
    }
  }

  async function act(fn, okMsg) {
    try {
      const r = await fn();
      if (r && r.sessions) render(r); else await refresh();
      if (okMsg) P.toast(okMsg);
    } catch (e) {
      P.toast(e.message);
    }
  }

  // ------------------------------------------------------------------
  function render(st) {
    state = st;
    const rm = st.room;
    const h = rm.holder;
    P.$('#roomCard').innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:start;flex-wrap:wrap">
        <div><div class="eyebrow">Phòng ${esc(rm.id)}</div><h2 style="margin:2px 0 4px">${esc(rm.name)}</h2>${badge(rm.status)}</div>
        <div class="price">${vnd(rm.price)}</div>
      </div>
      ${rm.status === 'held' && h ? `
        <div class="banner warn" style="margin-top:12px;display:block">
          Đang giữ cho <b>${esc(h.customer)}</b> · nội dung CK <b class="mono">${esc(h.memo)}</b><br>
          ${rm.held_until ? `Tự trả phòng sau <span class="countdown" data-until="${rm.held_until}">--:--</span>` : 'Khách đã báo chuyển khoản — chờ bạn kiểm tra tài khoản ngân hàng'}
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn ok" id="confirmBtn" type="button">✔ Xác nhận đã nhận ${vnd(h.amount)}</button>
          <button class="btn danger" id="releaseBtn" type="button">Huỷ giữ phòng</button>
        </div>` : ''}
      ${rm.status === 'sold' && h ? `<div class="banner ok" style="margin-top:12px">Đã bán cho <b>${esc(h.customer)}</b> (${esc(h.memo)}) lúc ${P.fmtClock(rm.sold_at)}</div>` : ''}
      ${rm.status === 'available' ? '<p class="muted" style="margin-top:12px">Phòng đang trống — sẵn sàng cho lượt thử tiếp theo.</p>' : ''}
      <div class="btn-row" style="margin-top:12px"><button class="btn" id="resetBtn" type="button">↺ Reset demo</button></div>`;

    const cb = P.$('#confirmBtn');
    if (cb) cb.addEventListener('click', () => {
      if (confirm(`Xác nhận đã nhận ${vnd(h.amount)} với nội dung "${h.memo}" trong tài khoản ngân hàng?`)) {
        act(() => api.adminConfirmPaid(code, h.id), 'Đã xác nhận — phòng chuyển sang Đã bán');
      }
    });
    const rb = P.$('#releaseBtn');
    if (rb) rb.addEventListener('click', () => {
      if (confirm('Huỷ giữ phòng của khách này và mở lại phòng?')) act(() => api.adminRelease(code), 'Đã huỷ giữ phòng');
    });
    P.$('#resetBtn').addEventListener('click', () => {
      if (confirm('Reset demo? Mọi phiên thanh toán và nhật ký sẽ bị xoá, phòng trở về trạng thái còn trống.')) {
        act(() => api.adminReset(code), 'Đã reset demo');
      }
    });

    // Cấu hình (chỉ điền lần đầu để không ghi đè khi đang gõ)
    if (!settingsFilled) {
      P.$('#sPrice').value = rm.price;
      P.$('#sHold').value = st.settings.hold_seconds;
      P.$('#sTtl').value = st.settings.qr_ttl_seconds;
      settingsFilled = true;
    }
    const s = st.settings;
    P.$('#bankInfo').innerHTML = `Tài khoản nhận: <b>${esc(s.bank_name)}</b> (BIN ${esc(s.bank_bin)}) · STK <b>${esc(s.account_no)}</b> · ${esc(s.account_name)}<br>
      Đổi tài khoản nhận: sửa mục 2 trong <code>supabase/setup.sql</code> rồi chạy lại.`;

    // Bảng phiên
    const sessions = st.sessions || [];
    const scanned = sessions.filter((x) => x.first_scan_at).length;
    P.$('#sessCount').textContent = `(${sessions.length} phiên · ${scanned} đã quét)`;
    P.$('#sessBody').innerHTML = sessions.length ? sessions.map((x) => `
      <tr class="${['won', 'reported', 'paid'].includes(x.status) ? 'win' : ''}">
        <td><b>${esc(x.customer)}</b></td>
        <td>${badge(x.status)}${x.reason ? `<div class="small muted">${esc(REASON_TEXT[x.reason] || x.reason)}</div>` : ''}</td>
        <td class="mono">${P.fmtClock(x.created_at)}</td>
        <td class="mono">${P.fmtClock(x.first_scan_at)}</td>
        <td>${x.scan_count}</td>
        <td class="mono">${esc(x.memo)}</td>
        <td class="small">${esc(device(x.user_agent))}</td>
        <td>${['won', 'reported'].includes(x.status) ? `<button class="btn sm ok" type="button" data-confirm="${esc(x.id)}">Xác nhận tiền</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="8" class="muted">Chưa có phiên nào.</td></tr>';
    P.$$('[data-confirm]').forEach((b) => b.addEventListener('click', () => {
      if (confirm('Xác nhận đã nhận tiền cho phiên này?')) act(() => api.adminConfirmPaid(code, b.dataset.confirm), 'Đã xác nhận');
    }));

    // Nhật ký
    const names = Object.fromEntries(sessions.map((x) => [x.id, x.customer]));
    P.$('#eventLog').innerHTML = (st.events || []).map((e) => {
      const d = e.detail || {};
      const who = d.customer || names[e.session_id] || '';
      const extra = e.type === 'LOST' && d.late_ms != null ? ` — chậm hơn ${P.fmtDuration(Number(d.late_ms))}`
        : (e.type === 'WON' || e.type === 'LOST') && d.lock_wait_ms != null && Number(d.lock_wait_ms) > 0.5 ? ` — chờ khoá ${P.fmtDuration(Number(d.lock_wait_ms))}` : '';
      return `<div>${P.fmtClock(e.at)}  ${esc(EVENT_TEXT[e.type] || e.type)}${who ? ' · ' + esc(who) : ''}${esc(extra)}</div>`;
    }).join('') || '<div class="muted">Trống</div>';
  }

  // ------------------------------------------------------------------
  // Race test
  // ------------------------------------------------------------------
  async function raceTest() {
    const n = Math.min(50, Math.max(2, Number(P.$('#raceN').value) || 20));
    if (!confirm(`Race test sẽ RESET demo (xoá mọi phiên) rồi bắn ${n} lượt quét đồng thời. Tiếp tục?`)) return;
    const out = P.$('#raceOut');
    const btn = P.$('#raceBtn');
    racing = true;
    btn.disabled = true;
    out.innerHTML = '<p class="muted">Đang reset và tạo mã…</p>';
    try {
      await api.adminReset(code);
      const created = await Promise.all(Array.from({ length: n }, (_, i) => api.createSession('Race #' + String(i + 1).padStart(2, '0'))));
      const bad = created.find((c) => !c.ok);
      if (bad) throw new Error('Không tạo được mã: ' + bad.code);
      out.innerHTML = `<p class="muted">Đang bắn ${n} lượt quét đồng thời…</p>`;
      const results = await Promise.all(created.map((c) => api.claim(c.session.id)
        .then((r) => ({ name: c.session.customer, r }), (e) => ({ name: c.session.customer, e }))));
      const okRes = results.filter((x) => x.r);
      const winners = okRes.filter((x) => x.r.code === 'WON');
      const losers = okRes.filter((x) => x.r.code === 'LOST');
      const leaked = losers.filter((x) => x.r.payment);
      const arrived = okRes.map((x) => x.r.timing.arrived_at);
      const spread = arrived.length ? Math.max(...arrived) - Math.min(...arrived) : 0;
      const pass = winners.length === 1 && losers.length === n - 1 && !leaked.length;
      okRes.sort((a, b) => a.r.timing.decided_at - b.r.timing.decided_at || Number(a.r.timing.lock_wait_ms) - Number(b.r.timing.lock_wait_ms));
      out.innerHTML = `
        <p class="race-summary ${pass ? 'pass' : 'fail'}">${pass
          ? `✅ ĐẠT: ${winners.length} người thắng / ${losers.length} người bị từ chối — không ai trong số người thua nhận được thông tin chuyển khoản.`
          : `❌ KHÔNG ĐẠT: ${winners.length} người thắng, ${losers.length} thua, ${results.length - okRes.length} lỗi, ${leaked.length} lộ thông tin.`}</p>
        <p class="small muted">${n} yêu cầu tới cơ sở dữ liệu trong khoảng <b>${P.fmtDuration(spread)}</b>. Khoá dòng buộc chúng xử lý lần lượt — cột “Chờ khoá” cho thấy các yêu cầu thực sự chồng lấn nhau.</p>
        <div class="table-wrap" style="margin-top:8px"><table>
          <thead><tr><th>Thứ tự xử lý</th><th>Khách</th><th>Kết quả</th><th>Tới DB lúc</th><th>Chờ khoá</th><th>Phán quyết lúc</th><th>Nhận thông tin CK?</th></tr></thead>
          <tbody>${okRes.map((x, i) => `
            <tr class="${x.r.code === 'WON' ? 'win' : ''}">
              <td>${i + 1}</td><td>${esc(x.name)}</td><td>${badge(x.r.code.toLowerCase())}</td>
              <td class="mono">${P.fmtClock(x.r.timing.arrived_at)}</td>
              <td class="mono">${P.fmtDuration(Number(x.r.timing.lock_wait_ms))}</td>
              <td class="mono">${P.fmtClock(x.r.timing.decided_at)}</td>
              <td>${x.r.payment ? '<b>Có</b> (' + esc(x.r.payment.memo) + ')' : 'Không'}</td>
            </tr>`).join('')}
            ${results.filter((x) => x.e).map((x) => `<tr><td>—</td><td>${esc(x.name)}</td><td colspan="5" style="color:var(--bad)">${esc(x.e.message)}</td></tr>`).join('')}
          </tbody></table></div>
        <p class="small muted" style="margin-top:8px">Phòng hiện đang được giữ cho người thắng. Bấm <b>Reset demo</b> trước khi thử với điện thoại.</p>`;
    } catch (e) {
      out.innerHTML = `<p class="race-summary fail">Lỗi: ${esc(e.message)}</p>`;
    } finally {
      racing = false;
      btn.disabled = false;
      refresh().catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  if (!P.isConfigured()) {
    P.$('#app').innerHTML = P.notConfiguredHtml();
    return;
  }
  P.$('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); login(P.$('#codeInput').value.trim()); });
  P.$('#logoutBtn').addEventListener('click', () => { P.store.set(KEY, null); code = null; showLogin(); });
  P.$('#raceBtn').addEventListener('click', raceTest);
  P.$('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => api.adminUpdate(code, {
      price: Number(P.$('#sPrice').value), hold: Number(P.$('#sHold').value), ttl: Number(P.$('#sTtl').value),
    }), 'Đã lưu cấu hình');
  });
  if (code) login(code); else showLogin();
})();
