<?php
declare(strict_types=1);

/**
 * WhatsApp Business girişi — Meta "Embedded Signup" sayfası (https://mivelo.app/api/wa-signup.php?state=<rastgele>.<port>).
 * Masaüstü uygulaması bu sayfayı varsayılan tarayıcıda açar; Facebook JS SDK'sı Meta'nın kendi penceresinde numarayı seçtirir
 * (WhatsApp Business uygulamasındaki numara = "coexistence" ya da yeni numara). Pencere kapanınca sayfa yetki kodunu ve seçilen
 * phone_number_id / waba_id'yi kullanıcının KENDİ bilgisayarındaki Mivelo'ya (http://127.0.0.1:<port>/oauth/callback) taşır;
 * belirteç değişimi aracıda (oauth.php). Bu sayfa hiçbir şey kaydetmez, günlüğe yazmaz; gizi içermez (yalnız uygulama kimliği).
 */

header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
header('Content-Type: text/html; charset=utf-8');

require_once __DIR__ . '/lib-oauth.php';

$state = is_string($_GET['state'] ?? null) ? $_GET['state'] : '';
$port = preg_match('/^[A-Za-z0-9_-]{16,64}\.(\d{4,5})$/', $state, $m) ? (int) $m[1] : 0;
$ok = $port >= 1024 && $port <= 65535;
$c = [];
try {
    $clients = mv_oauth_clients();
    $c = is_array($clients['whatsapp'] ?? null) ? $clients['whatsapp'] : [];
} catch (Throwable $e) {
    $c = [];
}
$ready = mv_oauth_ready('whatsapp', $c);
$appId = (string) ($c['clientId'] ?? '');
$cfgId = (string) ($c['configId'] ?? '');
$ver = mv_oauth_graph_version($c['graphVersion'] ?? null);
$nonce = base64_encode(random_bytes(16));
header("Content-Security-Policy: default-src 'none'; script-src 'nonce-$nonce' https://connect.facebook.net; style-src 'nonce-$nonce'; img-src data: https://www.facebook.com; connect-src https://www.facebook.com https://web.facebook.com https://graph.facebook.com https://connect.facebook.net; frame-src https://www.facebook.com https://web.facebook.com https://business.facebook.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
$h = function ($v): string {
    return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
};
?><!doctype html>
<html lang="tr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Mivelo · WhatsApp Business</title>
<style nonce="<?= $nonce ?>">
body{font-family:-apple-system,BlinkMacSystemFont,Inter,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f6fa;color:#16131f}
@media (prefers-color-scheme:dark){body{background:#131118;color:#f1eff6}p,li,.sub{color:#a29db0!important}.card{background:#1b1823!important;border-color:#2a2634!important}.b2{background:#242030!important;color:#f1eff6!important;border-color:#2f2a3c!important}}
.c{max-width:480px;padding:24px;width:100%;box-sizing:border-box}
.m{width:56px;height:56px;border-radius:16px;background:#6c47ff;display:inline-grid;place-items:center;margin-bottom:14px}
h1{font-size:22px;margin:0 0 8px}p{color:#6b6878;line-height:1.5;margin:0 0 14px}
.card{background:#fff;border:1px solid #e8e5f0;border-radius:16px;padding:18px}
.btn{display:flex;align-items:center;gap:12px;width:100%;box-sizing:border-box;text-align:left;border:0;border-radius:12px;padding:12px 14px;font:inherit;cursor:pointer;margin-bottom:10px}
.b1{background:#0E8A45;color:#fff}.b2{background:#f2f0f7;color:#16131f;border:1px solid #e8e5f0}
.btn b{display:block;font-size:14.5px}.btn small{display:block;font-size:12.5px;opacity:.8;margin-top:2px}
.btn:disabled{opacity:.5;cursor:default}
.sub{font-size:12.5px;color:#6b6878;line-height:1.5;margin:8px 0 0}
.x{display:inline-block;margin-top:10px;font-size:13px;color:#6b6878;text-decoration:underline;cursor:pointer;background:none;border:0;font-family:inherit}
#st{min-height:20px;font-size:13.5px;color:#6b6878;margin-top:6px}
#st.err{color:#d43f3f}
</style>
<div class="c">
  <div class="m"><svg width="30" height="30" viewBox="0 0 28 28" aria-hidden="true"><path d="M8 8c4.5 0 6 3 6 6s1.5 6 6 6M8 20c4.5 0 6-3 6-6" stroke="#fff" stroke-width="2.3" fill="none" stroke-linecap="round"/><circle cx="20" cy="8" r="2.5" fill="#D4FF3F"/></svg></div>
<?php if (!$ok): ?>
  <h1>Giriş bağlantısı geçersiz</h1>
  <p>Bu sayfa yalnız Mivelo masaüstü uygulamasından başlatılan girişler içindir. Mivelo’da Bağlan → WhatsApp’a yeniden bas.</p>
<?php elseif (!$ready): ?>
  <h1>WhatsApp resmi girişi şu an kapalı</h1>
  <p>Mivelo’nun Meta uygulaması henüz hazır değil. Mivelo’da WhatsApp’ı şimdilik QR ile bağlayabilirsin.</p>
<?php else: ?>
  <h1>WhatsApp Business’ı bağla</h1>
  <p>Meta’nın kendi penceresinde Facebook hesabınla giriş yapıp numaranı seçeceksin. Şifren Mivelo’ya yazılmaz.</p>
  <div class="card">
    <button class="btn b1" id="bCo" disabled>
      <span><b>WhatsApp Business uygulamamdaki numarayla</b><small>Telefonda WhatsApp Business kullanmaya devam edersin; Mivelo aynı numarayı bilgisayarda açar.</small></span>
    </button>
    <button class="btn b2" id="bNew" disabled>
      <span><b>Yeni numara kaydet</b><small>Hiçbir telefona kayıtlı olmayan bir numara; yalnız Mivelo ve Meta araçlarıyla kullanılır.</small></span>
    </button>
    <div id="st">Meta bileşeni yükleniyor…</div>
    <p class="sub">Kişisel WhatsApp numarası bu yolla bağlanamaz; onun için Mivelo’da “Kişisel hesap (QR)” seçeneğini kullan. Kişi son 24 saatte yazmadıysa serbest mesaj gönderilemez (Meta kuralı).</p>
    <button class="x" id="bCancel" type="button">Vazgeç ve Mivelo’ya dön</button>
  </div>
<?php endif; ?>
</div>
<?php if ($ok && $ready): ?>
<script nonce="<?= $nonce ?>">
(function(){
  'use strict';
  var APP_ID=<?= json_encode($appId) ?>, CFG=<?= json_encode($cfgId) ?>, VER=<?= json_encode($ver) ?>, PORT=<?= (int) $port ?>, STATE=<?= json_encode($state) ?>;
  var code=null, ids=null, done=false;
  var st=document.getElementById('st'), bCo=document.getElementById('bCo'), bNew=document.getElementById('bNew');
  function say(t,err){ st.textContent=t; st.className=err?'err':''; }
  function qs(o){ return Object.keys(o).filter(function(k){ return o[k]!==''&&o[k]!=null; }).map(function(k){ return encodeURIComponent(k)+'='+encodeURIComponent(o[k]); }).join('&'); }
  function back(err,desc){ if(done) return; done=true; location.replace('http://127.0.0.1:'+PORT+'/oauth/callback?'+qs({state:STATE,error:err,error_description:desc||''})); }
  function finish(){
    if(done||!code||!ids) return;
    if(!ids.phone_number_id){ back('no_number','Kurulumda numara seçilmedi'); return; }
    done=true; say('Mivelo’ya dönülüyor…');
    location.replace('http://127.0.0.1:'+PORT+'/oauth/callback?'+qs({state:STATE,code:code,phone_number_id:String(ids.phone_number_id),waba_id:String(ids.waba_id||'')}));
  }
  window.addEventListener('message',function(e){
    if(!/^https:\/\/(www|web|business)\.facebook\.com$/.test(e.origin)) return;
    var d; try{ d=JSON.parse(e.data); }catch(x){ return; }
    if(!d||d.type!=='WA_EMBEDDED_SIGNUP') return;
    if(d.event==='FINISH'||d.event==='FINISH_ONLY_WABA'||d.event==='FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'){ ids=d.data||{}; finish(); }
    else if(d.event==='CANCEL'){ back('access_denied','Kurulum tamamlanmadı'+(d.data&&d.data.current_step?' ('+d.data.current_step+')':'')); }
    else if(d.event==='ERROR'){ back('signup_error',(d.data&&d.data.error_message)||'Meta hata verdi'); }
  });
  function launch(feature){
    if(!window.FB){ say('Meta bileşeni yüklenemedi; sayfayı yenile',true); return; }
    say('Meta penceresi açıldı; girişi orada tamamla…');
    FB.login(function(r){
      if(r&&r.authResponse&&r.authResponse.code){ code=r.authResponse.code; finish(); }
      else if(!ids) back('access_denied','İzin verilmedi ya da pencere kapatıldı');
    },{config_id:CFG,response_type:'code',override_default_response_type:true,extras:{setup:{},featureType:feature,sessionInfoVersion:'3'}});
  }
  bCo.addEventListener('click',function(){ launch('whatsapp_business_app_onboarding'); });
  bNew.addEventListener('click',function(){ launch(''); });
  document.getElementById('bCancel').addEventListener('click',function(){ back('access_denied','İptal edildi'); });
  window.fbAsyncInit=function(){
    FB.init({appId:APP_ID,autoLogAppEvents:false,xfbml:false,version:VER});
    bCo.disabled=false; bNew.disabled=false; say('');
  };
  var s=document.createElement('script'); s.src='https://connect.facebook.net/tr_TR/sdk.js'; s.async=true; s.defer=true; s.crossOrigin='anonymous';
  s.onerror=function(){ say('Meta bileşeni yüklenemedi (ağ/engelleyici); sayfayı yenile',true); };
  document.head.appendChild(s);
})();
</script>
<?php endif; ?>
</html>
