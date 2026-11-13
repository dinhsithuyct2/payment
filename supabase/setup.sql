-- =====================================================================
--  DEMO "PHÒNG CUỐI CÙNG" — CHỈ 1 KHÁCH ĐƯỢC CHUYỂN KHOẢN
-- ---------------------------------------------------------------------
--  Cách chạy: Supabase Dashboard → SQL Editor → New query
--             → dán TOÀN BỘ file này → Run.
--  Dòng kết quả cuối cùng là MÃ QUẢN TRỊ (dùng để đăng nhập admin.html).
--  Chạy lại nhiều lần vẫn an toàn: không xoá dữ liệu, giữ nguyên mã quản trị.
--
--  Nguyên tắc thiết kế
--   • Bảng nằm trong schema riêng "paydemo" → KHÔNG lộ qua REST API.
--   • Trình duyệt chỉ gọi được các hàm public.paydemo_* (SECURITY DEFINER).
--   • Mọi thao tác trên 1 phòng phải xếp hàng qua khoá dòng
--         SELECT ... FROM paydemo.rooms WHERE id = ... FOR UPDATE
--     ⇒ 2 lượt quét đến gần như cùng lúc (kể cả lệch nhau 1 ms) vẫn chỉ
--       có ĐÚNG 1 người thắng; người đến sau thấy phòng đã "held".
--   • Thông tin chuyển khoản (STK, số tiền, nội dung) chỉ được trả về cho
--     phiên đang giữ phòng. Người thua không bao giờ nhận được.
-- =====================================================================

create schema if not exists paydemo;
revoke all on schema paydemo from public;

-- ---------------------------------------------------------------------
-- 1. BẢNG DỮ LIỆU
-- ---------------------------------------------------------------------
create table if not exists paydemo.settings (
  id               int  primary key default 1 check (id = 1),
  bank_bin         text not null,            -- BIN ngân hàng nhận (NAPAS)
  bank_code        text not null,            -- mã ngắn, dùng cho deeplink VietQR
  bank_name        text not null,
  account_no       text not null,
  account_name     text not null,
  service_code     text not null default 'QRIBFTTA',   -- chuyển đến số tài khoản
  hold_seconds     int  not null default 300 check (hold_seconds between 10 and 3600),
  qr_ttl_seconds   int  not null default 600 check (qr_ttl_seconds between 30 and 86400),
  admin_code_salt  text,
  admin_code_hash  text
);

create table if not exists paydemo.rooms (
  id          text primary key,
  name        text not null,
  price       bigint not null check (price between 1000 and 1000000000),
  status      text not null default 'available' check (status in ('available', 'held', 'sold')),
  held_by     text,           -- id phiên đang giữ phòng
  held_since  timestamptz,
  held_until  timestamptz,    -- null khi khách đã báo chuyển khoản (chờ chủ phòng xác nhận)
  sold_to     text,
  sold_at     timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists paydemo.payment_sessions (
  id               text primary key,          -- bí mật, nằm trong URL của QR giữ chỗ
  room_id          text not null references paydemo.rooms (id) on delete cascade,
  customer         text not null,
  amount           bigint not null,
  memo             text not null unique,      -- nội dung chuyển khoản duy nhất cho từng phiên
  status           text not null default 'issued'
                   check (status in ('issued', 'won', 'lost', 'expired', 'reported', 'paid', 'cancelled')),
  reason           text,
  created_at       timestamptz not null,
  qr_expires_at    timestamptz not null,
  first_scan_at    timestamptz,
  scan_count       int not null default 0,
  decided_at       timestamptz,
  hold_until       timestamptz,
  reported_at      timestamptz,
  paid_at          timestamptz,
  scan_user_agent  text
);
create index if not exists payment_sessions_room_created_idx
  on paydemo.payment_sessions (room_id, created_at desc);

create table if not exists paydemo.events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default clock_timestamp(),
  room_id     text,
  session_id  text,
  type        text not null,
  detail      jsonb
);
create index if not exists events_room_at_idx on paydemo.events (room_id, at desc);

