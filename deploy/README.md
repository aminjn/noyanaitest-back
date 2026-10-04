# راه‌اندازی روی ts.noyanai.com

کل اپ روی یک دامنه است. nginx مسیرها را این‌طور تقسیم می‌کند:

| مسیر | مقصد |
|---|---|
| `/api/*` (شامل `/api/socket.io`) | بک‌اند، `127.0.0.1:5100` |
| `/files/*` | فایل‌های آپلودی (پوشه‌ی `Public/` بک‌اند) |
| بقیه | فرانت Next.js، `127.0.0.1:3100` |

پورت‌ها، دیتابیس و بازه‌ی پورت mediasoup با سایت فعلی فرق دارند، پس هر دو می‌توانند روی یک سرور کنار هم اجرا شوند.

## ۱. DNS
یک رکورد `A` برای `ts.noyanai.com` بسازید که به IP سرور اشاره کند.

## ۲. کد
```bash
mkdir -p /var/www/noyanai-ts && cd /var/www/noyanai-ts
git clone https://github.com/aminjn/noyanaitest-back.git back
git clone https://github.com/aminjn/noyanaitest.git front
```

## ۳. بک‌اند
```bash
cd /var/www/noyanai-ts/back
cp deploy/env.ts.noyanai.com .env
nano .env        # JWT_SECRET، SUPER_ADMIN_PHONES، SMS، ANNOUNCED_ADDRESS و ...
npm ci && npm run build
pm2 start deploy/ecosystem.config.js
```
- مقدار `NODE_ENV` باید `production` باشد. در حالت development همه‌ی کدهای OTP برابر `111111` هستند و هر کسی می‌تواند وارد هر حسابی شود.
- ابزارهای آزمایشی مدیر (سفارش و لغو سفر واقعی اسنپ، پرداخت اسنپ، حذف و پاک‌سازی داده در «مهاجرت داده‌ها») در production خاموش‌اند. برای استفاده‌ی موقت `ALLOW_DEVTOOLS=true` را در `.env` بگذارید و بعد از کار حذف کنید.
- اطلاعات API پیامک (توکن آی‌پی‌پنل، شماره فرستنده، آدرس ارسال) را می‌توانید از پنل سوپر ادمین، «مدیریت سیستم ← تنظیمات درگاه پیامک (API)» وارد و با «پیامک آزمایشی» امتحان کنید. مقدارهای `SMS_*` در `.env` فقط وقتی به کار می‌روند که در پنل چیزی ذخیره نشده باشد. کد پترن‌ها در صفحه‌ی «پترن‌های پیامک» است.
- `JWT_SECRET` را تازه بسازید (`openssl rand -hex 48`). مقدار سایت اصلی را استفاده نکنید.
- پس از اجرا، در لاگ (`pm2 logs noyanai-ts-back`) باید خط `[superAdmin] 98... is admin` را ببینید.

## ۴. فرانت
```bash
cd /var/www/noyanai-ts/front
cp deploy/env.ts.noyanai.com .env.local
nano .env.local  # ADMIN_KEY=notadmin عمداً همین است، تغییر ندهید
npm ci && npm run build
pm2 start deploy/ecosystem.config.js
pm2 save
```
متغیرهای env هنگام build داخل باندل قرار می‌گیرند. پس از هر تغییر در `.env.local` باید دوباره `npm run build` بزنید.

## ۵. nginx و SSL
```bash
cp /var/www/noyanai-ts/back/deploy/nginx/ts.noyanai.com.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/ts.noyanai.com.conf /etc/nginx/sites-enabled/
certbot certonly --nginx -d ts.noyanai.com
nginx -t && systemctl reload nginx
```
اگر گواهی هنوز صادر نشده، `nginx -t` روی خطوط `ssl_certificate` خطا می‌دهد. در آن صورت اول بلوک 443 را کامنت کنید، certbot را اجرا کنید و بعد بلوک را برگردانید. کوکی ورود در حالت production فقط روی HTTPS ارسال می‌شود.

## ۶. فایروال
پورت‌های 80 و 443 را باز کنید. برای تماس صوتی و تصویری، بازه‌ی `50000-50999` را روی UDP و TCP باز کنید.
پورت‌های 3100 و 5100 نباید از بیرون در دسترس باشند.

## ۷. بعد از اولین ورود سوپر ادمین
به آدرس `https://ts.noyanai.com/notadmin/appConfig` بروید و این دو فیلد را تنظیم کنید:
- `siteBaseUrl` را روی `https://ts.noyanai.com` بگذارید.
- `sepCallbackBaseUrl` را روی `https://ts.noyanai.com` بگذارید. آدرس callback درگاه سپ باید نزد بانک هم برای این دامنه ثبت شود.

بقیه‌ی کلیدها (SIP، پادیوم و ...) هم از همین صفحه قابل ویرایش‌اند.

## ۸. انتقال داده‌های سایت قدیم (noyanai.com)
یک دستور، روی سرور جدید. چند بار اجرا کردنش امن است: رکورد تکراری نمی‌سازد، تغییرات سایت قدیم را به‌روز می‌کند و ویرایش‌هایی که روی سایت جدید انجام شده دست نمی‌خورد.

**پیش‌نیاز روی سرور سایت قدیم** (فقط یک بار):
1. یک کاربر فقط‌خواندنی در Mongo بسازید:
   ```js
   // mongosh روی سرور قدیم، با کاربر مدیر
   use admin
   db.createUser({ user: "reader", pwd: "<رمز قوی>", roles: [{ role: "read", db: "Noyan" }] })
   ```
   اگر نام دیتابیس قدیم چیز دیگری است، همان را بنویسید (اسکریپت خودش پیدایش می‌کند؛ پیش‌فرض `Noyan`).
