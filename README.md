# Bitvavo Signal-Bot

Prüft alle 5 Minuten alle EUR-Märkte auf Bitvavo mit mehr als 250'000 € Volumen in 24h. Er trainiert das gleiche Lernmodell wie die Radar-App und schickt per ntfy eine Push-Nachricht aufs Handy:

- bei jedem **neuen** Kauf-Signal (Standard: nur «Starker Kauf»)
- bei Verkaufsempfehlungen für deine Coins: Stop erreicht, Ziel erreicht, Modell negativ, stark überkauft

Jedes Signal wird nur einmal gemeldet. Ändert es sich, kommt eine neue Meldung.

## Einrichten

1. Lege auf github.com ein neues Repository an, zum Beispiel `bitvavo-bot`. Wähle **Public**: GitHub Actions ist für öffentliche Repositories unbegrenzt gratis. Deine Positionen und dein ntfy-Kanal liegen in Secrets und sind für niemanden sichtbar.
2. Lade die Dateien hoch: `bot.mjs`, `README.md` und `.github/workflows/signale.yml`. Der Ordnerpfad muss genau so heissen.
3. Gehe zu **Settings → Secrets and variables → Actions → New repository secret** und lege zwei Secrets an:
   - `NTFY_TOPIC`: dein ntfy-Kanal (geheim halten)
   - `POSITIONS`: deine gehaltenen Coins als JSON, zum Beispiel
     `[{"coin":"BTC","buy":61500,"qty":0.02},{"coin":"SOL","buy":142.3}]`
     Die Menge `qty` ist optional. Ohne Coins: `[]`
4. Optional unter dem Reiter **Variables**:
   - `TF`: `15m`, `1h` (Standard) oder `4h`
   - `MIN_LEVEL`: `2` = nur Starker Kauf (Standard), `1` = ab Kauf
5. Starte den Bot im Tab **Actions** über «Bitvavo Signale» → **Run workflow** einmal von Hand. Danach läuft er automatisch alle 5 Minuten.

## Logbuch

Jeder Lauf schreibt Daten in den Branch **logs** (umschalten oben links von «main» auf «logs»):

| Ordner | Inhalt | Häufigkeit |
|---|---|---|
| `markt/JJJJ/JJJJ-MM-TT.csv` | Alle Märkte: Preis, Volumen, RSI, Trefferwahrscheinlichkeit, Erwartung, Signal | stündlich |
| `laeufe/JJJJ-MM.csv` | Zusammenfassung pro Lauf: Anzahl Signale, Modellqualität, BTC-Preis, Laufzeit | alle 5 Minuten |
| `meldungen/JJJJ-MM.csv` | Gesendete Kauf-Signale | bei jeder Meldung |

Verkaufsmeldungen zu deinen Coins werden absichtlich nicht geloggt, weil das Repository öffentlich ist.

Daten älter als 3 Jahre löscht der Bot automatisch. Der Branch wird jedes Mal als einzelner Commit ohne Verlauf gespeichert, gelöschte Daten belegen danach also wirklich keinen Platz mehr. Nach 3 Jahren sind es etwa 200 MB, GitHub empfiehlt Repositories unter 1 GB.

## Coins kaufen oder verkaufen

Bearbeite das Secret `POSITIONS`: Coin hinzufügen nach einem Kauf, entfernen nach einem Verkauf. Stop und Ziel berechnet der Bot beim ersten Lauf aus der Volatilität. Ein nachlaufender Stop sichert danach Gewinne.

## Gut zu wissen

- Beim ersten Lauf kommen alle aktuell aktiven Kauf-Signale auf einmal, höchstens 4 einzeln und der Rest zusammengefasst.
- 5 Minuten ist der kürzeste Takt, den GitHub erlaubt. Bei hoher Last startet GitHub Läufe verspätet oder lässt einzelne aus, rechne also eher mit 5–15 Minuten.
- Bei öffentlichen Repositories pausiert GitHub geplante Läufe nach 60 Tagen ohne Commit. Dann einfach eine kleine Änderung committen, zum Beispiel in dieser README.
- Fällt der Datenabruf aus, kommt eine Fehlermeldung und eine Entwarnung, sobald es wieder läuft.
- Das ist keine Anlageberatung. Setze immer einen echten Stop-Loss bei Bitvavo.