alter table paydemo.settings          enable row level security;
alter table paydemo.rooms             enable row level security;
alter table paydemo.payment_sessions  enable row level security;
alter table paydemo.events            enable row level security;
revoke all on all tables in schema paydemo from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. DỮ LIỆU KHỞI TẠO — sửa ở đây nếu muốn đổi tài khoản nhận / phòng
--    (Giá phòng, thời gian giữ phòng có thể đổi ngay trên admin.html)
-- ---------------------------------------------------------------------
insert into paydemo.settings (id, bank_bin, bank_code, bank_name, account_no, account_name)
values (1, '546034', 'CAKE', 'CAKE by VPBank', '0971467046', 'ĐINH SĨ THỦY')
on conflict (id) do update
  set bank_bin     = excluded.bank_bin,
      bank_code    = excluded.bank_code,
      bank_name    = excluded.bank_name,
      account_no   = excluded.account_no,
      account_name = excluded.account_name;

insert into paydemo.rooms (id, name, price)
values ('P101', 'Phòng Deluxe 101 · Hướng biển', 10000)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3. HÀM NỘI BỘ (schema paydemo — trình duyệt không gọi được)
-- ---------------------------------------------------------------------
create or replace function paydemo._ms(ts timestamptz)
returns bigint language sql immutable set search_path = '' as $$
  select (extract(epoch from ts) * 1000)::bigint
$$;

create or replace function paydemo._diff_ms(a timestamptz, b timestamptz)
returns numeric language sql immutable set search_path = '' as $$
  select round((extract(epoch from (a - b)) * 1000)::numeric, 3)
$$;

-- Mã ngẫu nhiên, bỏ các ký tự dễ nhầm (0/O, 1/I)
create or replace function paydemo._rand_code(n int)
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 ký tự
  b     bytea;
  v_out text := '';
begin
  if n < 1 or n > 32 then
    raise exception 'n phải trong khoảng 1..32';
  end if;
  b := sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'));
  for i in 0 .. n - 1 loop
    v_out := v_out || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return v_out;
end $$;

create or replace function paydemo._room_json(r paydemo.rooms, p_session_id text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id',         r.id,
    'name',       r.name,
    'price',      r.price,
    'status',     r.status,
    'held_since', paydemo._ms(r.held_since),
    'held_until', paydemo._ms(r.held_until),
    'held_by_me', coalesce(p_session_id is not null and r.held_by = p_session_id, false),
    'sold_at',    paydemo._ms(r.sold_at),
    'sold_to_me', coalesce(p_session_id is not null and r.sold_to = p_session_id, false)
  )
$$;

-- Ảnh chụp trạng thái 1 phiên. Khối "payment" CHỈ có khi phiên đang giữ phòng.
create or replace function paydemo._session_json(ps paydemo.payment_sessions, r paydemo.rooms, p_now timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'ok',         ps.status in ('issued', 'won', 'reported', 'paid'),
    'code',       upper(ps.status),
    'reason',     ps.reason,
    'server_now', paydemo._ms(p_now),
    'session', jsonb_build_object(
      'id',            ps.id,
      'customer',      ps.customer,
      'amount',        ps.amount,
      'status',        ps.status,
      'reason',        ps.reason,
      'created_at',    paydemo._ms(ps.created_at),
      'qr_expires_at', paydemo._ms(ps.qr_expires_at),
      'first_scan_at', paydemo._ms(ps.first_scan_at),
      'scan_count',    ps.scan_count,
      'decided_at',    paydemo._ms(ps.decided_at),
      'hold_until',    paydemo._ms(ps.hold_until),
      'reported_at',   paydemo._ms(ps.reported_at),
      'paid_at',       paydemo._ms(ps.paid_at)
    ),
    'room', paydemo._room_json(r, ps.id),
    'payment', case when ps.status in ('won', 'reported') then (
      select jsonb_build_object(
        'bank_bin',     s.bank_bin,
        'bank_code',    s.bank_code,
        'bank_name',    s.bank_name,
        'account_no',   s.account_no,
        'account_name', s.account_name,
        'service_code', s.service_code,
        'amount',       ps.amount,
        'memo',         ps.memo)
      from paydemo.settings s where s.id = 1)
    end
  )
