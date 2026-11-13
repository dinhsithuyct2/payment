/* Trang khách hàng: đặt phòng → nhận QR giữ chỗ → (thắng) QR chuyển khoản / (thua) bị từ chối */
(() => {
  'use strict';
  const P = window.PayDemo;
  const { api, esc, vnd } = P;
  const app = document.getElementById('app');
  const embedded = P.qs('embed') === '1';
  const KEY = 'paydemo.session.' + (P.qs('slot') || 'main');

  let room = null;          // trạng thái phòng mới nhất
  let current = null;       // dữ liệu phiên mới nhất
  let stopPoll = null;
  let renderedKey = '';     // tránh vẽ lại khi trạng thái không đổi

  const stop = () => { if (stopPoll) { stopPoll(); stopPoll = null; } };
  const setView = (html, key) => { app.innerHTML = html; renderedKey = key; };

  function availBadge(r) {
    if (!r) return '<span class="badge">Đang tải…</span>';
    if (r.status === 'available') return '<span class="badge st-available">Còn 1 phòng</span>';
    if (r.status === 'held') return '<span class="badge st-held">Đang có khách thanh toán</span>';
    return '<span class="badge st-sold">Hết phòng</span>';
  }

  // ------------------------------------------------------------------
  // Màn 1 — Đặt phòng
  // ------------------------------------------------------------------
  function bookingView(alertHtml = '') {
    stop();
    current = null;
    P.store.sset(KEY, null);
    const name = P.qs('name') || P.store.get('paydemo.name') || '';
    setView(`
      <section class="card room">
        <div class="room-photo" aria-hidden="true"></div>
        <div>
          <div class="eyebrow">Khách sạn Demo · Nha Trang</div>
          <h1 id="roomName">${esc(room ? room.name : 'Phòng Deluxe 101')}</h1>
          <div id="roomAvail">${availBadge(room)}</div>
          <div class="price"><span id="roomPrice">${room ? vnd(room.price) : '…'}</span> <small>/ đêm · giá thử nghiệm</small></div>
        </div>
      </section>
      ${alertHtml}
      <form class="card stack" id="payForm" autocomplete="on">
        <label class="field">Họ tên khách hàng
          <input type="text" id="custName" maxlength="40" required placeholder="VD: Nguyễn Văn A" value="${esc(name)}">
        </label>
        <button class="btn primary big block" id="payBtn" type="submit">Thanh toán</button>
        <p class="muted small">Bấm “Thanh toán” để nhận <b>mã QR giữ chỗ</b>. Khách quét mã <b>đầu tiên</b> sẽ được chuyển đến bước chuyển khoản ngân hàng; người quét sau sẽ bị từ chối.</p>
      </form>`, 'booking');
    P.$('#payForm').addEventListener('submit', (e) => { e.preventDefault(); pay(); });
    stopPoll = P.poll(refreshRoom, 2000);
  }

  async function refreshRoom() {
    const r = await api.getRoom();
    if (!r.ok) return;
    room = r.room;
    const a = P.$('#roomAvail'); if (a) a.innerHTML = availBadge(room);
    const p = P.$('#roomPrice'); if (p) p.textContent = vnd(room.price);
    const n = P.$('#roomName'); if (n) n.textContent = room.name;
  }

  async function pay() {
    const btn = P.$('#payBtn');
    const input = P.$('#custName');
    const name = ((input && input.value) || P.qs('name') || '').trim() || 'Khách';
    if (!embedded) P.store.set('paydemo.name', name);
    if (btn) { btn.disabled = true; btn.textContent = 'Đang tạo mã…'; }
    try {
      const r = await api.createSession(name);
      if (!r.ok) {
        if (r.room) room = r.room;
        const msg = r.code === 'SOLD' ? 'Rất tiếc, phòng đã được bán.'
          : r.code === 'HELD' ? 'Phòng đang được một khách khác thanh toán. Vui lòng thử lại sau ít phút.'
          : 'Không tạo được mã thanh toán (' + r.code + ').';
        bookingView(`<div class="banner warn">⚠️ ${esc(msg)}</div>`);
        return r;
      }
      P.store.sset(KEY, r.session.id);
      show(r);
      watch(r.session.id, true);
      return r;
    } catch (e) {
      bookingView(`<div class="banner bad">⚠️ ${esc(e.message)}</div>`);
      throw e;
    }
  }

  function watch(id, delayFirst) {
    stop();
    stopPoll = P.poll(async () => show(await api.getSession(id)), P.CFG.pollMs, {
      delayFirst,
      onError: () => { const t = P.$('#liveText'); if (t) t.textContent = 'Mất kết nối máy chủ — đang thử lại…'; },
    });
  }

  // ------------------------------------------------------------------
  // Hiển thị theo trạng thái phiên
  // ------------------------------------------------------------------
  function show(r) {
    current = r;
    if (r.room) room = r.room;
    switch (r.code) {
      case 'ISSUED': return awaitingView(r);
      case 'WON': return wonView(r);
      case 'REPORTED': return reportedView(r);
      case 'LOST': stop(); return lostView(r);
      case 'EXPIRED': stop(); return expiredView(r);
      case 'PAID': stop(); return paidView(r);
      case 'CANCELLED': stop(); return simpleResult('warn', '!', 'Chủ phòng đã huỷ giữ chỗ', 'Giao dịch của bạn đã bị huỷ. Bạn có thể đặt lại nếu phòng còn trống.');
      default: stop(); return simpleResult('warn', '?', 'Phiên thanh toán không còn tồn tại', 'Có thể demo vừa được reset trên trang quản trị.');
    }
  }

  // Bước 1 — chờ quét QR giữ chỗ
  function awaitingView(r) {
    const s = r.session;
    const key = 'issued:' + s.id;
    if (renderedKey !== key) {
      const url = P.payUrl(s.id);
      setView(`
        <section class="card">
          <div class="step">Bước 1/2 · Quét mã để giữ phòng</div>
          <h2>Quét mã QR bằng điện thoại</h2>
          <div class="qr-box" id="gateBox"><span class="qr-tag">MÃ GIỮ CHỖ</span><canvas id="gateQr" role="img" aria-label="Mã QR giữ chỗ" data-pay-url="${esc(url)}"></canvas></div>
          <p class="qr-meta">Mã hết hạn sau <span class="countdown" data-until="${s.qr_expires_at}">--:--</span></p>
          <ol class="howto">
            <li>Mở <b>Camera</b> điện thoại hoặc <b>Zalo → Quét mã QR</b> rồi quét mã trên <span class="muted">(không dùng app ngân hàng ở bước này)</span>.</li>
            <li>Nếu bạn là người quét <b>đầu tiên</b>, điện thoại chuyển sang bước chuyển khoản ngân hàng.</li>
            <li>Người quét sau bị từ chối, mã của họ bị vô hiệu hoá.</li>
          </ol>
          <div class="live" id="live"><span class="pulse"></span><span id="liveText">Đang chờ bạn quét mã…</span></div>
          <p class="small muted" style="margin:12px 0 0">Đang đặt phòng trên chính điện thoại này? <a href="${esc(url)}" target="_blank" rel="noopener" id="payLink">Chạm vào đây</a> thay cho việc quét mã.</p>
        </section>
        <section class="card notice small">
          <b>Vì sao chưa phải mã chuyển khoản?</b> Mã VietQR của ngân hàng là mã tĩnh: ai có mã cũng chuyển được tiền và hệ thống không biết ai đã quét.
          Mã giữ chỗ đưa khách về hệ thống trước — tại đó một <b>khoá nguyên tử</b> trong cơ sở dữ liệu đảm bảo chỉ <b>1 người</b> nhận được thông tin chuyển khoản.
        </section>
        <div class="btn-row"><button class="btn" id="cancelBtn" type="button">← Quay lại</button></div>
        <p class="muted small mono">Khách: ${esc(s.customer)} · Mã phiên: ${esc(s.id)}</p>`, key);
      P.drawQR(P.$('#gateQr'), url, { size: 232 });
      P.$('#cancelBtn').addEventListener('click', () => bookingView());
    }
    // Mã vẫn được hiển thị rõ để có thể quét thử — máy chủ sẽ từ chối nếu phòng đã có người giữ.
    const live = P.$('#live');
    const text = P.$('#liveText');
    if (r.room.status === 'held') {
      live.classList.add('warn');
      text.textContent = 'Một khách khác vừa quét mã và đang giữ phòng. Nếu bạn quét mã này bây giờ, giao dịch sẽ bị từ chối.';
    } else if (r.room.status === 'sold') {
      live.classList.add('warn');
      text.textContent = 'Phòng đã được bán. Nếu quét mã này, giao dịch sẽ bị từ chối.';
    } else {
      live.classList.remove('warn');
      text.textContent = 'Đang chờ bạn quét mã… (phòng vẫn còn trống)';
    }
  }

  // Bước 2 — người thắng: QR chuyển khoản thật
  function wonView(r) {
    const s = r.session;
    const p = r.payment;
    const key = 'won:' + s.id;
    if (renderedKey === key) return;
    setView(`
      <div class="banner ok">✅ Bạn là người quét đầu tiên — phòng đang được giữ cho bạn. Hoàn tất chuyển khoản trong <span class="countdown" data-until="${r.room.held_until}">--:--</span></div>
      <section class="card">
        <div class="step">Bước 2/2 · Chuyển khoản ngân hàng</div>
        <h2>Mở app ngân hàng và quét mã VietQR</h2>
        <div class="qr-box"><span class="qr-tag bank">VIETQR · NAPAS 247</span><canvas id="bankQr" role="img" aria-label="Mã VietQR chuyển khoản"></canvas></div>
        <p class="qr-meta">Mã đã có sẵn số tiền và nội dung chuyển khoản riêng của bạn.</p>
        ${P.payInfoHtml(p)}
        <button class="btn primary big block" id="reportBtn" type="button" style="margin-top:14px">Tôi đã chuyển khoản</button>
        <p class="muted small">Vui lòng giữ nguyên nội dung <b>${esc(p.memo)}</b> để chủ phòng đối soát.</p>
      </section>`, key);
    P.drawQR(P.$('#bankQr'), P.paymentQR(p), { size: 232 });
    P.$('#reportBtn').addEventListener('click', report);
  }

  function reportedView(r) {
    const key = 'reported:' + r.session.id;
    if (renderedKey === key) return;
    setView(`
      <section class="card result info">
        <div class="result-icon">⏳</div>
        <h2>Đã ghi nhận chuyển khoản</h2>
        <p>Phòng tiếp tục được giữ cho bạn trong lúc chủ phòng kiểm tra tài khoản. Trang sẽ tự cập nhật khi được xác nhận.</p>
      </section>
      <section class="card">${P.payInfoHtml(r.payment)}</section>`, key);
  }

  function lostView(r) {
    const s = r.session;
    const rm = r.room || {};
    const sold = s.reason === 'SOLD';
    const late = rm.held_since && s.decided_at ? s.decided_at - rm.held_since : null;
    setView(`
      <section class="card result bad">
        <div class="result-icon">✕</div>
        <h2>${sold ? 'Phòng đã được bán' : 'Rất tiếc, đã có khách nhanh hơn bạn'}</h2>
        <p>${sold ? 'Phòng này đã được một khách hàng khác thanh toán.'
          : `Một khách hàng khác đã quét mã và giữ phòng trước bạn${late != null ? ' <b>' + P.fmtDuration(late) + '</b>' : ''}.`}</p>
        <div class="banner bad" style="text-align:left;margin-top:12px">Mã QR của bạn đã bị vô hiệu hoá — hệ thống không cấp thông tin chuyển khoản, giao dịch không thể tiếp tục.</div>
        <p class="fine">Bạn quét lúc ${P.fmtClock(s.first_scan_at)}${rm.held_since ? ' · Phòng được giữ lúc ' + P.fmtClock(rm.held_since) : ''}</p>
        <button class="btn" id="backBtn" type="button" style="margin-top:8px">Quay lại trang phòng</button>
      </section>`, 'lost:' + s.id);
    P.$('#backBtn').addEventListener('click', () => bookingView());
  }

  function expiredView(r) {
    const hold = r.reason === 'HOLD_TIMEOUT';
    simpleResult('warn', '⌛',
      hold ? 'Hết thời gian giữ phòng' : 'Mã QR đã hết hạn',
      hold ? 'Bạn chưa hoàn tất chuyển khoản trong thời gian giữ phòng nên phòng đã được mở lại cho khách khác.'
        : 'Mã giữ chỗ chỉ có hiệu lực trong thời gian giới hạn. Vui lòng tạo mã mới.',
      'expired:' + r.session.id);
  }

  function paidView(r) {
    simpleResult('ok', '✓', 'Thanh toán thành công 🎉',
      `Chủ phòng đã xác nhận khoản chuyển của bạn. <b>${esc(r.room.name)}</b> đã được đặt cho ${esc(r.session.customer)}.`,
      'paid:' + r.session.id);
  }

  function simpleResult(kind, icon, title, bodyHtml, key = 'result:' + title) {
    if (renderedKey === key) return;
    setView(`
      <section class="card result ${kind}">
        <div class="result-icon">${icon}</div>
        <h2>${esc(title)}</h2>
        <p>${bodyHtml}</p>
        <button class="btn" id="backBtn" type="button" style="margin-top:12px">Quay lại trang phòng</button>
      </section>`, key);
    P.$('#backBtn').addEventListener('click', () => bookingView());
  }

  async function report() {
    const btn = P.$('#reportBtn');
    btn.disabled = true;
    btn.textContent = 'Đang gửi…';
    try {
      show(await api.reportTransfer(current.session.id));
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Tôi đã chuyển khoản';
      P.toast(e.message);
    }
  }

  // ------------------------------------------------------------------
  // Khởi động
  // ------------------------------------------------------------------
  // Dùng cho demo.html: điều khiển khung khách hàng từ trang cha
  window.Checkout = {
    pay: () => { if (renderedKey !== 'booking') bookingView(); return pay(); },
    reset: () => bookingView(),
    state: () => current,
  };

  if (!P.isConfigured()) {
    app.innerHTML = P.notConfiguredHtml();
    return;
  }
  const saved = P.store.sget(KEY);
  if (saved) watch(saved, false); else bookingView();
})();
