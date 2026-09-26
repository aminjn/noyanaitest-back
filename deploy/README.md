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

## نکات باز
- `redirect_uri` تأمین در بک‌اند روی `http://localhost/tamin` ثابت است (`clinicController.ts`، `doctorController.ts`)، اما فرانت `DOMAIN/doctorpanel/tamin` را می‌فرستد. این باید با آدرسی که نزد تأمین ثبت شده یکی شود.
- آدرس Ollama در `botController.ts` به‌صورت IP ثابت نوشته شده است.