$$;

-- Dọn trạng thái hết hạn. PHẢI gọi khi đang giữ khoá dòng phòng.
create or replace function paydemo._housekeep(p_room_id text, p_now timestamptz)
returns void language plpgsql volatile set search_path = '' as $$
declare
  r paydemo.rooms;
begin
  select * into r from paydemo.rooms where id = p_room_id;

  -- (a) Hết thời gian giữ phòng mà khách thắng chưa chuyển khoản → trả phòng
  if r.status = 'held' and r.held_until is not null and r.held_until <= p_now then
    update paydemo.payment_sessions
       set status = 'expired', reason = 'HOLD_TIMEOUT'
     where id = r.held_by and status = 'won';
    update paydemo.rooms
       set status = 'available', held_by = null, held_since = null, held_until = null, updated_at = p_now
     where id = p_room_id;
    insert into paydemo.events (room_id, session_id, type, detail)
    values (p_room_id, r.held_by, 'HOLD_EXPIRED', jsonb_build_object('held_until', paydemo._ms(r.held_until)));
  end if;

  -- (b) Mã QR giữ chỗ quá hạn mà chưa được quét
  with x as (
    update paydemo.payment_sessions
       set status = 'expired', reason = 'QR_TIMEOUT', decided_at = p_now
     where room_id = p_room_id and status = 'issued' and qr_expires_at <= p_now
    returning id
  )
  insert into paydemo.events (room_id, session_id, type)
  select p_room_id, x.id, 'QR_EXPIRED' from x;
end $$;

