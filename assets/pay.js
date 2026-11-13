/* Trang mở ra khi khách quét QR giữ chỗ.
 * Gọi paydemo_claim → máy chủ khoá phòng nguyên tử:
 *   - Người đầu tiên: nhận thông tin chuyển khoản (deeplink app ngân hàng + VietQR)
 *   - Người đến sau : bị từ chối, không bao giờ nhận được thông tin chuyển khoản */
(() => {
  'use strict';
  const P = window.PayDemo;
  const { api, esc } = P;
  const app = document.getElementById('app');
  const sid = P.qs('s');

  let current = null;
  let renderedKey = '';
  let stopPoll = null;

  const stop = () => { if (stopPoll) { stopPoll(); stopPoll = null; } };
  const setView = (html, key) => { app.innerHTML = html; renderedKey = key; };

  async function start() {
    if (!P.isConfigured()) { app.innerHTML = P.notConfiguredHtml(); return; }
    if (!sid) { show({ code: 'NOT_FOUND' }); return; }
    try {
      const r = await api.claim(sid);   // ★ lượt "giành phòng"
      show(r);
      if (r.code === 'WON' || r.code === 'REPORTED') {
        stopPoll = P.poll(async () => show(await api.getSession(sid)), 2000, { delayFirst: true });
      }
    } catch (e) {
      setView(`
        <section class="card result warn">
          <div class="result-icon">!</div>
          <h2>Không kết nối được hệ thống</h2>
          <p>${esc(e.message)}</p>
          <button class="btn primary" type="button" onclick="location.reload()">Thử lại</button>
          <p class="fine">Thử lại là an toàn: nếu bạn đã giữ được phòng, hệ thống vẫn nhận ra bạn.</p>
        </section>`, 'error');
    }
  }

  function show(r) {
    current = r;
    switch (r.code) {
      case 'WON': return wonView(r);
      case 'REPORTED': return reportedView(r);
      case 'LOST': stop(); return lostView(r);
      case 'EXPIRED': stop(); return expiredView(r);
      case 'PAID': stop(); return result('ok', '✓', 'Thanh toán thành công 🎉',
        `Chủ phòng đã xác nhận khoản chuyển. <b>${esc(r.room.name)}</b> đã được đặt cho ${esc(r.session.customer)}.`);
      case 'CANCELLED': stop(); return result('warn', '!', 'Giữ chỗ đã bị huỷ', 'Chủ phòng đã huỷ giữ chỗ của bạn.');
      default: stop(); return result('warn', '?', 'Mã QR không hợp lệ',
        'Mã giữ chỗ không tồn tại hoặc đã bị xoá (có thể demo vừa được reset).');
    }
  }

  // ✅ Người quét đầu tiên
  function wonView(r) {
    const key = 'won:' + r.session.id;
    if (renderedKey === key) return;
    const p = r.payment;
    const plat = P.platform();
    const apps = (window.PAYDEMO_BANK_APPS || {})[plat === 'ios' ? 'ios' : 'android'] || [];
    const last = apps.find((a) => a.id === P.store.get('paydemo.bankApp'));
    const back = location.href;
    const tile = (a) => `<a class="app" href="${esc(P.bankDeeplink(a.id, p, back))}" data-app="${esc(a.id)}" rel="noopener">
        ${a.autofill ? '<span class="af">Tự điền</span>' : ''}
        <img src="${esc(a.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${esc(a.name)}</span></a>`;
    const img = P.paymentImageDataUrl(p);
    const file = 'vietqr-' + p.memo.replace(/\s+/g, '-') + '.png';

    const appsHtml = plat === 'desktop'
      ? '<p>Mở app ngân hàng trên điện thoại và <b>quét mã VietQR</b> bên dưới.</p>'
      : `<h2>Chọn app ngân hàng để chuyển khoản</h2>
         ${last ? `<a class="btn primary big block app-primary" href="${esc(P.bankDeeplink(last.id, p, back))}" data-app="${esc(last.id)}"><img src="${esc(last.logo)}" alt="">Mở ${esc(last.name)}</a>` : ''}
         <div class="apps">${apps.slice(0, 9).map(tile).join('')}</div>
         <details class="more"><summary>Xem tất cả ${apps.length} ngân hàng</summary><div class="apps">${apps.slice(9).map(tile).join('')}</div></details>
         <p class="small muted">App có nhãn <b>Tự điền</b> sẽ điền sẵn số tài khoản, số tiền và nội dung. Với app khác: lưu ảnh QR bên dưới, trong app chọn <b>Quét QR → chọn ảnh</b>.</p>`;

    setView(`
      <section class="card result ok" style="padding-bottom:18px">
        <div class="result-icon">✓</div>
        <h1>Bạn là người đầu tiên!</h1>
        <p><b>${esc(r.room.name)}</b> đang được giữ cho bạn.<br>Vui lòng chuyển khoản trong <span class="countdown" data-until="${r.room.held_until}">--:--</span></p>
      </section>
      <section class="card">
        <div class="step">Chuyển khoản ngân hàng</div>
        ${appsHtml}
        <div class="qr-box"><img id="bankImg" src="${img}" alt="Mã VietQR chuyển khoản ${esc(P.vnd(p.amount))}, nội dung ${esc(p.memo)}" width="300" data-qr="${esc(P.paymentQR(p))}"></div>
        <div class="btn-row" style="justify-content:center"><a class="btn sm" href="${img}" download="${esc(file)}">⬇ Lưu ảnh QR</a></div>
        <p class="qr-meta small">Hoặc nhấn giữ vào ảnh để lưu.</p>
        ${P.payInfoHtml(p)}
        <button class="btn primary big block" id="reportBtn" type="button" style="margin-top:14px">Tôi đã chuyển khoản</button>
        <p class="small muted">Giữ nguyên nội dung <b>${esc(p.memo)}</b> để chủ phòng đối soát.</p>
      </section>`, key);

    P.$$('[data-app]').forEach((a) => a.addEventListener('click', () => P.store.set('paydemo.bankApp', a.dataset.app)));
    P.$('#reportBtn').addEventListener('click', report);
  }

  function reportedView(r) {
    const key = 'reported:' + r.session.id;
    if (renderedKey === key) return;
    setView(`
      <section class="card result info">
        <div class="result-icon">⏳</div>
        <h2>Đã ghi nhận chuyển khoản</h2>
        <p>Phòng tiếp tục được giữ cho bạn trong lúc chủ phòng kiểm tra tài khoản. Trang này sẽ tự cập nhật khi được xác nhận.</p>
      </section>
      <section class="card">${P.payInfoHtml(r.payment)}</section>`, key);
  }

  // ❌ Người quét sau
  function lostView(r) {
    const s = r.session;
    const rm = r.room || {};
    const sold = s.reason === 'SOLD';
    const late = rm.held_since && s.decided_at ? s.decided_at - rm.held_since : null;
    setView(`
      <section class="card result bad">
        <div class="result-icon">✕</div>
        <h1>Giao dịch không thể tiếp tục</h1>
        <p>${sold ? 'Phòng này đã được bán cho khách hàng khác.'
          : `Một khách hàng khác đã quét mã và giữ phòng trước bạn${late != null ? ' <b>' + P.fmtDuration(late) + '</b>' : ''}.`}</p>
        <div class="banner bad" style="text-align:left;margin-top:12px">Mã QR này đã bị vô hiệu hoá. Hệ thống không cấp thông tin chuyển khoản cho bạn — bạn không bị trừ tiền.</div>
        <p class="fine">Bạn quét lúc ${P.fmtClock(s.first_scan_at)}${rm.held_since ? ' · Phòng được giữ lúc ' + P.fmtClock(rm.held_since) : ''} · Số lần quét: ${s.scan_count}</p>
        <a class="btn" href="index.html" style="margin-top:8px">Về trang đặt phòng</a>
      </section>`, 'lost:' + s.id);
  }

  function expiredView(r) {
    const hold = r.reason === 'HOLD_TIMEOUT';
    result('warn', '⌛', hold ? 'Hết thời gian giữ phòng' : 'Mã QR đã hết hạn',
      hold ? 'Bạn chưa hoàn tất chuyển khoản trong thời gian giữ phòng nên phòng đã được mở lại cho khách khác.'
        : 'Mã giữ chỗ chỉ có hiệu lực trong thời gian giới hạn. Vui lòng quay lại trang đặt phòng để tạo mã mới.');
  }

  function result(kind, icon, title, bodyHtml) {
    const key = 'result:' + title;
    if (renderedKey === key) return;
    setView(`
      <section class="card result ${kind}">
        <div class="result-icon">${icon}</div>
        <h1>${esc(title)}</h1>
        <p>${bodyHtml}</p>
        <a class="btn" href="index.html" style="margin-top:12px">Về trang đặt phòng</a>
      </section>`, key);
  }

  async function report() {
    const btn = P.$('#reportBtn');
    btn.disabled = true;
    btn.textContent = 'Đang gửi…';
    try {
      show(await api.reportTransfer(sid));
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Tôi đã chuyển khoản';
      P.toast(e.message);
    }
  }

  start();
})();
