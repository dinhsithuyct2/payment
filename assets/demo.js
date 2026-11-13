/* Mô phỏng 2 khách hàng bấm "Thanh toán" gần như cùng lúc */
(() => {
  'use strict';
  const P = window.PayDemo;
  const frameA = P.$('#frameA');
  const frameB = P.$('#frameB');
  const badge = P.$('#roomBadge');
  const log = P.$('#clickLog');
  const bothBtn = P.$('#bothBtn');
  const resetBtn = P.$('#resetBtn');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ctl = (f) => f.contentWindow && f.contentWindow.Checkout;

  const ROOM_TEXT = { available: 'Còn 1 phòng', held: 'Đang được giữ', sold: 'Đã bán' };

  if (!P.isConfigured()) {
    bothBtn.disabled = true;
    badge.textContent = 'Chưa cấu hình backend';
    return;
  }

  P.poll(async () => {
    const r = await P.api.getRoom();
    if (!r.ok) return;
    badge.className = 'badge st-' + r.room.status;
    badge.textContent = ROOM_TEXT[r.room.status] || r.room.status;
  }, 1000);

  bothBtn.addEventListener('click', async () => {
    const A = ctl(frameA);
    const B = ctl(frameB);
    if (!A || !B) { P.toast('Khung khách hàng chưa tải xong, thử lại sau giây lát'); return; }
    const gap = Math.min(999, Math.max(0, Number(P.$('#gap').value) || 0));
    bothBtn.disabled = true;
    log.textContent = 'Đang bấm…';
    const t0 = performance.now();
    const ra = A.pay().then((r) => ({ r, t: performance.now() - t0 }), (e) => ({ e }));
    await sleep(gap);
    const tb = performance.now() - t0;
    const rb = B.pay().then((r) => ({ r, t: performance.now() - t0 }), (e) => ({ e }));
    const [a, b] = await Promise.all([ra, rb]);
    bothBtn.disabled = false;
    const desc = (x) => (x.e ? 'lỗi: ' + x.e.message : x.r && x.r.ok ? 'đã nhận QR' : 'không nhận được QR (' + (x.r && x.r.code) + ')');
    log.innerHTML = `Khách A bấm lúc <b>+0 ms</b> → ${P.esc(desc(a))}. Khách B bấm lúc <b>+${Math.round(tb)} ms</b> → ${P.esc(desc(b))}.`
      + (a.r && a.r.ok && b.r && b.r.ok ? ' <b>Giờ hãy dùng 2 điện thoại quét 2 mã.</b>' : '');
  });

  // Nút Reset chỉ hiện khi trình duyệt này đã đăng nhập trang Quản trị
  const code = P.store.get('paydemo.adminCode');
  if (code) {
    resetBtn.hidden = false;
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      try {
        await P.api.adminReset(code);
        [frameA, frameB].forEach((f) => { const c = ctl(f); if (c) c.reset(); });
        log.textContent = 'Đã reset: phòng trở về trạng thái “Còn 1 phòng”.';
      } catch (e) {
        P.toast(e.message);
      } finally {
        resetBtn.disabled = false;
      }
    });
  }
})();
