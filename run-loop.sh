#!/usr/bin/env bash
# Lässt den Bot alle 5 Minuten laufen, knapp 6 Stunden lang (Maximum pro GitHub-Job),
# und startet danach selbst den nächsten Durchgang. So hängt nichts am unzuverlässigen GitHub-Zeitplan.
set -u
INTERVAL=${INTERVAL:-300}
END=$(( $(date +%s) + ${LOOP_MINUTES:-345} * 60 ))
URL="${LOG_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
n=0
while :; do
  T0=$(date +%s); n=$((n+1))
  echo "::group::Lauf $n – $(date -u '+%H:%M') UTC"
  # Immer die neueste Bot-Version verwenden
  git fetch -q origin main && git reset -q --hard origin/main
  # Logbuch holen
  rm -rf logdata
  if ! git clone -q --depth 1 --branch logs "$URL" logdata 2>/dev/null; then
    mkdir logdata && (cd logdata && git init -q -b logs && git remote add origin "$URL")
  fi
  node bot.mjs || echo "Bot mit Fehler beendet (Meldung per ntfy)"
  # Logbuch als einzelner Commit ohne Verlauf speichern
  ( cd logdata && [ -n "$(ls -A | grep -v '^\.git$')" ] \
    && git checkout -q --orphan neu && git add -A \
    && git -c user.name="bitvavo-bot" -c user.email="bitvavo-bot@users.noreply.github.com" commit -qm "Logbuch Stand $(date -u '+%Y-%m-%d %H:%M') UTC" \
    && git push -q --force origin neu:logs ) || echo "Logbuch nicht gespeichert"
  echo "::endgroup::"
  NEXT=$(( T0 + INTERVAL )); NOW=$(date +%s)
  [ "$NEXT" -ge "$END" ] && break
  [ "$NEXT" -gt "$NOW" ] && sleep $(( NEXT - NOW ))
done
echo "$n Läufe erledigt, starte nächsten Durchgang."
gh workflow run signale.yml --ref main || echo "Nachfolger konnte nicht gestartet werden; der GitHub-Zeitplan springt ein."
