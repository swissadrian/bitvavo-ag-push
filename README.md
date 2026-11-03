# Bitvavo Signal-Bot

Prüft alle 5 Minuten alle EUR-Märkte auf Bitvavo mit mehr als 50'000 € Volumen in 24h **und** mehr als 250'000 € in den letzten 3 Tagen. So kommen auch Coins mit plötzlichem Volumenanstieg (Pumps) auf die Liste, während Coins ohne nennenswerten Handel draussen bleiben. Er trainiert das gleiche Lernmodell wie die Radar-App und schickt per ntfy eine Push-Nachricht aufs Handy:

- bei jedem **neuen** Kauf-Signal (Standard: nur «Starker Kauf»)
- bei Verkaufsempfehlungen für deine Coins: Stop erreicht, Ziel erreicht, Modell negativ, stark überkauft

Die Bitvavo-Gebühr (0,25 % pro Kauf und Verkauf) ist im Lernmodell eingerechnet. Jedes Signal wird nur einmal gemeldet. Ändert es sich, kommt eine neue Meldung.

## Einrichten

1. Lege auf github.com ein neues Repository an, zum Beispiel `bitvavo-bot`. Wähle **Public**: GitHub Actions ist für öffentliche Repositories unbegrenzt gratis. Deine Positionen und dein ntfy-Kanal liegen in Secrets und sind für niemanden sichtbar.
2. Lade die Dateien hoch: `bot.mjs`, `README.md` und `.github/workflows/signale.yml`. Der Ordnerpfad muss genau so heissen.
3. Gehe zu **Settings → Secrets and variables → Actions → New repository secret** und lege das Secret `NTFY_TOPIC` an: dein ntfy-Kanal (geheim halten). Mehr braucht es nicht. Deine Käufe trägst du über die App oder ntfy ein (siehe unten).
4. Optional unter dem Reiter **Variables**:
   - `TF`: `15m`, `1h` (Standard) oder `4h`
   - `MIN_LEVEL`: `2` = nur Starker Kauf (Standard), `1` = ab Kauf
5. Starte den Bot im Tab **Actions** über «Bitvavo Signale» → **Run workflow** einmal von Hand. Danach läuft er automatisch alle 5 Minuten.

## Käufe und Verkäufe eintragen (ohne Secret)

Der Bot liest deine Käufe über den ntfy-Kanal `<dein Kanal>-cmd`. Zwei Wege:

- **Radar-App:** Im Coin auf «Als gekauft eintragen» oder «Verkauf eintragen» tippen. Die App schickt das automatisch an den Bot, sofern dort derselbe ntfy-Kanal eingetragen ist.
- **ntfy-App:** Den Kanal `<dein Kanal>-cmd` abonnieren und eine Nachricht senden:
  - `kauf BTC 61500 0.02` (Coin, Kaufpreis, Menge optional)
  - `verkauf BTC 63000` (Verkaufspreis optional)
  - `liste` zeigt alle Positionen mit aktueller Empfehlung

Der Bot bestätigt jede Eingabe beim nächsten Lauf per Push. Stop und Ziel berechnet er aus der Volatilität. Danach meldet er sich, wenn du verkaufen solltest. Ab dann sichert ein nachlaufender Stop deine Gewinne.

Die Positionen speichert der Bot **verschlüsselt** im Branch `logs` (`zustand.enc`). Schlüssel ist dein ntfy-Kanal: Ohne ihn kann niemand die Datei lesen. Änderst du den Kanal, beginnt der Bot mit leerem Bestand.

## Trade-Aufbau: automatisch nach Gebühren optimiert

Einmal pro Woche testet der Bot 108 Varianten auf dem Kursverlauf aller Märkte: Stop-Abstand (1–3 ATR, mindestens 0 / 1,5 / 2,5 % vom Kurs), Ziel (1,5 / 2 / 3 × Risiko) und Haltedauer (8 / 24 / 48 h). Bewertet wird jeweils der unbekannte Testzeitraum nach Abzug von 0,25 % Gebühr pro Kauf und Verkauf. Der beste Aufbau gilt ab dann für Bot und Radar-App. Ergebnisse stehen im Branch `logs` unter `analyse/`.

Zu enge Stops verlieren schon durch die Gebühren. Ein Stop von 1 ATR auf dem 1h-Chart liegt oft nur etwa 0,5 % entfernt, so viel kosten auch Kauf und Verkauf zusammen. Stablecoins wie USDC oder EURC werden nicht analysiert.

## Logbuch

Alles liegt im Branch **logs** (oben links von «main» auf «logs» umschalten). Zeiten in UTC. Je älter die Daten, desto gröber werden sie gespeichert:

| Alter der Daten | Kurse (Open, High, Low, Close, Volumen) | Signale je Markt |
|---|---|---|
| bis 30 Tage | 1 Minute · `kurse/1m/` | jeder Lauf (≈ 5 Min) · `signale/lauf/` |
| 30 Tage bis 3 Monate | 5 Minuten · `kurse/5m/` | 1 Stunde · `signale/1h/` |
| 3 bis 6 Monate | 30 Minuten · `kurse/30m/` | 1 Stunde |
| 6 Monate bis 1 Jahr | 1 Stunde · `kurse/1h/` | 1 Stunde |
| 1 bis 3 Jahre | 24 Stunden · `kurse/24h/` | 24 Stunden · `signale/24h/` |
| älter als 3 Jahre | gelöscht | gelöscht |

Dazu kommen `laeufe/` mit einer Zusammenfassung pro Lauf und `meldungen/` mit den gesendeten Kauf-Signalen. Beides wird nach 3 Jahren gelöscht.

Die neuesten Daten liegen in Stundendateien (`JJJJ-MM-TT-HH.csv`), ältere in gepackten Tagesdateien (`.csv.gz`). Die 1-Minuten-Werte stammen direkt von Bitvavo und sind deshalb lückenlos, obwohl der Bot nur etwa alle 5 Minuten läuft. Der Branch wird jedes Mal als einzelner Commit ohne Verlauf gespeichert, sodass gelöschte Daten wirklich keinen Platz mehr belegen.

**Platz:** rund 1,6 MB pro Markt, und das bleibt stabil, weil Altes laufend verdichtet und gelöscht wird. Bei 150 Märkten sind das etwa 250 MB, bei 250 Märkten etwa 400 MB. GitHub empfiehlt Repositories unter 1 GB. Die Anzahl Märkte steht in `laeufe/` (Spalte `maerkte`).

Verkaufsmeldungen und deine Positionen werden nicht im Klartext geloggt, weil das Repository öffentlich ist.

## Gut zu wissen

- Beim ersten Lauf kommen alle aktuell aktiven Kauf-Signale auf einmal, höchstens 4 einzeln und der Rest zusammengefasst.
- Die Radar-App läuft unter https://swissadrian.github.io/bitvavo-ag-push/ (Ordner `docs/`).
- 5 Minuten ist der kürzeste Takt, den GitHub erlaubt. Bei hoher Last startet GitHub Läufe verspätet oder lässt einzelne aus, rechne also eher mit 5–15 Minuten.
- Bei öffentlichen Repositories pausiert GitHub geplante Läufe nach 60 Tagen ohne Commit. Dann einfach eine kleine Änderung committen, zum Beispiel in dieser README.
- Fällt der Datenabruf aus, kommt eine Fehlermeldung und eine Entwarnung, sobald es wieder läuft.
- Das ist keine Anlageberatung. Setze immer einen echten Stop-Loss bei Bitvavo.
