// =====================================================================
//  CẤU HÌNH KẾT NỐI BACKEND (Supabase)
//  Lấy 2 giá trị ở: Supabase Dashboard → Project Settings → API Keys / Data API
//  - supabaseUrl : Project URL, dạng https://xxxxxxxx.supabase.co
//  - supabaseKey : Publishable key (sb_publishable_...) hoặc anon key (eyJ...)
//  Hai giá trị này được thiết kế để công khai trên web: trình duyệt chỉ gọi
//  được các hàm public.paydemo_* — bảng dữ liệu bị khoá hoàn toàn.
// =====================================================================
window.PAYDEMO_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
  roomId: 'P101',   // phải khớp với phòng tạo trong supabase/setup.sql
  pollMs: 1000      // chu kỳ cập nhật trạng thái (ms)
};
