# Drag + Shift (Windows)

Windows için arka planda çalışan küçük bir eklenti: bir dosyayı sürüklerken **Shift**'e bas, imlecin altında bir çark açılır, dosyayı bir işlemin üstüne bırak. Sonuç orijinal dosyanın yanına kaydedilir.

[Ryshift](https://github.com/alexriderspy/ryshift)'ten esinlenilmiştir.

## Kurulum

[Releases](../../releases) sayfasından `DragShift Setup x.y.z.exe` dosyasını indirip çalıştır. Pencere açılmaz; Windows ile birlikte başlar, tepsideki turuncu noktadan kapatılabilir.

## Kullanım

1. Explorer'da ya da masaüstünde bir dosyayı sürüklemeye başla.
2. Sürüklerken **Shift**'e bas, imlecin altında cam bir çark açılır. **›** işaretli dilimler (Dönüştür, Daha fazla, Dosya) üzerinde **Shift**'e bas ya da biraz bekle: seçenekleri dışarı doğru açılır.
3. Dosyayı bir dilimin üstüne bırak. **Esc** çarkı kapatır. Birden fazla dosya da sürüklenebilir.

| Dosya | Çarktaki işlemler (› = Shift ile açılan alt seçenekler) |
|---|---|
| PDF | DOCX, JPG, PNG, TXT, Sayfalara ayır, Birleştir (birden fazla PDF) · **Daha fazla ›** Döndür, Üstveri temizle · **Dosya ›** |
| Görsel | Kırp, Düzenle, Arka plan, İşaretle, Gizle, Sıkıştır · **Dönüştür ›** PNG, JPG, WEBP, ICO, BMP, PDF (birden fazla görsel → tek PDF) · **Daha fazla ›** Döndür, Yatay çevir, Siyah-beyaz, Boyutlandır, Üstveri (EXIF/GPS) · **Dosya ›** |
| ZIP | Klasöre çıkar, İçerik listesi, Optimize et, Uzantı, Kopya, Hash, Base64 |
| Metin (.txt, .md, .csv…) | PDF, DOCX, HTML ve dosya işlemleri |
| **Dosya ›** (her dosya) | Uzantı değiştir, ZIP'le (birden fazla dosya → tek ZIP), Kopya oluştur, Hash (SHA-256/SHA-1), Base64 |

Her şey bilgisayarda, internetsiz çalışır; hiçbir dosya yüklenmez. Arayüz Türkçe (tepsi menüsünden İngilizceye geçilebilir).

## Geliştirme

```bash
npm install
npm start          # Electron ile çalıştır
npm run dist       # dist/ içine NSIS kurulum dosyası üretir
```

- `main.js` – fare/Shift durumunu `GetAsyncKeyState` ile okur (koffi), çark penceresini açar, dosyaları kaydeder.
- `index.html` – çark, araç pencereleri ve tüm dönüştürmeler (pdf.js, jsPDF, JSZip). Tarayıcıda açıldığında sürükle-bırak masaüstü olarak da çalışır.
- `preload.js` – pencere ile ana süreç arasındaki köprü.

> Not: Proje çok uzun bir klasör yolundaysa NSIS hata verebilir; kısa bir yolda (ör. `subst Q: .`) derleyin.

## 🛡️ VirusTotal

[![VirusTotal](https://img.shields.io/badge/VirusTotal-0%2F93%20temiz-brightgreen?logo=virustotal&logoColor=white)](https://www.virustotal.com/gui/url/fdfd91b039fa5073e3d8e8c312aed745393241d052ec25c18e9216cbbd3465a2)

Dosyalar [VirusTotal](https://www.virustotal.com) ile tarandı; hiçbir antivirüs motoru tehdit bulmadı.

| Taranan | Sonuç | Tarih | Rapor |
|---|---|---|---|
| `DragShift-Setup-1.0.2.exe` (kurulum dosyası) | **0/93** temiz | 24.10.2026 | [Raporu gör](https://www.virustotal.com/gui/url/fdfd91b039fa5073e3d8e8c312aed745393241d052ec25c18e9216cbbd3465a2) |
| Kaynak kod (`main.zip`) | **0/93** temiz | 24.10.2026 | [Raporu gör](https://www.virustotal.com/gui/url/53733cbb3bfb0aadef62d3e0e5954d3d5cdf333a34d322fbabaa5b3c944cfc98) |

## Lisans

MIT