2. پورت `27017` سرور قدیم را فقط برای IP سرور جدید باز کنید، یا از تونل SSH استفاده کنید (پایین).

**اجرا روی سرور جدید:**
```bash
OLD_MONGO_URI='mongodb://reader:<رمز>@<IP سرور قدیم>:27017/?authSource=admin' \
OLD_FILES_BASE_URL='https://noyanai.com/files' \
bash /var/www/noyanai-ts/back/deploy/arvan/import-old.sh
```
- اسکریپت از سرور قدیم فقط می‌خواند (`mongodump`). نسخه‌ی پشتیبان در `/root/noyan-old-*.archive.gz` می‌ماند.
- دیتابیس `Noyan` محلی پاک و از روی dump دوباره ساخته می‌شود، سپس انتقال اجرا و تعداد ساخته‌شده / به‌روزشده / ردشده / خطا برای هر بخش چاپ می‌شود.
- `OLD_FILES_BASE_URL` آدرسی است که سایت قدیم فایل‌های آپلودی را از آن نشان می‌دهد (اگر تصویری در سایت قدیم `https://noyanai.com/files/a.jpg` است، مقدار `https://noyanai.com/files` است). مسیرهای نسبی از آن‌جا در `Public/` دانلود می‌شوند. آدرس‌های کامل (http...) هم دانلود می‌شوند و اگر نشد، همان آدرس می‌ماند.
- **راه جایگزین برای فایل‌ها:** پوشه‌ی آپلود سایت قدیم را مستقیم کپی کنید و اسکریپت را دوباره با `SKIP_DUMP=1` بزنید (فایل‌هایی که در `Public/` باشند دانلود نمی‌شوند):
  ```bash
  rsync -a root@<IP سرور قدیم>:<پوشه‌ی آپلود سایت قدیم>/ /var/www/noyanai-ts/back/Public/
  SKIP_DUMP=1 bash /var/www/noyanai-ts/back/deploy/arvan/import-old.sh
  ```
- **تونل SSH** (وقتی پورت Mongo سرور قدیم بسته است):
  ```bash
  ssh -fN -L 27018:127.0.0.1:27017 root@<IP سرور قدیم>
  OLD_MONGO_URI='mongodb://reader:<رمز>@127.0.0.1:27018/?authSource=admin' bash .../import-old.sh
  ```
- فقط چند بخش: `bash import-old.sh --only=doctor,blog` · بدون فایل‌ها: `--no-files` · نام دیتابیس: `OLD_DB=...`
- همین انتقال از پنل سوپر ادمین هم هست: `/notadmin/cold/migrate`، دکمه‌ی «انتقال همه‌ی داده‌های سایت قدیم» (روی دیتابیس `Noyan` همین سرور). نتیجه‌ی اجرای اسکریپت هم همان‌جا دیده می‌شود.
- اگر دیتابیسی روی سرور قدیم پیدا شد که از قبل مدل‌های جدید را دارد (`doctorprofiles`)، اسکریپت هشدار می‌دهد؛ آن را با `import-live.sh` کپی کنید، نه با این اسکریپت.

**چه چیزی کجا می‌رود:** اعضای بدن ← Part · تخصص‌ها ← Speciality · علائم ← Symptom (با اعضا) · داروها ← Drug (نسخه‌ای/بدون نسخه به `rx`/`otc`، متن قدیم در `prescriptionStatusLegacy`) · بیماری‌ها ← Disease (با علائم، داروها، تخصص‌ها) · کاربران ← User (هویت = شماره موبایل؛ بدون نقش مدیر و بدون هیچ رمزی) · پزشکان ← Doctor و پروفایل قابل نوبت‌دهی DoctorProfile (claimed: false، با شبکه‌های اجتماعی، گالری و ریدایرکت ۳۰۱ از `/doctor/<id قدیم>`) · مقالات ← Blog (متن به قالب ویرایشگر جدید تبدیل می‌شود، با دسته، نویسنده‌ی پزشک و مقاله‌های مرتبط).

### Old-site import (English)
One command on the new server; safe to re-run (no duplicates, refreshes what changed on the old site, keeps edits made on the new site).
```bash
OLD_MONGO_URI='mongodb://reader:PASS@OLD_IP:27017/?authSource=admin' \
OLD_FILES_BASE_URL='https://noyanai.com/files' \
bash /var/www/noyanai-ts/back/deploy/arvan/import-old.sh
```
Needs a read-only (`read` role) Mongo user on the live server and its port reachable from this server (or an SSH tunnel). It dumps the old database (auto-detected, default `Noyan`) read-only, restores it locally as `Noyan` (local copy dropped first), runs `node compile/Scripts/importOld.js` (same service as the admin button, `Services/oldSiteImport.ts`) and prints per-collection counts. Files: relative paths are downloaded from `OLD_FILES_BASE_URL` into `Public/`, or rsync the old upload folder into `Public/` and re-run with `SKIP_DUMP=1`. Options: `--only=doctor,blog`, `--no-files`, `OLD_DB=<name>`.

## نکات باز
- `redirect_uri` تأمین در بک‌اند روی `http://localhost/tamin` ثابت است (`clinicController.ts`، `doctorController.ts`)، اما فرانت `DOMAIN/doctorpanel/tamin` را می‌فرستد. این باید با آدرسی که نزد تأمین ثبت شده یکی شود.
- آدرس Ollama در `botController.ts` به‌صورت IP ثابت نوشته شده است.
