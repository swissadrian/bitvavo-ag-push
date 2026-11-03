# Bitvavo Signal-Bot

Prüft alle 5 Minuten alle EUR-Märkte auf Bitvavo mit mehr als 250'000 € Volumen in 24h. Er trainiert das gleiche Lernmodell wie die Radar-App und schickt per ntfy eine Push-Nachricht aufs Handy:

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

Alles liegt im Branch **logs** (oben links von «main» auf «logs» umschalten). Zeiten in UTC.

| Ordner | Inhalt | Auflösung | Aufbewahrung |
|---|---|---|---|
| `kurse/3min/` | Open, High, Low, Close, Volumen aller Märkte > 250k € | 3 Minuten | 1 Jahr |
| `kurse/1h/` | dasselbe, verdichtet | 1 Stunde | Jahr 2 und 3 |
| `signale/` | Preis, RSI, Trefferwahrscheinlichkeit, Erwartung, Signal je Markt | jeder Lauf (≈ 5 Min) | 1 Jahr |
| `signale-1h/` | dasselbe, ein Wert pro Stunde | 1 Stunde | Jahr 2 und 3 |
| `laeufe/` | Zusammenfassung pro Lauf, Modellqualität | jeder Lauf | 3 Jahre |
| `meldungen/` | gesendete Kauf-Signale | | 3 Jahre |

Abgeschlossene Tage werden als `.csv.gz` gepackt. Nach 3 Jahren wird alles gelöscht. Der Branch wird bei jedem Lauf als einzelner Commit ohne Verlauf gespeichert, sodass gelöschte Daten wirklich keinen Platz mehr belegen.

Die 3-Minuten-Werte stammen aus den 1-Minuten-Kerzen von Bitvavo. Deshalb gibt es sie lückenlos, obwohl der Bot nur etwa alle 5 Minuten läuft.

**Platz:** etwa 400–450 MB im ersten Jahr (gepackt), danach bleibt es bei rund 500 MB, weil Altes verdichtet und gelöscht wird. GitHub empfiehlt Repositories unter 1 GB.

Verkaufsmeldungen und deine Positionen werden nicht im Klartext geloggt, weil das Repository öffentlich ist.

## Gut zu wissen

- Beim ersten Lauf kommen alle aktuell aktiven Kauf-Signale auf einmal, höchstens 4 einzeln und der Rest zusammengefasst.
- 5 Minuten ist der kürzeste Takt, den GitHub erlaubt. Bei hoher Last startet GitHub Läufe verspätet oder lässt einzelne aus, rechne also eher mit 5–15 Minuten.
- Bei öffentlichen Repositories pausiert GitHub geplante Läufe nach 60 Tagen ohne Commit. Dann einfach eine kleine Änderung committen, zum Beispiel in dieser README.
- Fällt der Datenabruf aus, kommt eine Fehlermeldung und eine Entwarnung, sobald es wieder läuft.
- Das ist keine Anlageberatung. Setze immer einen echten Stop-Loss bei Bitvavo.