create or replace function paydemo._assert_admin(p_code text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not exists (
    select 1 from paydemo.settings s
     where s.id = 1
       and s.admin_code_hash is not null
       and s.admin_code_hash = encode(sha256(convert_to(
             s.admin_code_salt || upper(btrim(coalesce(p_code, ''))), 'UTF8')), 'hex')
  ) then
    raise exception 'Mã quản trị không đúng'
      using errcode = '28000', hint = 'Mã được hiển thị khi chạy supabase/setup.sql';
  end if;
end $$;

-- Tạo mã quản trị (chỉ chạy được trong SQL Editor).
-- Quên mã? Chạy:  select paydemo.init_admin_code(true);
create or replace function paydemo.init_admin_code(p_force boolean default false)
returns text language plpgsql volatile set search_path = '' as $$
declare
  v_code text;
  v_salt text;
begin
  if not p_force and exists (select 1 from paydemo.settings where id = 1 and admin_code_hash is not null) then
    return 'Đã có mã quản trị từ lần chạy trước (giữ nguyên). Quên mã? Chạy: select paydemo.init_admin_code(true);';
  end if;
  v_code := paydemo._rand_code(8);
  v_salt := encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex');
  update paydemo.settings
     set admin_code_salt = v_salt,
         admin_code_hash = encode(sha256(convert_to(v_salt || v_code, 'UTF8')), 'hex')
   where id = 1;
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- 4. API CÔNG KHAI (trình duyệt gọi qua POST /rest/v1/rpc/<tên hàm>)
-- ---------------------------------------------------------------------

-- 4.1 Trạng thái phòng (không lộ thông tin khách)
create or replace function public.paydemo_get_room(p_room_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r     paydemo.rooms;
  s     paydemo.settings;
  v_now timestamptz;
begin
  perform 1 from paydemo.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ROOM_NOT_FOUND');
  end if;
  v_now := clock_timestamp();
  perform paydemo._housekeep(p_room_id, v_now);
  select * into r from paydemo.rooms where id = p_room_id;
  select * into s from paydemo.settings where id = 1;
  return jsonb_build_object(
    'ok', true, 'code', 'ROOM', 'server_now', paydemo._ms(v_now),
    'room', paydemo._room_json(r, null),
    'hold_seconds', s.hold_seconds,
    'qr_ttl_seconds', s.qr_ttl_seconds,
    'bank_name', s.bank_name);
end $$;

-- 4.2 Khách bấm "Thanh toán" → cấp QR GIỮ CHỖ (chưa khoá phòng).
--     Hai khách bấm cùng lúc khi phòng còn trống đều nhận được QR.
create or replace function public.paydemo_create_session(p_room_id text, p_customer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r      paydemo.rooms;
  s      paydemo.settings;
  ps     paydemo.payment_sessions;
  v_now  timestamptz;
  v_name text := left(coalesce(nullif(btrim(p_customer), ''), 'Khách'), 40);
  v_id   text;
  v_memo text;
begin
  perform 1 from paydemo.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ROOM_NOT_FOUND');
  end if;
  v_now := clock_timestamp();
  perform paydemo._housekeep(p_room_id, v_now);
  select * into r from paydemo.rooms where id = p_room_id;
  select * into s from paydemo.settings where id = 1;

  if r.status <> 'available' then
    return jsonb_build_object(
      'ok', false,
      'code', case r.status when 'sold' then 'SOLD' else 'HELD' end,
      'server_now', paydemo._ms(v_now),
      'room', paydemo._room_json(r, null));
  end if;

  v_id := left(encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex'), 20);
  loop
    v_memo := 'DATPHONG ' || paydemo._rand_code(6);
    exit when not exists (select 1 from paydemo.payment_sessions where memo = v_memo);
  end loop;

  insert into paydemo.payment_sessions (id, room_id, customer, amount, memo, created_at, qr_expires_at)
  values (v_id, p_room_id, v_name, r.price, v_memo, v_now, v_now + make_interval(secs => s.qr_ttl_seconds))
  returning * into ps;

  insert into paydemo.events (room_id, session_id, type, detail)
  values (p_room_id, v_id, 'QR_ISSUED', jsonb_build_object('customer', v_name));

  return paydemo._session_json(ps, r, v_now);
end $$;

-- 4.3 ★ QUÉT QR GIỮ CHỖ ★  — trái tim của cơ chế.
--     Ai lấy được khoá dòng phòng trước khi phòng còn trống → THẮNG.
--     Mọi người đến sau → THUA, mã bị vô hiệu hoá vĩnh viễn.
create or replace function public.paydemo_claim(p_session_id text, p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_arrived timestamptz := clock_timestamp();   -- lúc yêu cầu tới DB
  v_now     timestamptz;                        -- lúc được xử lý (sau khi có khoá)
  v_room_id text;
  r         paydemo.rooms;
  s         paydemo.settings;
  ps        paydemo.payment_sessions;
begin
  select room_id into v_room_id from paydemo.payment_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  -- KHOÁ NGUYÊN TỬ: các lượt quét cùng phòng xếp hàng tại đây, từng lượt một.
  perform 1 from paydemo.rooms where id = v_room_id for update;
  v_now := clock_timestamp();
  perform paydemo._housekeep(v_room_id, v_now);

  update paydemo.payment_sessions
     set scan_count      = scan_count + 1,
         first_scan_at   = coalesce(first_scan_at, v_now),
         scan_user_agent = coalesce(scan_user_agent, left(p_user_agent, 300))
   where id = p_session_id
  returning * into ps;
  select * into r from paydemo.rooms where id = v_room_id;
  select * into s from paydemo.settings where id = 1;

  if ps.status = 'issued' then
    if r.status = 'available' then
      -- ✅ NGƯỜI ĐẦU TIÊN: giữ phòng + cấp thông tin chuyển khoản
      update paydemo.rooms
         set status = 'held', held_by = ps.id, held_since = v_now,
             held_until = v_now + make_interval(secs => s.hold_seconds), updated_at = v_now
       where id = v_room_id
      returning * into r;
      update paydemo.payment_sessions
         set status = 'won', reason = null, decided_at = v_now, hold_until = r.held_until
       where id = ps.id
      returning * into ps;
      insert into paydemo.events (room_id, session_id, type, detail)
      values (v_room_id, ps.id, 'WON', jsonb_build_object(
        'customer', ps.customer, 'lock_wait_ms', paydemo._diff_ms(v_now, v_arrived)));
    else
      -- ❌ ĐẾN SAU: phòng đã có người giữ / đã bán → vô hiệu hoá mã này
      update paydemo.payment_sessions
         set status = 'lost',
             reason = case r.status when 'sold' then 'SOLD' else 'HELD_BY_OTHER' end,
             decided_at = v_now
       where id = ps.id
      returning * into ps;
      insert into paydemo.events (room_id, session_id, type, detail)
      values (v_room_id, ps.id, 'LOST', jsonb_build_object(
        'customer', ps.customer, 'reason', ps.reason,
        'late_ms', paydemo._diff_ms(v_now, r.held_since),
        'lock_wait_ms', paydemo._diff_ms(v_now, v_arrived)));
    end if;
  else
    insert into paydemo.events (room_id, session_id, type, detail)
    values (v_room_id, ps.id,
            case when ps.status in ('won', 'reported', 'paid') then 'RESCAN' else 'SCAN_REJECTED' end,
            jsonb_build_object('customer', ps.customer, 'status', ps.status));
  end if;

  return paydemo._session_json(ps, r, v_now) || jsonb_build_object('timing', jsonb_build_object(
    'arrived_at',   paydemo._ms(v_arrived),
    'decided_at',   paydemo._ms(v_now),
    'lock_wait_ms', paydemo._diff_ms(v_now, v_arrived)));
end $$;

-- 4.4 Trang thanh toán hỏi trạng thái phiên (polling)
create or replace function public.paydemo_get_session(p_session_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_room_id text;
  r         paydemo.rooms;
  ps        paydemo.payment_sessions;
  v_now     timestamptz;
begin
  select room_id into v_room_id from paydemo.payment_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from paydemo.rooms where id = v_room_id for update;
  v_now := clock_timestamp();
  perform paydemo._housekeep(v_room_id, v_now);
  select * into r  from paydemo.rooms where id = v_room_id;
  select * into ps from paydemo.payment_sessions where id = p_session_id;
  return paydemo._session_json(ps, r, v_now);
end $$;

-- 4.5 Khách thắng bấm "Tôi đã chuyển khoản" → giữ phòng chờ chủ phòng xác nhận
create or replace function public.paydemo_report_transfer(p_session_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_room_id text;
  r         paydemo.rooms;
  ps        paydemo.payment_sessions;
  v_now     timestamptz;
begin
  select room_id into v_room_id from paydemo.payment_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  perform 1 from paydemo.rooms where id = v_room_id for update;
  v_now := clock_timestamp();
  perform paydemo._housekeep(v_room_id, v_now);
  select * into r  from paydemo.rooms where id = v_room_id;
  select * into ps from paydemo.payment_sessions where id = p_session_id;

  if ps.status = 'won' and r.status = 'held' and r.held_by = ps.id then
    update paydemo.payment_sessions set status = 'reported', reported_at = v_now
     where id = ps.id returning * into ps;
    update paydemo.rooms set held_until = null, updated_at = v_now
     where id = v_room_id returning * into r;
    insert into paydemo.events (room_id, session_id, type, detail)
    values (v_room_id, ps.id, 'TRANSFER_REPORTED', jsonb_build_object('customer', ps.customer, 'memo', ps.memo));
  end if;
  return paydemo._session_json(ps, r, v_now);
end $$;

-- ---------------------------------------------------------------------
-- 5. API QUẢN TRỊ (cần mã quản trị)
-- ---------------------------------------------------------------------
create or replace function public.paydemo_admin_state(p_code text, p_room_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r     paydemo.rooms;
  s     paydemo.settings;
  v_now timestamptz;
begin
  perform paydemo._assert_admin(p_code);
  perform 1 from paydemo.rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ROOM_NOT_FOUND');
  end if;
  v_now := clock_timestamp();
  perform paydemo._housekeep(p_room_id, v_now);
  select * into r from paydemo.rooms where id = p_room_id;
  select * into s from paydemo.settings where id = 1;

  return jsonb_build_object(
    'ok', true, 'code', 'ADMIN', 'server_now', paydemo._ms(v_now),
    'room', paydemo._room_json(r, null) || jsonb_build_object(
      'held_by', r.held_by,
      'sold_to', r.sold_to,
      'holder', (select jsonb_build_object('id', x.id, 'customer', x.customer, 'memo', x.memo,
                                           'status', x.status, 'amount', x.amount)
                   from paydemo.payment_sessions x where x.id = coalesce(r.held_by, r.sold_to))),
    'settings', jsonb_build_object(
      'hold_seconds', s.hold_seconds, 'qr_ttl_seconds', s.qr_ttl_seconds,
      'bank_name', s.bank_name, 'bank_bin', s.bank_bin, 'bank_code', s.bank_code,
      'account_no', s.account_no, 'account_name', s.account_name),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', x.id, 'customer', x.customer, 'amount', x.amount, 'memo', x.memo,
               'status', x.status, 'reason', x.reason,
               'created_at', paydemo._ms(x.created_at), 'qr_expires_at', paydemo._ms(x.qr_expires_at),
               'first_scan_at', paydemo._ms(x.first_scan_at), 'scan_count', x.scan_count,
               'decided_at', paydemo._ms(x.decided_at), 'reported_at', paydemo._ms(x.reported_at),
               'paid_at', paydemo._ms(x.paid_at), 'user_agent', x.scan_user_agent)
             order by x.created_at desc, x.id)
        from (select * from paydemo.payment_sessions
               where room_id = p_room_id order by created_at desc limit 100) x), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'at', paydemo._ms(e.at), 'session_id', e.session_id,
                                          'type', e.type, 'detail', e.detail)
             order by e.at desc, e.id desc)
        from (select * from paydemo.events
               where room_id = p_room_id order by at desc, id desc limit 200) e), '[]'::jsonb)
  );
end $$;

create or replace function public.paydemo_admin_confirm_paid(p_code text, p_session_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_room_id text;
  r         paydemo.rooms;
  ps        paydemo.payment_sessions;
  v_now     timestamptz;
begin
  perform paydemo._assert_admin(p_code);
  select room_id into v_room_id from paydemo.payment_sessions where id = p_session_id;
  if not found then
    raise exception 'Không tìm thấy phiên thanh toán';
  end if;
  perform 1 from paydemo.rooms where id = v_room_id for update;
  v_now := clock_timestamp();
  perform paydemo._housekeep(v_room_id, v_now);
  select * into r  from paydemo.rooms where id = v_room_id;
  select * into ps from paydemo.payment_sessions where id = p_session_id;

  if not (ps.status in ('won', 'reported') and r.status = 'held' and r.held_by = ps.id) then
    raise exception 'Phiên của "%" không còn giữ phòng (trạng thái: %) — không thể xác nhận',
      ps.customer, ps.status;
  end if;

  update paydemo.rooms
     set status = 'sold', sold_to = ps.id, sold_at = v_now, held_by = null, held_until = null, updated_at = v_now
   where id = v_room_id returning * into r;
  update paydemo.payment_sessions set status = 'paid', paid_at = v_now
   where id = ps.id returning * into ps;
  insert into paydemo.events (room_id, session_id, type, detail)
  values (v_room_id, ps.id, 'PAID_CONFIRMED', jsonb_build_object('customer', ps.customer, 'memo', ps.memo));
  return paydemo._session_json(ps, r, v_now);
end $$;

create or replace function public.paydemo_admin_release(p_code text, p_room_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r     paydemo.rooms;
  v_now timestamptz;
begin
  perform paydemo._assert_admin(p_code);
  perform 1 from paydemo.rooms where id = p_room_id for update;
  if not found then
    raise exception 'Không tìm thấy phòng %', p_room_id;
  end if;
  v_now := clock_timestamp();
  perform paydemo._housekeep(p_room_id, v_now);
  select * into r from paydemo.rooms where id = p_room_id;
  if r.status = 'held' then
    update paydemo.payment_sessions
       set status = 'cancelled', reason = 'ADMIN_RELEASE'
     where id = r.held_by and status in ('won', 'reported');
    update paydemo.rooms
       set status = 'available', held_by = null, held_since = null, held_until = null, updated_at = v_now
     where id = p_room_id;
    insert into paydemo.events (room_id, session_id, type) values (p_room_id, r.held_by, 'ADMIN_RELEASE');
  end if;
  return public.paydemo_admin_state(p_code, p_room_id);
end $$;

create or replace function public.paydemo_admin_reset(p_code text, p_room_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform paydemo._assert_admin(p_code);
  perform 1 from paydemo.rooms where id = p_room_id for update;
  if not found then
    raise exception 'Không tìm thấy phòng %', p_room_id;
  end if;
  delete from paydemo.payment_sessions where room_id = p_room_id;
  delete from paydemo.events where room_id = p_room_id;
  update paydemo.rooms
     set status = 'available', held_by = null, held_since = null, held_until = null,
         sold_to = null, sold_at = null, updated_at = clock_timestamp()
   where id = p_room_id;
  insert into paydemo.events (room_id, type) values (p_room_id, 'RESET');
  return public.paydemo_admin_state(p_code, p_room_id);
end $$;

create or replace function public.paydemo_admin_update(
  p_code text, p_room_id text,
  p_price bigint default null, p_hold_seconds int default null, p_qr_ttl_seconds int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform paydemo._assert_admin(p_code);
  if p_price is not null and (p_price < 1000 or p_price > 1000000000) then
    raise exception 'Giá phải từ 1.000 đến 1.000.000.000 ₫';
  end if;
  if p_hold_seconds is not null and (p_hold_seconds < 10 or p_hold_seconds > 3600) then
    raise exception 'Thời gian giữ phòng phải từ 10 đến 3600 giây';
  end if;
  if p_qr_ttl_seconds is not null and (p_qr_ttl_seconds < 30 or p_qr_ttl_seconds > 86400) then
    raise exception 'Hiệu lực mã QR phải từ 30 đến 86400 giây';
  end if;
  perform 1 from paydemo.rooms where id = p_room_id for update;
  if not found then
    raise exception 'Không tìm thấy phòng %', p_room_id;
  end if;
  update paydemo.rooms set price = coalesce(p_price, price), updated_at = clock_timestamp()
   where id = p_room_id;
  update paydemo.settings
     set hold_seconds   = coalesce(p_hold_seconds, hold_seconds),
         qr_ttl_seconds = coalesce(p_qr_ttl_seconds, qr_ttl_seconds)
   where id = 1;
  insert into paydemo.events (room_id, type, detail)
  values (p_room_id, 'SETTINGS_UPDATED', jsonb_build_object(
    'price', p_price, 'hold_seconds', p_hold_seconds, 'qr_ttl_seconds', p_qr_ttl_seconds));
  return public.paydemo_admin_state(p_code, p_room_id);
end $$;

-- ---------------------------------------------------------------------
-- 6. PHÂN QUYỀN
-- ---------------------------------------------------------------------
revoke all on all functions in schema paydemo from public;

grant execute on function public.paydemo_get_room(text)                       to anon, authenticated;
grant execute on function public.paydemo_create_session(text, text)           to anon, authenticated;
grant execute on function public.paydemo_claim(text, text)                    to anon, authenticated;
grant execute on function public.paydemo_get_session(text)                    to anon, authenticated;
grant execute on function public.paydemo_report_transfer(text)                to anon, authenticated;
grant execute on function public.paydemo_admin_state(text, text)              to anon, authenticated;
grant execute on function public.paydemo_admin_confirm_paid(text, text)       to anon, authenticated;
grant execute on function public.paydemo_admin_release(text, text)            to anon, authenticated;
grant execute on function public.paydemo_admin_reset(text, text)              to anon, authenticated;
grant execute on function public.paydemo_admin_update(text, text, bigint, int, int) to anon, authenticated;

-- Báo PostgREST nạp lại danh sách hàm ngay
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------
-- 7. MÃ QUẢN TRỊ — LƯU LẠI giá trị hiển thị ở ô kết quả bên dưới
-- ---------------------------------------------------------------------
select paydemo.init_admin_code() as "MA_QUAN_TRI";
