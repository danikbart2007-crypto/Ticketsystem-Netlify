# Ticketsystem auf Netlify + Supabase

Kein Server, der einschlafen kann. Kein Datenverlust bei Neustarts.
Dauerhaft kostenlos.

**Ablauf:** Jemand füllt das Formular aus → die Dateien gehen direkt vom Browser
zu Supabase → in Telegram erscheint sofort "🎫 Neues Ticket von …" mit Button
**Ticket öffnen** → dort stehen Nachricht und alle Downloads.
50 Tage nach dem ersten Öffnen löscht sich ein Ticket automatisch samt Dateien.
Ungeöffnete Tickets bleiben erhalten.

---

## Schritt 1: Supabase einrichten (10 Minuten)

1. Auf https://supabase.com mit GitHub anmelden → **New project**.
   Name frei wählbar, Region **Frankfurt (eu-central-1)**, Datenbank-Passwort
   vergeben (wird hier nicht weiter gebraucht, trotzdem notieren).
   Das Anlegen dauert 1–2 Minuten.
2. Links **SQL Editor** öffnen → **New query** → den kompletten Inhalt der
   Datei `SUPABASE.sql` einfügen → **Run**. Meldung "Success" abwarten.
3. Links **Storage** → **New bucket** → Name exakt `ticket-files` →
   **Public bucket ausgeschaltet lassen** (wichtig!) → Create.
4. Links **Project Settings → API**. Zwei Werte kopieren und bereitlegen:
   - **Project URL** (Form `https://abcdefgh.supabase.co`)
   - **service_role**-Schlüssel (langer Text, unter "Project API keys";
     ggf. "Reveal" klicken). **Geheim halten** – dieser Schlüssel darf nur
     bei Netlify eingetragen werden, nie in eine Website oder auf GitHub.

## Schritt 2: Telegram-Bot (5 Minuten – falls noch nicht vorhanden)

Hast du den Bot vom bisherigen System, kannst du Token und Chat-ID einfach
weiterverwenden und diesen Schritt überspringen.

1. In Telegram **@BotFather** anschreiben → `/newbot` → Name und Benutzername
   (endet auf `bot`) vergeben → **Token** kopieren.
2. Den eigenen Bot öffnen, **Start** drücken, irgendeine Nachricht schicken.
   (Für mehrere Empfänger: Gruppe anlegen, Bot hinzufügen, dort schreiben.)
3. **Chat-ID** herausfinden: Im Browser aufrufen (Token einsetzen):
   `https://api.telegram.org/bot<DEIN_TOKEN>/getUpdates`
   In der Antwort steht `"chat":{"id":123456789,...}` – diese Zahl ist die
   Chat-ID (bei Gruppen negativ, das ist korrekt).

## Schritt 3: Code auf GitHub (5 Minuten)

Neues, **privates** Repository anlegen (z. B. `ticketsystem-netlify`) und den
Inhalt dieses Ordners hochladen – wichtig unter Beibehaltung der Struktur:

```
netlify.toml
public/index.html
netlify/functions/create-ticket.js
netlify/functions/finalize-ticket.js
netlify/functions/ticket.js
netlify/functions/admin.js
netlify/functions/lib/supabase.js
```

Beim Hochladen über den Browser gehen Ordner verloren. Trick: Im Upload-Fenster
den Dateinamen mit Pfad eintippen, z. B. `netlify/functions/ticket.js` – GitHub
legt die Ordner dann automatisch an. Der Ordner `test/` wird nicht gebraucht.

## Schritt 4: Netlify verbinden (5 Minuten)

1. Auf https://app.netlify.com mit GitHub anmelden.
2. **Add new site → Import an existing project** → GitHub → dein Repository.
3. Build-Einstellungen unverändert lassen (`netlify.toml` regelt alles) →
   **Deploy**.
4. Nach ~1 Minute steht die Seite unter einer Adresse wie
   `https://zufallsname.netlify.app`. Unter **Site configuration → General →
   Site details → Change site name** kannst du sie umbenennen.

