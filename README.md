# ARTICLE EXTRACTOR — स्वतंत्र Fetch Backend (v2)

यह छोटा Node.js backend सिर्फ़ वेबसाइट का HTML लाकर ऐप को देता है।
Extraction, Cleaning और तीनों Copy Buttons पूरी तरह ऐप (ब्राउज़र) में ही चलते हैं।

- कोई AI API नहीं
- कोई Paid Scraping API नहीं
- कोई App Builder Integration Credit नहीं (कोई @base44 कॉल नहीं)
- शून्य npm Dependencies — सिर्फ़ Node.js 18+ चाहिए

## Dailyhunt Short Link के लिए Backend क्यों ज़रूरी है

dhunt.in जैसे छोटे लिंक का पूरा redirect चेन ऐसा है:

    https://dhunt.in/15LhZH
      -> 301  http://m.dailyhunt.in/news/...-newsid-n729801131?sm=Y
      -> 301  https://m.dailyhunt.in/news/...-newsid-n729801131?sm=Y
      -> 200  text/html; charset=utf-8

इनमें से किसी भी जवाब में Access-Control-Allow-Origin हेडर नहीं होता, इसलिए ब्राउज़र
इस चेन को पढ़ ही नहीं सकता (कोई ऐप खराबी नहीं — वेबसाइट की सुरक्षा नीति है)।
इसलिए छोटे लिंक खोलना, हर redirect की जाँच करना और अंतिम सार्वजनिक URL की पुष्टि यह Backend करता है।

## फ़ाइलें

1. server.js
2. package.json
3. README.md (यही फ़ाइल)

## लोकल टेस्ट

    node server.js
    # health जाँच
    http://localhost:8080/health
    # Dailyhunt short link जाँच
    http://localhost:8080/extract?url=https%3A%2F%2Fdhunt.in%2F15LhZH

## जवाब का JSON प्रारूप

सफल (असली finalUrl के साथ):

    {
      "ok": true,
      "status": 200,
      "finalUrl": "https://m.dailyhunt.in/news/india/hindi/...-newsid-n729801131?sm=Y",
      "contentType": "text/html; charset=utf-8",
      "bytes": 78972,
      "redirects": [ { "status": 301, "from": "https://dhunt.in/15LhZH", "to": "https://m.dailyhunt.in/news/..." } ],
      "html": "<!doctype html> ..."
    }

असफल — जैसे HTTP 401 या Request Abort (कभी सफल नहीं माना जाता):

    { "ok": false, "code": "AUTH_REQUIRED", "status": 401, "message": "Upstream HTTP 401",
      "finalUrl": "...", "redirects": [ ... ] }

Error codes: AUTH_REQUIRED, PAYWALL, NOT_FOUND, RATE_LIMITED, SERVER_ERROR, UPSTREAM_ERROR, NOT_HTML,
TOO_LARGE, TIMEOUT, TOO_MANY_REDIRECTS, NO_LOCATION, UNSAFE_URL, UNSAFE_REDIRECT, SITE_UNREACHABLE

## होस्टिंग (कोई एक चुनें)

- Render: New → Web Service → Build Command खाली (कोई dependency नहीं) → Start Command: node server.js
- Railway: New Project → Deploy from GitHub → Start Command: node server.js
- Fly.io: fly launch (Node app) → fly deploy
- अपना VPS: node server.js को systemd या pm2 से चलाएँ, आगे nginx/caddy रिवर्स प्रॉक्सी और HTTPS लगाएँ

Environment variables: PORT, DEADLINE_MS, MAX_BYTES, MAX_REDIRECTS, ALLOWED_ORIGIN.
किसी paid platform की ज़रूरत नहीं — कोई भी Node.js होस्ट चलेगा।

## ऐप से जोड़ना

1. Backend डिप्लॉय करके उसका URL कॉपी करें (जैसे https://my-extractor.onrender.com)
2. ऐप के "स्वतंत्र Backend सेटअप" पेज में वह URL सेव करें
3. "जाँचें" दबाकर पुष्टि करें, फिर Dailyhunt Short Link सहित कोई भी न्यूज़ लिंक निकालें

यह URL सिर्फ़ आपके डिवाइस पर सेव होता है। ऐप में कोई काल्पनिक URL नहीं है — खाली छोड़ने पर ऐप
बिना Backend (केवल सीधे ब्राउज़र फ़ेच) चलता है और CORS-ब्लॉक वाली साइटों पर साफ़ Error दिखाता है।

## सुरक्षा (SSRF सहित)

- केवल http/https; URL के अंदर user:password मना; पोर्ट सिर्फ़ 80/443
- हर redirect चरण पर host जाँच: DNS resolve करके private, loopback, link-local, CGNAT, multicast,
  documentation और cloud-metadata (169.254.169.254) पते ब्लॉक
- localhost, *.local, *.internal, *.onion, *.home, *.lan ब्लॉक (IPv4 और IPv6 दोनों)
- http होप को https में बदला जाता है; अधिकतम 8 redirect
- 15 सेकंड समय सीमा और 3.5MB जवाब सीमा (streaming में ही काट दिया जाता है)
- केवल text/html, application/xhtml+xml, text/plain स्वीकार — PDF/इमेज/JSON नहीं
- पेज का JavaScript कभी execute नहीं होता; कोई secret key frontend में नहीं रहती
- ALLOWED_ORIGIN सेट करने पर सिर्फ़ वही ओरिजिन जवाब पढ़ सकता है
- ध्यान दें: DNS जाँच और कनेक्शन के बीच का छोटा अंतर (DNS rebinding) हर होस्टर पर पूरी तरह बंद नहीं
  किया जा सकता — इसे isolated container में चलाना सबसे सुरक्षित है।

## खर्च, सीमाएँ और नियम

- होस्टिंग और बैंडविड्थ मुफ़्त नहीं रहते; मुफ़्त प्लान स्लीप मोड में जा सकते हैं (पहला अनुरोध धीमा)।
- एक न्यूज़ पेज का HTML आम तौर पर 200KB–1MB का होता है।
- कोई भी वेबसाइट 100% सफल extraction की गारंटी नहीं देती — Login, Paywall और Anti-Bot वाले पेज ब्लॉक रहेंगे।
- ऐप इन सुरक्षाओं को bypass नहीं करता और ऐसी कोशिश न करें।
- वेबसाइट की शर्तें, robots.txt और लागू कॉपीराइट नियमों का सम्मान करें।

## आम गड़बड़ियाँ

- "CORS Proxy: HTTP 401" / "Request Aborted": ये असफल सार्वजनिक रिले थे — ऐप से हटा दिए गए हैं।
  भरोसेमंद हल: यह Backend होस्ट करें (कोड कहीं भी चलेगा, credits की ज़रूरत नहीं)।
- "Failed to fetch" / CORS ब्लॉक: ब्राउज़र ने रोका — इस Backend का URL ऐप में सेव करें।
- जवाब में ok:false और code:TIMEOUT/SITE_UNREACHABLE: होस्टिंग सो रही है या साइट ने जवाब नहीं दिया।
