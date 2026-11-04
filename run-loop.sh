#!/usr/bin/env bash
# Lässt den Bot alle 5 Minuten laufen, knapp 6 Stunden lang (Maximum pro GitHub-Job),
# und startet danach selbst den nächsten Durchgang. So hängt nichts am unzuverlässigen GitHub-Zeitplan.
# Alles steht in Funktionen, damit Bash das Skript ganz einliest, bevor es läuft:
# der Durchgang holt sich vor jedem Lauf die neueste Version aus dem Repository.
set -u

main(){
  local INTERVAL=${INTERVAL:-300}
  local END=$(( $(date +%s) + ${LOOP_MINUTES:-345} * 60 ))
  local URL="${LOG_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
  local n=0 T0 NEXT NOW
  # Logbuch einmal pro Durchgang holen und danach behalten (spart Datenvolumen)
  rm -rf logdata
  if ! git clone -q --depth 1 --branch logs "$URL" logdata 2>/dev/null; then
    mkdir logdata && (cd logdata && git init -q -b logs && git remote add origin "$URL")
  fi
  while :; do
    T0=$(date +%s); n=$((n+1))
    echo "::group::Lauf $n – $(date -u '+%H:%M') UTC"
    git fetch -q origin main && git reset -q --hard origin/main    # immer die neueste Bot-Version
    node --max-old-space-size=6144 bot.mjs || echo "Bot mit Fehler beendet (Meldung per ntfy)"
    save_log "$n"
    echo "::endgroup::"
    NEXT=$(( T0 + INTERVAL )); NOW=$(date +%s)
    [ "$NEXT" -ge "$END" ] && break
    [ "$NEXT" -gt "$NOW" ] && sleep $(( NEXT - NOW ))
  done
  echo "$n Läufe erledigt, starte nächsten Durchgang."
  gh workflow run signale.yml --ref main || echo "Nachfolger konnte nicht gestartet werden; der GitHub-Zeitplan springt ein."
}

# Logbuch als einzelner Commit ohne Verlauf speichern: gelöschte Daten belegen danach keinen Platz mehr
save_log(){
  ( cd logdata || exit 0
    [ -n "$(ls -A | grep -v '^\.git$')" ] || exit 0
    local b="stand-$1-$(date +%s)"
    git checkout -q --orphan "$b" && git add -A \
      && git -c user.name="bitvavo-bot" -c user.email="bitvavo-bot@users.noreply.github.com" commit -qm "Logbuch Stand $(date -u '+%Y-%m-%d %H:%M') UTC" \
      && git push -q --force origin "$b:logs" || exit 1
    git for-each-ref --format='%(refname:short)' refs/heads | grep -vx "$b" | xargs -r git branch -q -D
    # alte Stände stündlich auch lokal wegräumen
    if [ $(( $1 % 12 )) -eq 0 ]; then git reflog expire --expire=now --all && git gc -q --prune=now; fi
  ) || echo "Logbuch nicht gespeichert"
}

main "$@"
exit $?