## Schritt 5: Environment Variables setzen (5 Minuten)

**Site configuration → Environment variables → Add a variable**
(jeweils "Same value for all deploy contexts"):

| Key | Value |
|---|---|
| `SUPABASE_URL` | die Project URL aus Schritt 1.4 |
| `SUPABASE_SERVICE_KEY` | der service_role-Schlüssel aus Schritt 1.4 |
| `TELEGRAM_BOT_TOKEN` | Bot-Token aus Schritt 2 |
| `TELEGRAM_CHAT_ID` | Chat-ID aus Schritt 2 |
| `ADMIN_KEY` | selbst ausgedachter langer Zufallswert, z. B. `kx83mWq20pTzQ7` |

Optional:

| Key | Value | Wirkung |
|---|---|---|
| `DELETE_AFTER_DAYS` | `50` | Aufbewahrung nach dem ersten Öffnen |
| `MAX_FILE_MB` | `50` | Größe je Datei |
| `MAX_FILES` | `30` | Dateien je Ticket |
| `SUPABASE_BUCKET` | `ticket-files` | nur bei abweichendem Bucket-Namen |

Danach unter **Deploys → Trigger deploy → Deploy site** einmal neu ausrollen,
damit die Variablen greifen.

## Schritt 6: Testen (2 Minuten)

1. Deine Netlify-Adresse öffnen, Testticket mit Datei absenden.
2. In Telegram kommt die Nachricht mit Button **Ticket öffnen**.
3. Button antippen → Nachricht und Downloads erscheinen, unten steht das
   automatische Löschdatum.
4. Übersicht aller Tickets: `https://deine-adresse.netlify.app/admin/DEIN_ADMIN_KEY`

Fertig. Den Formular-Link kannst du weitergeben (Website, QR-Code, Linktree).

---

## Wissenswertes

**Warum lädt die Seite immer sofort?** Das Formular ist eine statische Seite,
die Netlify weltweit ausliefert. Die Logik läuft in Functions, die pro Aufruf in
Millisekunden starten. Es gibt keinen Server, der einschlafen könnte – die
Boot-Animation von Render entfällt vollständig.

**Wo liegen die Daten?** Texte in der Supabase-Datenbank, Dateien im
Supabase-Storage – beides in Frankfurt, beides dauerhaft. Der Bucket ist privat;
Downloads laufen über signierte Adressen, die nach 2 Stunden ablaufen. Ein
gültiger Ticket-Link ist Voraussetzung.

**Wie funktioniert die Löschung?** Beim ersten Öffnen wird der Zeitpunkt
gespeichert. Jeder spätere Seitenaufruf prüft nebenbei (höchstens stündlich), ob
Tickets älter als 50 Tage seit Öffnung sind, und löscht diese samt Dateien. Der
Aufruf der Admin-Seite erzwingt die Prüfung sofort. Ungeöffnete Tickets werden
nie automatisch gelöscht, damit nichts unbemerkt verschwindet.

**Gratis-Grenzen:** Netlify 100 GB Datenverkehr und 125.000 Function-Aufrufe pro
Monat, Supabase 500 MB Datenbank, 1 GB Dateien und 5 GB Downloads pro Monat. Für
einen Verein ist das reichlich. Hinweis: Supabase pausiert Projekte nach einer
Woche völliger Inaktivität – ein einziger Ticketaufruf pro Woche genügt, um das
zu verhindern; reaktivieren ließe sich ein pausiertes Projekt per Klick im
Dashboard, ohne Datenverlust.

**Falls etwas nicht ankommt:** Netlify → **Logs → Functions** zeigt die
Fehlermeldungen der einzelnen Aufrufe.

## Lokal testen (optional)

Im Ordner `test/` liegt eine Testsuite, die alle Functions gegen einen
nachgebauten Supabase-Server prüft – ohne echte Zugangsdaten:

```
node test/run-tests.js
```
