# راه‌اندازی روی سرور ابری آروان (سرور خالی)

همه‌چیز با یک اسکریپت نصب می‌شود: Node.js، MongoDB، بک‌اند، فرانت، nginx، SSL و فایروال.

## ۱. ساخت سرور در پنل آروان
- **سیستم‌عامل:** Ubuntu 22.04 یا 24.04
- **منابع:** حداقل ۲ هسته و ۴ گیگ رم (build فرانت رم زیادی می‌خواهد؛ با رم کمتر، اسکریپت خودش swap می‌سازد ولی کند است) و دیسک ۴۰ گیگ به بالا
- **گروه امنیتی (Security Group):** این پورت‌ها را باز کنید:
  - `22`
  - `80`
  - `443`
  - `50000-50999` روی UDP و TCP (برای تماس صوتی و تصویری)

## ۲. DNS
برای `ts.noyanai.com` یک رکورد `A` بسازید که به IP عمومی سرور اشاره کند.
- اگر DNS دامنه روی آروان است، برای گرفتن گواهی **اول CDN (ابر نارنجی) را خاموش بگذارید**.
- اگر می‌خواهید CDN آروان روشن باشد و SSL را خود آروان بدهد، در مرحله‌ی بعد `SSL=none` بگذارید.

## ۳. اجرای اسکریپت
با SSH به‌عنوان root وارد سرور شوید و این دو دستور را بزنید:
```bash
curl -fsSL https://raw.githubusercontent.com/aminjn/noyanaitest-back/master/deploy/arvan/setup.sh -o setup.sh
SUPER_ADMIN_PHONES=09XXXXXXXXX bash setup.sh
```
- `SUPER_ADMIN_PHONES` شماره موبایل سوپر ادمین است. چند شماره را با کاما جدا کنید.
- دامنه‌ی دیگر: `DOMAIN=example.com`
- SSL روی CDN آروان: `SSL=none`

اجرای کامل حدود ۱۰ تا ۲۰ دقیقه طول می‌کشد. در آخر آدرس سایت و پنل (`/notadmin`) را چاپ می‌کند.

## ۴. تکمیل تنظیمات
فایل `/var/www/noyanai-ts/back/.env` را باز کنید و این‌ها را پر کنید. سپس `pm2 restart noyanai-ts-back` را بزنید.

| متغیر | کاربرد |
|---|---|
| `SMS_API_TOKEN`، `SMS_FROM_NUMBER`، `SMS_REQUEST_URL`، `OTP_PATTERN` | ارسال کد ورود. بدون این‌ها هیچ‌کس نمی‌تواند وارد شود، حتی سوپر ادمین. |
| `ANTHROPIC_API_KEY` یا `TRANSLATION_OLLAMA_MODEL` | ترجمه‌ی خودکار محتوا به ۱۴ زبان |
| `VAPID_*` | نوتیفیکیشن مرورگر. کلیدها را با `npx web-push generate-vapid-keys` بسازید. |

بعد از اولین ورود سوپر ادمین، در `/notadmin/appConfig` مقدار `siteBaseUrl` و `sepCallbackBaseUrl` را روی `https://ts.noyanai.com` بگذارید.

## به‌روزرسانی
برای گرفتن آخرین نسخه‌ی کد از `master`، build و ری‌استارت، همان دستور را دوباره اجرا کنید:
```bash
bash setup.sh
```
فایل‌های `.env`، دیتابیس و رمزها دست نمی‌خورند.

## نکات
- **دیتابیس:** MongoDB 7 داخل Docker اجرا می‌شود و فقط روی `127.0.0.1` در دسترس است. داده‌هایش در `/var/lib/noyanai-mongo` است. رمز آن در `/root/.noyanai-ts/mongo_password` است.
- **mirrorها:** Docker Hub و سایت MongoDB از ایران بسته‌اند، پس ایمیج از `docker.arvancloud.ir` گرفته می‌شود. بسته‌های اوبونتو از mirror آروان نصب می‌شوند. اگر `nodejs.org` یا `npmjs` در دسترس نباشد، اسکریپت خودش سراغ npmmirror می‌رود.
- **وضعیت و لاگ:**
  - `pm2 status`
  - `pm2 logs noyanai-ts-back`
  - `pm2 logs noyanai-ts-front`
  - `docker logs noyanai-mongo`
- **اگر certbot خطا داد** (معمولاً چون DNS هنوز به سرور نرسیده)، سایت روی HTTP بالا می‌ماند. چند دقیقه بعد اسکریپت را دوباره اجرا کنید.
