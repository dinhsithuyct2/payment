/* =====================================================================
 *  Thư viện dùng chung — Demo "Phòng cuối cùng: chỉ 1 khách được chuyển khoản"
 *  - Gọi API backend (Supabase RPC qua REST)
 *  - Đồng bộ đồng hồ với máy chủ (cho đếm ngược chính xác)
 *  - Sinh payload VietQR (chuẩn EMVCo/NAPAS) + CRC16, deeplink app ngân hàng
 *  - Vẽ mã QR, định dạng tiền/giờ, tiện ích giao diện
 * ===================================================================== */
(() => {
  'use strict';

  const CFG = Object.assign(
    { supabaseUrl: '', supabaseKey: '', roomId: 'P101', pollMs: 1000 },
    window.PAYDEMO_CONFIG || {}
  );

  // ------------------------------------------------------------------
  // Backend
  // ------------------------------------------------------------------
  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }

  const isConfigured = () => Boolean(CFG.supabaseUrl && CFG.supabaseKey);

  let clockOffset = 0; // serverTime ≈ Date.now() + clockOffset
  const serverNow = () => Date.now() + clockOffset;

  async function rpc(fn, args) {
    if (!isConfigured()) {
      throw new ApiError('NOT_CONFIGURED', 'Chưa cấu hình Supabase trong config.js');
    }
    const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
    // Khoá anon kiểu cũ là JWT → gửi kèm Authorization. Khoá sb_publishable_ chỉ cần apikey.
    if (CFG.supabaseKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + CFG.supabaseKey;
    const url = CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(args || {}), cache: 'no-store' });
    } catch (e) {
      throw new ApiError('NETWORK', 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    }
    const rtt = performance.now() - t0;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || data.error)) || text || res.statusText;
      throw new ApiError((data && data.code) || 'HTTP_' + res.status, msg, res.status);
    }
    if (data && typeof data.server_now === 'number') {
      clockOffset = data.server_now + rtt / 2 - Date.now();
    }
    if (data && typeof data === 'object') data.rtt_ms = Math.round(rtt);
    return data;
  }

  const api = {
    getRoom: () => rpc('paydemo_get_room', { p_room_id: CFG.roomId }),
    createSession: (customer) => rpc('paydemo_create_session', { p_room_id: CFG.roomId, p_customer: customer }),
    getSession: (id) => rpc('paydemo_get_session', { p_session_id: id }),
    claim: (id) => rpc('paydemo_claim', { p_session_id: id, p_user_agent: navigator.userAgent }),
    reportTransfer: (id) => rpc('paydemo_report_transfer', { p_session_id: id }),
    adminState: (code) => rpc('paydemo_admin_state', { p_code: code, p_room_id: CFG.roomId }),
    adminConfirmPaid: (code, id) => rpc('paydemo_admin_confirm_paid', { p_code: code, p_session_id: id }),
    adminRelease: (code) => rpc('paydemo_admin_release', { p_code: code, p_room_id: CFG.roomId }),
    adminReset: (code) => rpc('paydemo_admin_reset', { p_code: code, p_room_id: CFG.roomId }),
    adminUpdate: (code, s) => rpc('paydemo_admin_update', {
      p_code: code, p_room_id: CFG.roomId,
      p_price: s.price ?? null, p_hold_seconds: s.hold ?? null, p_qr_ttl_seconds: s.ttl ?? null,
    }),
  };

  // ------------------------------------------------------------------
  // VietQR (EMVCo Merchant-Presented QR theo chuẩn NAPAS)
  // ------------------------------------------------------------------
  const tlv = (id, value) => {
    const v = String(value);
    return id + String(v.length).padStart(2, '0') + v;
  };

  function crc16(str) { // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  const toAscii = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D');

  // Nội dung CK: chỉ chữ/số/khoảng trắng, tối đa 25 ký tự (giới hạn trường 62-08)
  const cleanMemo = (s) => toAscii(s).replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 25);

  function buildVietQR({ bin, account, service = 'QRIBFTTA', amount, memo }) {
    const beneficiary = tlv('00', bin) + tlv('01', account);
    const merchant = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', service);
    let p = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
    if (amount) p += tlv('54', String(Math.round(amount)));
    p += tlv('58', 'VN');
    const m = memo ? cleanMemo(memo) : '';
    if (m) p += tlv('62', tlv('08', m));
    p += '6304';
    return p + crc16(p);
  }

  const paymentQR = (pay) => buildVietQR({
    bin: pay.bank_bin, account: pay.account_no, service: pay.service_code,
    amount: pay.amount, memo: pay.memo,
  });

  // Deeplink mở app ngân hàng (dịch vụ dl.vietqr.io)
  function bankDeeplink(appId, pay, returnUrl) {
    const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
    const parts = [
      'app=' + enc(appId),
      'am=' + enc(String(pay.amount)),
      'tn=' + enc(cleanMemo(pay.memo)),
      'ba=' + enc(pay.account_no) + '@' + enc(String(pay.bank_code).toLowerCase()),
      'bn=' + enc(toAscii(pay.account_name).toUpperCase()),
    ];
    if (returnUrl) parts.push('url=' + encodeURIComponent(returnUrl));
    return 'https://dl.vietqr.io/pay?' + parts.join('&');
  }

  function platform() {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'desktop';
  }

  // ------------------------------------------------------------------
  // Vẽ QR (thư viện qrcode-generator, MIT)
  // ------------------------------------------------------------------
  function drawQR(canvas, text, opts = {}) {
    const { size = 240, ecc = 'M', margin = 3, dark = '#0f172a', light = '#ffffff' } = opts;
    const qr = window.qrcode(0, ecc);
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const total = n + margin * 2;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const px = Math.max(1, Math.floor((size * dpr) / total));
    const dim = px * total;
    canvas.width = dim;
    canvas.height = dim;
    canvas.style.width = canvas.style.height = dim / dpr + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = dark;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + margin) * px, (r + margin) * px, px, px);
    }
    canvas.dataset.qr = text;
    return canvas;
  }

  // Ảnh QR chuyển khoản kèm chú thích — để khách "Lưu ảnh" rồi quét từ thư viện
  function paymentImageDataUrl(pay) {
    const qrCanvas = document.createElement('canvas');
    drawQR(qrCanvas, paymentQR(pay), { size: 520, margin: 2 });
    const W = 640, H = 860;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#0f766e'; g.fillRect(0, 0, W, 76);
    g.fillStyle = '#ffffff'; g.font = '700 30px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText('VietQR · NAPAS 247', W / 2, 49);
    g.drawImage(qrCanvas, (W - 520) / 2, 100, 520, 520);
    g.fillStyle = '#0f172a'; g.font = '700 34px system-ui, sans-serif';
    g.fillText(vnd(pay.amount), W / 2, 680);
    g.font = '500 26px system-ui, sans-serif'; g.fillStyle = '#334155';
    g.fillText(`${pay.bank_name} · ${pay.account_no}`, W / 2, 728);
    g.fillText(pay.account_name, W / 2, 766);
    g.font = '700 26px ui-monospace, monospace'; g.fillStyle = '#0f766e';
    g.fillText('ND: ' + pay.memo, W / 2, 812);
    return c.toDataURL('image/png');
  }

  // ------------------------------------------------------------------
  // Định dạng
  // ------------------------------------------------------------------
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const vnd = (n) => new Intl.NumberFormat('vi-VN').format(Number(n) || 0) + ' ₫';
  const fmtClock = (ms) => {
    if (ms == null) return '—';
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  };
  const fmtCountdown = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };
  const fmtDuration = (ms) => {
    if (ms == null || isNaN(ms)) return '';
    ms = Math.abs(Number(ms));
    if (ms < 1000) return `${ms < 10 ? ms.toFixed(1).replace('.', ',') : Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1).replace('.', ',')} giây`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m} phút ${s} giây`;
  };

  // ------------------------------------------------------------------
  // DOM & tiện ích
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = (k) => new URLSearchParams(location.search).get(k);
  const siteBase = () => new URL('.', location.href).href;
  const payUrl = (id) => new URL('pay.html?s=' + encodeURIComponent(id), siteBase()).href;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) { /* bỏ qua */ } },
    sget(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    sset(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (_) { /* bỏ qua */ } },
  };

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // Nút sao chép: <button data-copy="giá trị">
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    e.preventDefault();
    const ok = await copyText(b.getAttribute('data-copy'));
    toast(ok ? 'Đã sao chép: ' + b.getAttribute('data-copy') : 'Không sao chép được — hãy chép thủ công');
  });

  // Đồng hồ đếm ngược: <span data-until="epochMs">  (theo giờ máy chủ)
  setInterval(() => {
    const now = serverNow();
    $$('[data-until]').forEach((el) => {
      const until = Number(el.getAttribute('data-until'));
      if (!until) { el.textContent = '--:--'; return; }
      const left = until - now;
      el.textContent = fmtCountdown(left);
      el.classList.toggle('urgent', left < 60000);
    });
  }, 250);

  // Vòng lặp hỏi trạng thái định kỳ (không chồng lệnh). onError nhận lỗi mạng.
  function poll(fn, ms, { delayFirst = false, onError } = {}) {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      if (stopped) return;
      try { await fn(); } catch (e) { console.warn('[poll]', e); if (onError) onError(e); }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    if (delayFirst) timer = setTimeout(tick, ms); else tick();
    return () => { stopped = true; clearTimeout(timer); };
  }

  // Bảng thông tin chuyển khoản (chỉ hiển thị cho khách đang giữ phòng)
  function payInfoHtml(p) {
    const copyBtn = (v) => `<button class="icon-btn" type="button" data-copy="${esc(v)}">Sao chép</button>`;
    return `<dl class="kv">
      <dt>Ngân hàng</dt><dd><span>${esc(p.bank_name)}</span></dd>
      <dt>Số tài khoản</dt><dd><span class="hl">${esc(p.account_no)}</span>${copyBtn(p.account_no)}</dd>
      <dt>Chủ tài khoản</dt><dd><span>${esc(p.account_name)}</span></dd>
      <dt>Số tiền</dt><dd><span>${vnd(p.amount)}</span>${copyBtn(String(p.amount))}</dd>
      <dt>Nội dung</dt><dd><span class="hl">${esc(p.memo)}</span>${copyBtn(p.memo)}</dd>
    </dl>`;
  }

  function notConfiguredHtml() {
    return `<div class="card notice warn">
      <h2>Chưa kết nối backend</h2>
      <p>Trang web cần một cơ sở dữ liệu dùng chung (Supabase, miễn phí) để khoá phòng một cách nguyên tử giữa các điện thoại.</p>
      <ol>
        <li>Tạo project tại <a href="https://supabase.com/dashboard" target="_blank" rel="noopener">supabase.com</a>.</li>
        <li>Mở <b>SQL Editor</b>, dán toàn bộ file <code>supabase/setup.sql</code> rồi bấm <b>Run</b>.</li>
        <li>Điền <b>Project URL</b> và <b>Publishable key</b> vào <code>config.js</code>.</li>
      </ol>
      <p class="muted">Xem chi tiết trong README.md của repo.</p>
    </div>`;
  }

  window.PayDemo = {
    CFG, ApiError, api, rpc, isConfigured, serverNow,
    tlv, crc16, toAscii, cleanMemo, buildVietQR, paymentQR, bankDeeplink, platform,
    drawQR, paymentImageDataUrl,
    vnd, fmtClock, fmtCountdown, fmtDuration,
    $, $$, esc, qs, siteBase, payUrl, store, copyText, toast, poll, payInfoHtml, notConfiguredHtml,
  };
})();
