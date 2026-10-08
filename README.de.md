<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em><a href="README.md">English</a> · Deutsch</em></p>

# RudariFlow

Lokale Sprache-zu-Text Diktier-App für Windows, angetrieben von [whisper.cpp](https://github.com/ggml-org/whisper.cpp) mit GPU-Beschleunigung. Globale Diktiertaste, Halten oder Umschalten, automatisches Einfügen des transkribierten Texts.

> **v0.16.0, Windows.** Neu in 0.16.0: GPU frei für Spiele (Whisper und die KI machen Platz, solange ein Vollbild-Spiel läuft, und kommen danach zurück), Entladen bei Leerlauf auch am Netz, eine Liste ungenutzter Modelle zum Löschen und Whisper Large v3 Turbo q5 (0,3 GB weniger Grafikspeicher). Neu in 0.15.0: Meetings — nimm einen Online-Call auf (Teams, Zoom, Discord …), lies live mit, getrennt nach dir und den anderen, und erhalte am Ende die Sprecher und KI-Notizen (Zusammenfassung, Entscheidungen, Aufgaben), alles auf deinem PC. Neu in 0.14.1: im Soundboard ein Tastenkürzel, das die Sound-Kürzel ausschaltet, Wiederholen, zwei Spalten, und kein Echo oder Piepen mehr auf deiner Stimme nach einem Sound. Neu in 0.14.0: ein Soundboard wie Soundpad, das Sounds per Tastenkürzel über ein virtuelles Mikrofon zusammen mit deiner Stimme in Discord oder ein Spiel spielt (Tab Soundboard, lässt sich in ein eigenes Fenster lösen), ein Tastenkürzel „GPU freigeben“, das Whisper und das KI-Modell entlädt (etwa 5,6 GB), damit ein Spiel die Grafikkarte bekommt, und ein Knopf „Leeren“ im Tab Dateien. Seit 0.12: im Tab Dateien Sprecher (wer was gesagt hat, mit Namen, die du einmal festlegst), Export als PDF, Word, Untertitel (.srt, .vtt) oder Text, und ein Fenster, das sich vergrößern lässt und seine Größe behält. Seit 0.11: KI-Korrektur über CUDA auf NVIDIA (lange Diktate auf einer RTX 5080 etwa 30 % schneller), Zeitmarken in Dateien, die auch nach Pausen stimmen, Namen aus dem Wörterbuch auch in langen Dateien richtig geschrieben, keine abgeschnittenen Diktate mehr durch eine prellende Maustaste, ein Leerzeichen zwischen zwei Diktaten nacheinander, und Diktate behalten ihre KI-Korrektur, während eine Datei zusammengefasst wird. Seit 0.10: Audio- und Videodateien transkribieren, mit KI-Zusammenfassung (Tab Dateien), das letzte Diktat per Stimme umschreiben, ein Wörterbuch, das aus deinen Korrekturen lernt, eine Sprache pro App, Textbausteine mit Datum und Uhrzeit, lange Diktate, die schon während des Sprechens transkribiert werden, ein PC-Check, der die schnellste Einstellung wählt, und Maus-Seitentasten für jeden Hotkey. Seit 0.9: KI-Korrektur etwa 30 % schneller, Large v3 Turbo q8. Seit 0.8: Wörter auf dem Bildschirm helfen bei Namen und Fachbegriffen. Seit 0.6: Bearbeiten per Stimme, „Schreiben in“, lokale KI-Korrektur mit Regeln pro App, Wörterbuch, Verlauf, Ersetzungen und der Befehl „Abschicken“ (siehe [Changelog](CHANGELOG.md)). Ein Installer für jede GPU: NVIDIA GeForce GTX 16 / RTX läuft über CUDA (Treiber 580 oder neuer), AMD Radeon, Intel Arc und ältere NVIDIA-Karten über Vulkan, alles andere fällt auf die CPU zurück. Das Backend wird zur Laufzeit automatisch gewählt.

Vollständige Versionshistorie siehe [CHANGELOG.md](CHANGELOG.md).

Made by [oggi](https://0ggi.ch).

## Features

- **Fünf Bereiche in einem Fenster:** In der Seitenleiste stehen Start, Dateien, Meetings, Soundboard und Einstellungen, darüber der Status. Das Fenster öffnet dort, wo du es verlassen hast; nur ein erster Start (noch kein Sprachmodell und noch kein Diktat) öffnet auf Start, wo die Einrichtungsschritte stehen
- **Start, die Diktierseite:** deine Tastenkürzel (Diktieren, Letztes einfügen, Letztes umschreiben, GPU freigeben; ein Klick auf eine Taste ändert sie; wo keine vergeben ist, steht „Nicht gesetzt“ im Tastenfeld), die Schalter, die du oft brauchst (KI-Korrektur, Gesprochene Sprache, Schreiben in), was geladen ist (Sprachmodell, KI-Modell, Mikrofon; ein Klick öffnet die Einstellung dazu), ein Feld, das ein Wort ins Wörterbuch aufnimmt, und deine letzten Diktate mit einer Suche nach Text oder App
- **Einstellungen in fünf Tabs:** Diktieren, KI-Korrektur, Wörterbuch, Modelle & GPU und Allgemein. Ein Tab beginnt mit dem, was die meisten ändern; der Rest liegt hinter „Erweitert“ (nur Allgemein hat keinen solchen Bereich). Ein Hinweis ist eine Zeile lang, „Mehr“ öffnet den Rest. Das Fenster merkt sich den Tab und welche Bereiche „Erweitert“ offen sind. Was auch auf Start steht (die Tastenkürzel, KI-Korrektur, Gesprochene Sprache, Schreiben in), zeigt an beiden Orten denselben Wert. Bevor die Einstellungen beim Start gelesen sind, wird nichts gespeichert (die Seiten ruhen für diesen Moment), und ein Speichern, das fehlschlägt, meldet sich in einem Hinweis, der über der Seite liegt, unter ihrem Titel („Speichern nicht möglich: …“; er verschiebt nichts und lässt sich schließen), und setzt das Bedienelement auf den gespeicherten Wert zurück
- **Ein Status:** In der Seitenleiste und neben der Überschrift von Start sagt eine Zeile, was RudariFlow gerade tut oder was fehlt: „Einrichtung nötig“ mit dem Grund (kein Mikrofon, kein Sprachmodell, Groq-Schlüssel fehlt, Modell lädt nicht), „Download n %“, „Aufnahme…“, „Transkription…“, „Meeting läuft“, „Datei wird transkribiert“, „Modelle werden geladen…“, „Für ein Spiel freigegeben“, „GPU freigegeben“ oder „Bereit“. „Bereit“ steht dort nur, wenn ein Diktat klappen würde: Ein Mikrofon ist da, und das Sprachmodell ist heruntergeladen und geladen oder Groq Cloud hat den Schlüssel. Ein Ring daneben zeigt ein Meeting, das aufgenommen wird, oder eine Datei, die läuft, während ein anderer Zustand angezeigt wird
- **Einrichtungsschritte:** Solange ein Mikrofon oder ein Sprachmodell fehlt, zeigt Start anstelle seiner Bedienelemente drei Schritte: das Mikrofon mit Pegelanzeige, das für deine Grafikkarte empfohlene Sprachmodell mit einem Download, der Prozent und Größe zeigt (der Status sagt dabei „Download n %“), und deine Diktiertaste. Der Pegel läuft nur, solange du das Fenster benutzt (bis eine Minute nach deiner letzten Eingabe), und nie in einem Fenster, das nicht angezeigt wurde, etwa beim Start im Tray nach der Anmeldung. Die KI-Korrektur wird auf einer optionalen Karte angeboten („Ausblenden“ räumt sie weg; das Modell lässt sich später unter Einstellungen › KI-Korrektur herunterladen). Ein PC, auf dem noch nie diktiert wurde, wird begrüßt; wer schon diktiert hat und dem heute etwas fehlt (ein ausgestecktes Headset, ein gelöschter Cloud-Schlüssel), sieht das schlichte „Einrichtung nötig“ mit dem Grund und behält die letzten Diktate unter den Schritten, mit Suche und allen Aktionen. Ein Diktat ohne Sprachmodell nimmt nichts auf und meldet das in der Anzeige beim Diktieren (der kleinen schwebenden „Pille“, wie sie hier weiter unten kurz heißt): „Noch kein Sprachmodell. Öffne RudariFlow und lade eines herunter.“
- Lokale Transkription via In-Process whisper-rs — keine Cloud nötig, kein Subprozess pro Diktat
- **Persistentes Modell:** beim Start der App geladen und für weitere Diktate wiederverwendet (im Akkubetrieb nach 10 Minuten ohne Diktat entladen, am Strom nach der Zeit, die du wählst, falls überhaupt; das Tastenkürzel „GPU freigeben“ entlädt es, wann du willst, und „GPU für Spiele freigeben“, wenn ein Spiel im Vollbild läuft)
- **Warmup beim Hotkey-Druck:** ist das Modell nicht geladen, lädt der Hotkey es parallel, sodass es bereit ist, sobald du fertig gesprochen hast
- **Streaming-Partial-Transkripte:** Text erscheint im Overlay, sobald Whisper jedes Segment ausgibt
- **Auto-Backend-Erkennung:** NVIDIA CUDA wenn verfügbar, sonst Vulkan (AMD / Intel / NVIDIA), sonst CPU. Unter Einstellungen › Modelle & GPU › Erweitert stehen die erkannten GPUs, und dort lassen sich CUDA, Vulkan oder CPU erzwingen. Flash Attention ist bei CUDA an und bei Vulkan aus (auf einer RX 6800 doppelt so langsam); erzwingen mit `RUDARIFLOW_FLASH_ATTN=1` oder `=0`
- **PC-Check** (Einstellungen › Modelle & GPU › Erweitert): misst Whisper auf jeder GPU mit Flash Attention an und aus, behält die schnellste Einstellung und liefert einen Bericht zum Kopieren, für Hardware, auf der RudariFlow nie getestet wurde
- **Wörterbuch:** ein Tab der Einstellungen für Namen, Marken und Fachbegriffe, mit Suche. Wörter einzeln hinzufügen oder eine Liste einfügen (Kommas oder eines pro Zeile). Whisper bekommt sie als Prompt, der Text übernimmt ihre genaue Schreibweise, auch wenn Whisper sie leicht anders hört („github“ wird zu „GitHub“, „Grüß'n shop“ zu „Grüssen-Shop“), und die KI-Korrektur erhält die Liste ebenfalls. Ein Schalter für Schweizer Rechtschreibung schreibt ss statt ß. Importieren und Exportieren (unter „Erweitert“) bringen die Liste als einfache Textdatei auf einen anderen PC. **Lernt aus deinen Korrekturen:** korrigierst du direkt nach dem Diktieren einen Namen von Hand, wird das Wort oben im Tab Wörterbuch zum Hinzufügen oder Verwerfen vorgeschlagen (gespeichert wird nur das korrigierte Wort, nie dein Text)
- **No-Speech-Erkennung:** stumme Aufnahmen zeigen einen Hinweis statt nichts einzufügen
- **Clipboard-sicheres Einfügen:** dein vorheriger Zwischenablage-Inhalt wird vor dem Auto-Paste gesichert und danach wiederhergestellt; Diktate landen nicht im Windows-Zwischenablageverlauf (Win+V) und nicht in der Cloud-Zwischenablage
- **Ersetzungen** (Einstellungen › Wörterbuch, mit Suche): sag einen kurzen Ausdruck, erhalte längeren Text, z. B. wird aus „meine Mail“ deine Adresse. Ganze Wörter, Groß-/Kleinschreibung egal; besteht ein Diktat nur aus dem Ausdruck, wird nur die Ersetzung eingefügt. Textbausteine können `{date}`, `{time}`, `{weekday}`, `{year}` und `{iso_date}` enthalten
- **Sprachbefehl „Abschicken“** (Einstellungen › Diktieren › Erweitert): beende ein Diktat mit „Abschicken.“ (Englisch: „Send it.“) als eigenem Satz, und RudariFlow drückt nach dem Einfügen Enter oder Ctrl+Enter. Standardmäßig aus
- **Verlauf** (Start, „Letzte Diktate“): die letzten 200 Diktate bleiben auf deinem Computer, die letzten 50 mit Aufnahme. Nach Text oder App durchsuchen, kopieren, abspielen, löschen oder eine Aufnahme mit dem aktuellen Modell neu transkribieren. Start zeigt die letzten acht; „Alle anzeigen“ öffnet die übrigen auf der Seite, jeweils 50. Die Liste bleibt auf Start, auch solange die Einrichtungsschritte zu sehen sind. Eine Zeile nennt die App, die Uhrzeit und die Länge („01:55 · 6 s“). „Kopieren“ steht immer da, in jeder Zeile an derselben Stelle; die übrigen Aktionen (Original, Abspielen, Neu transkribieren, Löschen) zeigen sich, solange der Zeiger auf der Zeile steht oder der Tastaturfokus in ihr ist. „Verlauf speichern“ unter Einstellungen › Allgemein stellt ihn auf „Nur Text“ oder schaltet ihn aus, und „Verlauf löschen“ leert ihn dort; „Einstellungen zum Verlauf“ unter der Liste führt dorthin
- **Letztes Diktat einfügen:** ein zweites Tastenkürzel (Standard Alt+Shift+V) fügt dein letztes Diktat erneut ein
- **Letztes Diktat umschreiben:** ein drittes Tastenkürzel markiert dein letztes Diktat im Feld, und was du danach sagst, ändert es wie beim Bearbeiten per Stimme („kürzer“, „förmlicher“)
- **GPU freigeben:** ein viertes Tastenkürzel (standardmäßig aus; auf Start oder unter Einstellungen › Diktieren › Erweitert festlegen) entlädt Whisper und das KI-Modell, damit ein Spiel den Grafikspeicher bekommt, etwa 5,6 GB mit Large v3 Turbo q8 und Gemma 4 E4B. Nochmals drücken lädt sie wieder; ein Diktat, eine Datei oder eine Zusammenfassung lädt ebenfalls, was sie braucht, das erste Diktat ein paar Sekunden später als sonst
- **GPU für Spiele freigeben** (Einstellungen › Modelle & GPU › Erweitert, standardmäßig aus): Ist eine App im Vollbild oder randlosen Vollbild 5 Sekunden lang vorne, werden beide Modelle von selbst entladen; ein Videoplayer im Vollbild zählt auch, ein Video im Browser-Vollbild, ein Anruf (Teams, Zoom, Discord), eine Fernsteuerung und der Desktop nicht. Diktieren geht beim Spielen trotzdem: Ein Diktat lädt nur Whisper (etwa 1 GB), fügt ohne KI-Korrektur ein und entlädt es wieder; Bearbeiten und „Letztes Diktat umschreiben“ sind aus, bis das Spiel vorbei ist. Das Spiel gilt als laufend, solange sein Fenster offen und im Vollbild bleibt, auch während du ein anderes Fenster benutzt (Discord auf einem anderen Bildschirm); 30 Sekunden nachdem es geschlossen, minimiert oder nicht mehr im Vollbild ist, laden die Modelle wieder. Lädst du sie während eines Spiels mit dem Tastenkürzel „GPU freigeben“, bleiben sie geladen, bis es vorbei ist
- **Entladen, wenn ungenutzt** (Einstellungen › Modelle & GPU › Erweitert): am Strom die Modelle nach 15 Minuten, 30 Minuten oder 1 Stunde ohne Diktat entladen (standardmäßig nie; im Akkubetrieb immer nach 10 Minuten); Anfragen eines anderen Programms an die KI (der Twitch-Untertiteldienst) zählen als Nutzung
- **Ungenutzte Modelle** (Einstellungen › Modelle & GPU › Erweitert): zeigt heruntergeladene Whisper- und KI-Modelle, die keine Einstellung verwendet, und unvollständige Downloads, mit ihrer Größe, und löscht die, die du auswählst (nach einem zweiten Klick); nie von selbst
- **Andere Apps während der Aufnahme stummschalten:** Musik und Videos verstummen, während du diktierst, und kommen danach zurück (standardmäßig aus; nicht, solange ein Meeting aufgenommen wird, das sonst die Stille aufnähme)
- **Wörter auf dem Bildschirm:** Namen und Begriffe im Fenster, in das du diktierst (der Name in einer E-Mail, eine Marke auf einer Website, Bezeichner im Editor), helfen Whisper und der KI bei der Schreibweise. Wird lokal beim Drücken des Hotkeys gelesen, nie gespeichert
- **Bearbeiten per Stimme:** Text in einer beliebigen App markieren, Diktiertaste halten und sagen, was sich ändern soll („kürzer“, „förmlicher“, „auf Türkisch“, „lösch das“), oder den neuen Wortlaut sprechen; das lokale Modell schreibt die Markierung an Ort und Stelle um, Ctrl+Z macht es rückgängig. Terminals, Adressleisten und Passwortfelder bleiben unberührt
- **KI-Korrektur, komplett lokal:** ein KI-Modell auf deinem PC entfernt Füllwörter, übernimmt gesprochene Korrekturen („Dienstag, nein, Mittwoch“), korrigiert Grammatik und Satzzeichen, macht Listen und glättet im Stil „Geschliffen“ deine Sätze. Es behält die gesprochene Sprache und beantwortet nie, was du diktierst; stellst du bei „Schreiben in“ eine Sprache ein, schreibt es jedes Diktat in dieser Sprache und übersetzt, wenn du beim Sprechen die Sprache wechselst. Regeln pro App („kleingeschrieben in WhatsApp“, „formell in Outlook“, „keine KI in VS Code“) passen auf das Programm oder ein Wort im Fenstertitel, funktionieren so auch für Websites und können die Sprache festlegen, auf die Whisper in dieser App hört. Läuft mit Gemma 4 (standardmäßig E4B, wahlweise 12B oder E2B) in einem mitgelieferten llama.cpp-Server; das Modell wird einmal heruntergeladen (3 bis 7 GB), danach verlässt nichts deinen PC. Ist das Modell nicht bereit oder zu langsam, wird der reine Whisper-Text eingefügt. Standardmäßig aus
- Mehrere Sprachmodelle (Whisper) wählbar (Einstellungen › Modelle & GPU): tiny → large-v3-turbo, mit Auto-Download bei Auswahl. „Mehr“ in der Zeile listet alle acht mit Größe und einer Zeile zu jedem, damit man über ein Modell lesen kann, ohne es zu wählen (und herunterzuladen); das für die Grafikkarte dieses PCs empfohlene ist dort und in der Auswahl markiert. Der Download steht in der Zeile des Modells, mit Prozent und Größe; wird er nicht fertig, steht das dort mit dem Grund (oder, wo keiner bekannt ist, mit dem Rat, die Verbindung zu prüfen) und „Wiederholen“, und ein Modell wird erst als deine Wahl gespeichert, wenn es auf der Festplatte liegt. Large v3 Turbo q8 lieferte auf 49 Testaufnahmen denselben Text wie Turbo, 18 % schneller und mit halbem Speicher; Large v3 Turbo q5 (~574 MB) spart noch etwa 0,3 GB Grafikspeicher bei gleichem Tempo
- Sprachen: Auto-Erkennung oder eine der rund 100 Sprachen, die Whisper kann
- **Lange Diktate in Teilen:** alle 29 s wird in einer Pause ein Teil abgeschnitten und transkribiert, während du weitersprichst, nach dem Loslassen bleibt nur der Rest
- **Dateien transkribieren** (Dateien): eine Audio- oder Videodatei aufs Fenster ziehen (MP3, M4A, WAV, FLAC, WhatsApp-Sprachnachrichten, MP4, MOV, MKV, WebM), der Text erscheint Minute für Minute, mit Zeitmarken und Kopieren; ist eine Datei geladen, schrumpfen die Ablagefläche und die Optionen auf je eine Zeile (die Hinweise der Optionen stehen hinter „Mehr“), damit der Text weiter oben beginnt; Export als PDF, Word (.docx) oder Text, mit oder ohne Zeitmarken und der Zusammenfassung oben, wenn eine angezeigt wird, oder als Untertitel (.srt, .vtt), immer mit Zeitmarken; Sprecher trennen (Automatisch oder 2 bis 8, Namen, die du einmal festlegst; ein Sprechermodell mit 45 MB wird beim ersten Gebrauch heruntergeladen und läuft auf der CPU, etwa 3,5 % der Audiolänge auf einem Ryzen 9 7900X, 8 Threads); das lokale KI-Modell fasst ihn zusammen (Kernpunkte, nächste Schritte), die Zusammenfassung lässt sich ausblenden, damit der Text mehr Platz hat; „Transkript entfernen“ macht die Seite frei für die nächste Datei (fragt zuerst „Transkript entfernen?“). Etwa 40-fache Echtzeit auf einer RX 6800. Diktieren geht weiter, während eine Datei läuft
- **Meetings** (Meetings): ein Online-Gespräch auf diesem PC aufnehmen (Teams, Zoom, Discord, Google Meet …), mit einem Knopf, im Tray-Menü oder mit einem optionalen Tastenkürzel (Einstellungen › Diktieren › Erweitert); von selbst nimmt nichts auf. RudariFlow nimmt zwei Spuren auf, dein Mikrofon („Du“) und was der PC abspielt („Andere“: der Windows-Standardausgang, folgt also auch einem frisch eingesteckten Headset; ein Gesprächsprogramm, das auf einem anderen Ausgabegerät spielt, wird nicht gehört), und transkribiert sie live mit deinem Whisper-Modell, deiner Sprache und deinem Wörterbuch, mit einer GPU etwa eine halbe Minute hinterher (auf der CPU länger); ein Diktat geht trotzdem vor, und nach „GPU freigeben“ läuft die Aufnahme weiter, der Text holt auf, sobald die Modelle wieder geladen sind. „Beenden“ lädt die Modelle wieder, wenn sie davor freigegeben wurden, für den Rest des Transkripts und die Notizen. Nach „Beenden“ werden die anderen unterschieden (Sprecher 1, 2, … mit dem Sprechermodell von Dateien; ein Klick auf den Namen benennt um), und das lokale KI-Modell schreibt die Notizen: Zusammenfassung, Entscheidungen und Aufgaben (eine Checkliste); ist die KI-Korrektur aus, gibt es Notizen erst mit einem Klick auf „Notizen schreiben“. ▶ bei einem Absatz spielt das Meeting ab dort ab (nicht, solange ein Meeting aufgenommen wird: es würde mit aufgenommen); Export als PDF, Word, Text oder Untertitel mit den Notizen oben; die Liste lässt sich nach Titel und Transkript durchsuchen. Ein Meeting, das ein Absturz oder das Beenden von RudariFlow abgebrochen hat, bleibt erhalten, und „Abschließen“ transkribiert den Rest und schreibt die Notizen; nach 4 Stunden endet ein Meeting von selbst. Der Ton bleibt 30 Tage, der Text, bis du das Meeting löschst. Sag den anderen, dass du aufnimmst: In der Schweiz und an vielen anderen Orten ist es verboten, ein Gespräch ohne ihr Einverständnis aufzunehmen
- **Soundboard** (Soundboard): Sounds per Tastenkürzel für Discord und Spiele, wie Soundpad. Die Sounds stehen zuerst, als Kacheln; eine Leiste darüber enthält den Schalter des virtuellen Mikrofons, „Alle stoppen“, „In eigenem Fenster öffnen“ und „Soundboard-Einstellungen“. Dieser Knopf öffnet einen Bereich mit den Lautstärken, „Sounds übereinander abspielen“, dem Schalter „Sound-Tastenkürzel“ samt seiner Taste, der Taste für „Alle Sounds stoppen“ und den Geräten (in einem breiten Fenster neben den Sounds; in einem schmalen und im eigenen Fenster zuerst geschlossen; das Fenster merkt sich deine Wahl). Schalte das virtuelle Mikrofon ein, und RudariFlow schickt dein Mikrofon und die Sounds in das kostenlose [VB-Audio Virtual Cable](https://vb-audio.com/Cable/), das deine Sprach-App als Mikrofon nutzt („CABLE Output“); du hörst die Sounds in deinen Kopfhörern in deiner eigenen Lautstärke, nie deine eigene Stimme. Füge AAC-, FLAC-, M4A-, MP3-, OGG-, OPUS-, WAV- oder WMA-Dateien per Auswahl oder Ziehen hinzu (bis 30 Minuten je Sound; RudariFlow legt Kopien in seinem Datenordner ab), ordne sie in Kategorien, durchsuche sie und gib jedem ein Tastenkürzel: eine Taste (Ziffernblock und F-Tasten auch allein), eine Kombination oder eine Maus-Seitentaste. Ein neuer Sound ersetzt den laufenden oder spielt darüber, dasselbe Kürzel stoppt ihn, und ein Kürzel „Alle Sounds stoppen“ stoppt alles; mit dem Wiederholen-Knopf eines Sounds läuft er ohne Lücke immer wieder, bis du ihn stoppst; die Kürzel der Sounds sind anderen Programmen nur entzogen, solange das virtuelle Mikrofon an ist. Ein Schalter „Sound-Tastenkürzel“ oder ein eigenes Tastenkürzel dafür (die Pille zeigt „Sound-Tastenkürzel aus“ / „ein“) schaltet die Kürzel der Sounds aus, damit du keinen aus Versehen abspielst: Sie bleiben zugewiesen, bewirken aber nichts, die Tasten funktionieren in anderen Programmen wieder normal, und „Alle Sounds stoppen“ und das Anklicken eines Sounds wirken weiter. Das Soundboard lässt sich in ein eigenes Fenster lösen, das im Vordergrund bleiben kann
- **Fenster anpassbar:** lässt sich in der Größe ändern und maximieren, nie kleiner als 900×600, und merkt sich Größe und Position. Jede Seite reicht von einem gemeinsamen linken Rand bis zum rechten Rand des Fensters, in jeder Größe, und hat darin Spalten: in einem kleinen Fenster eine; ab etwa 1100 px Fensterbreite hat Start zwei (Bedienelemente, Diktate), und das Soundboard zeigt seine Einstellungen neben den Sounds; ab etwa 1450 px haben ein Tab der Einstellungen, die Liste der Meetings, ein offenes Meeting (links seine Notizen oder was an ihrer Stelle gesagt wird, rechts das Transkript) und Dateien mit einer Datei (links die Datei, ihre Optionen und ihre Zusammenfassung, rechts das Transkript) zwei Spalten; ab etwa 1800 px stehen auch die Bedienelemente von Start in zwei Spalten und die Einrichtungsschritte neben den letzten Diktaten. Im kleinsten Fenster stehen die vier Tasten von Start zwei mal zwei, damit die letzten Diktate ohne Scrollen beginnen. Fließtext (ein Transkript, Notizen, eine Zusammenfassung) behält eine lesbare Zeilenlänge, wie breit sein Rahmen auch ist
- **Löschen geht überall gleich:** Ein Knopf „Löschen“ fragt auf sich selbst nach: „Löschen“, dann „Löschen?“. Esc, ein Klick daneben oder das Wegscrollen des Knopfs nimmt die Frage zurück, und ein Doppelklick oder ein gehaltenes Enter löscht nichts. „Transkript entfernen“ in Dateien und „Verlauf löschen“ funktionieren genauso, und ein Löschen, das fehlschlägt, meldet das auf seinem Knopf
- **Ruhiges Aussehen, wenig Bewegung:** ein dunkles Design mit größerer Schrift und mehr Raum. Die Schrift wird mit der App ausgeliefert, das Fenster fragt also nichts bei Google Fonts an. Nur ein Seitenwechsel und ein Bereich, der aufklappt, bewegen sich (150 ms), und nichts wird animiert, wenn Windows auf reduzierte Bewegung gestellt ist
- **Tastatur und Screenreader:** Jedes Bedienelement ist mit Tab erreichbar, zeigt den Fokus und hat einen Namen; der Status, Anfang und Ende eines Downloads, das Ende einer Datei-Transkription, ein fehlgeschlagenes Speichern und das Ergebnis einer Suche werden vorgelesen. Der Titel einer Seite ist ihre erste Überschrift, und ein Schalter ist für einen Screenreader ein Schalter
- **Windows-Kontrastdesigns:** Mit einem Kontrastdesign (in Windows unter Einstellungen › Barrierefreiheit) hat jedes Bedienelement einen Rand, und was an oder ausgewählt ist (ein Schalter, ein Tab, die aktuelle Seite, ein gewählter Chip, ein Sound in Schleife oder beim Abspielen, ein scharfes „Löschen“, ein Fortschrittsbalken), trägt die Hervorhebungsfarben des Designs
- **Halten** oder **Umschalten:** die Diktiertaste halten und sprechen, oder einmal drücken für Start und einmal für Stopp
- Konfigurierbare globale Hotkeys (ein Tastenfeld auf Start oder unter Einstellungen › Diktieren anklicken und die Tasten drücken), auch Maus-Seitentasten (Maus 4 / Maus 5, allein oder mit Ctrl/Shift/Alt/Win) für alle fünf Hotkeys und die des Soundboards, sodass eine Taste zwei Aufgaben haben kann (Maus 5 diktiert, Shift+Maus 5 schreibt um). Eine belegte Seitentaste wird abgefangen und löst in anderen Programmen kein „Zurück“/„Vorwärts“ mehr aus. Ctrl+A, C, V, X, Z, Y und S werden abgelehnt, weil sie sonst in keinem Programm mehr funktionieren
- Schwebende Anzeige beim Diktieren (die „Pille“) mit Live-Wellenform und Abbrechen-Knopf, in der Schrift und den Farben des Fensters
- Auto-Einfügen via Tastatur-Simulation (kompatibel mit allen Anwendungen)
- System-Tray-Icon — X minimiert in den Tray statt Beenden
- Optional: mit Windows-Anmeldung starten
- UI in Deutsch und Englisch (nach der Sprache von Windows gewählt); Fenster, Pille und Tray-Menü folgen der Anzeigesprache (Einstellungen › Allgemein), ohne Neustart

## System-Voraussetzungen

- **OS:** Windows 10/11 x64
- **GPU (empfohlen), nur aktueller Treiber, keine zusätzliche Runtime:**
  - NVIDIA GeForce GTX 16 / RTX 20 oder neuer: CUDA (Treiber 580 oder neuer; mit älterem Treiber und auf älteren NVIDIA-Karten Vulkan)
  - AMD Radeon RX 6000 oder neuer (AMD Software: Adrenalin Edition): Vulkan
  - Intel Arc und andere Vulkan-1.2-GPUs: Vulkan
  - Mit integrierter und dedizierter GPU wird die dedizierte genutzt.
- **CPU-Fallback:** Funktioniert auch ohne nutzbare GPU, dann deutlich langsamer (~10-30×). Für CPU-Nutzer: small oder medium Modell empfohlen
- **RAM:** Das gewählte Whisper-Modell lädt beim Start und bleibt resident. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB. Im Akkubetrieb werden die Modelle nach 10 Minuten ohne Diktat entladen und beim nächsten Hotkey wieder geladen. Das Tastenkürzel „GPU freigeben“ entlädt sie auf Wunsch, z. B. vor einem Spiel.
- **KI-Korrektur (optional):** läuft auf derselben Karte wie Whisper, mit dem normalen Treiber: über CUDA auf NVIDIA GeForce GTX 16 / RTX 20 und neuer (Treiber 580 oder neuer), über Vulkan auf AMD, Intel und älteren NVIDIA-Karten. Das Standardmodell belegt etwa 3,6 GB Grafikspeicher zusätzlich zu Whisper und etwa 3,3 GB RAM. Gemessen: etwa 0,3 s pro Diktat auf einer AMD Radeon RX 6800 (Vulkan), etwa 0,09 s auf einer NVIDIA GeForce RTX 5080 (CUDA).

## Installation (für Endbenutzer)

Lade die neueste `RudariFlow_x.y.z_x64-setup.exe` aus den [Releases](https://github.com/oggii/RudariFlow/releases) herunter und führe sie aus.

## Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (MSVC toolchain auf Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools mit C++ workload (für `cargo build`)
- [CMake](https://cmake.org/) und [LLVM](https://llvm.org/) (libclang, für das bindgen von `whisper-rs-sys`)
- [Vulkan SDK](https://vulkan.lunarg.com/) (liefert `glslc` für die Vulkan-Shader von whisper.cpp; `VULKAN_SDK` muss gesetzt sein)
- [CUDA Toolkit 13.x](https://developer.nvidia.com/cuda-downloads) (13.4, die Version des mitgelieferten llama.cpp-CUDA-Backends; Compiler und cuBLAS reichen, zum Bauen ist keine NVIDIA-GPU nötig)

### Setup

```powershell
# 1. Repo klonen
git clone https://github.com/oggii/RudariFlow.git
cd RudariFlow

# 2. Frontend-Dependencies
npm install

# 3. GPU-Runtime-DLLs einsammeln, die neben der exe ausgeliefert werden
#    (CUDA-Runtime aus CUDA_PATH, Vulkan-Loader aus System32)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1

# 3b. llama.cpp-Server für die KI-Korrektur holen: Vulkan-Build und sein
#     CUDA-Backend (festgelegte Builds, SHA-256 geprüft)
powershell -ExecutionPolicy Bypass -File scripts/setup-llama.ps1

# 3c. whisper-rs-sys entpacken und die whisper.cpp-Patches aus patches\ anwenden
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper-patch.ps1

# 3d. sherpa-onnx-Runtime für die Sprechertrennung holen (festgelegte Version, SHA-256 geprüft)
powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1

# 4. Build-Pfad kurz halten: der verschachtelte Vulkan-Shader-Build von
#    whisper.cpp sprengt unter src-tauri\target das 260-Zeichen-Limit (und
#    auch unter C:\t\rf, ausser lange Pfade sind in Windows aktiviert)
$env:CARGO_TARGET_DIR = "C:\r"
$env:CUDAARCHS = "75;80;86;89;120"   # RTX 20, 30, A-Serie, 40, 50

# 5. Dev-Modus starten
npm run tauri dev
```

Ohne CUDA Toolkit lässt sich ein reiner Vulkan-Build bauen:
`npm run tauri dev -- --no-default-features --features vulkan`.

`cargo run`, Beispiele und Dev-Builds brauchen `src-tauri\binaries\sherpa-onnx\lib` im PATH
für die Sprechertrennung (der Installer legt die DLLs neben die exe).

### Production Build

```powershell
npm run tauri build
```

Für ein Release in einem frischen `CARGO_TARGET_DIR` mit höchstens 4 Zeichen bauen (z. B. `C:\q`), mit `$env:CUDAARCHS = "75;80;86;89;120"`: whisper-rs-sys baut whisper.cpp nicht neu, wenn sich `CUDAARCHS` oder eine `GGML_*`-Einstellung ändert, ein wiederverwendeter Ordner behält also seine alten GPU- und CPU-Ziele. `src-tauri/.cargo/config.toml` setzt `GGML_NATIVE=OFF`, damit whisper.cpp auf jeder CPU mit AVX2 läuft und nicht nur auf CPUs wie der des Build-PCs. Das Ergebnis prüfen: `dumpbin /disasm` von `rudariflow.exe` darf kein `zmm`-Register zeigen (AVX-512-Code, mit dem 0.11.0 auf Prozessoren ohne AVX-512 abstürzte). `npm run tauri build` kann die Zeilenenden von `src-tauri/Cargo.toml` umschreiben; ist das die einzige Änderung, danach `git checkout -- src-tauri/Cargo.toml`.

Erzeugt (unter `CARGO_TARGET_DIR`):
- `release/rudariflow.exe` (portable, braucht die DLLs aus Schritt 3 daneben)
- `release/bundle/nsis/RudariFlow_x.y.z_x64-setup.exe` (Installer)
- `release/bundle/msi/RudariFlow_x.y.z_x64_en-US.msi`

### UI-Check

`tools/ui-check` baut das Frontend und öffnet jede seiner Seiten in einem Chromium ohne Fenster, mit einem nachgebildeten Backend; die App wird nicht gestartet, und Rust ist nicht nötig. Geprüft werden 112 Seiten: die fünf Bereiche, jeder Tab der Einstellungen mit geschlossenem und offenem Bereich „Erweitert“, der erste Start, das eigene Fenster des Soundboards, die Pille, 60 Zustände, die von Hand schwer zu erreichen sind (ein Tastenfeld, das auf seine Taste wartet, ein fehlgeschlagener Download, die Warnungen eines Meetings, eine laufende Datei, ein Diktat, das in der Pille wächst, die Einrichtungsschritte über einem Verlauf, ein Speichern, das das Backend ablehnt), und was sich nur über die Zeit zeigt: der Start mit einem langsamen Backend Bild für Bild, ein Klick, während die Einstellungen noch laden, ein Wechsel der Anzeigesprache, ein Windows-Kontrastdesign. Eine Seite besucht die Formen aller anderen und verlangt, dass jede am selben linken Rand beginnt und am selben rechten Rand endet, und sie fährt die Fensterbreiten ab, an denen eine Seite mehr Spalten bekommt, mit sichtbarer Bildlaufleiste, damit dort kein Layout kippt. Eine Zustandsseite weist zuerst nach, dass ihr Zustand wirklich zu sehen ist: Eine Seite, die ihn nie erreicht hat, fällt durch, statt mit der Seite im Ruhezustand zu bestehen. Jede Seite wird auf Deutsch und Englisch geöffnet, mit den Daten eines PCs im täglichen Gebrauch und denen eines neuen, in 2560×1392, 1600×900 und 900×600; einige Seiten bringen eigene Größen mit.

Ein Lauf schlägt fehl, wenn etwas aus seinem Kasten ragt oder die Seite seitwärts scrollt, Text abgeschnitten ist oder sich überlappt, Text weniger Kontrast als 4,5:1 hat, ein Bedienelement keinen Namen hat, mit Tab nicht erreichbar ist, keinen Fokus zeigt oder kleiner als 24 px ist, die Seitenleiste nicht in 900×600 passt, ein Hinweis mehr Zeilen braucht, als seine Zeile erlaubt (eine, wo sie den Platz hat, zwei in einer schmalen Spalte), ein Text in einer Sprache fehlt oder einen Gedankenstrich enthält, eine Einstellung von ihrem Bedienelement aus nicht mehr gespeichert wird, das Frontend einen Backend-Befehl oder die id eines Bedienelements verloren hat oder ein Stylesheet den gemeinsamen Standard verlässt (Farben und Schriftgrößen aus den Tokens, Bewegung nur für einen Seitenwechsel und einen aufklappenden Bereich).

```powershell
# einmalig: die eigenen Abhängigkeiten des Tools und sein Browser
cd tools\ui-check; npm install; npx playwright install chromium; cd ..\..

npm run ui-check                                                    # alles, mit Screenshots in tools\ui-check\shots
node tools/ui-check/run.mjs --no-shots                              # nur die Prüfungen, etwa 20 Minuten
node tools/ui-check/run.mjs --no-shots --pages "home,settings-*"    # nur diese Seiten
node tools/ui-check/run.mjs --no-build --pages home --size 900x600  # eine Fenstergröße, mit dem Build des letzten Laufs
node tools/ui-check/run.mjs --no-shots --times                      # zusätzlich die Sekunden pro Seite
```

Exit-Code 0 heißt nichts Neues, 1 ein Befund, 2, dass der Lauf nicht starten konnte (ein unbekanntes Argument, ein `--pages`-Filter, der keine Seite trifft). Nur ein Lauf ohne `--pages`, `--size`, `--lang` und `--scenario` ist die volle Prüfung. Immer nur ein Lauf gleichzeitig: Die Läufe teilen sich einen Build-Ordner. `--task N` gehört zu Arbeit, die in nummerierte Aufgaben geteilt ist: Ein Befund, den eine spätere Aufgabe behebt, kann mit `until: <Aufgabe>` in `tools/ui-check/allow.json` stehen, und `--task N` lässt die Einträge mit `until` bis N nicht mehr gelten. Die Liste ist jetzt leer und wird nur kürzer.

### Tests

```powershell
npm run test:unit   # 74 Tests der reinen Module des Frontends (tests\unit), mit Nodes eigenem Test-Runner
npx tsc --noEmit    # prüft die Typen in src; bei den Unit-Tests entfernt Node die Typen, geprüft werden sie nicht
```

`npm run test:unit` braucht Node 22.18 oder neuer, das TypeScript-Dateien direkt ausführt.

Die Rust-Tests nur gefiltert ausführen, aus `src-tauri`: `cargo test --no-default-features --lib <Filter>` für die Bibliothek, `--bins <Filter>` für `main.rs`. Nie die ganze Suite: Die Tests in `paste.rs` überschreiben die Zwischenablage des Systems. `--no-default-features` lässt die GPU-Backends weg, diese Builds brauchen also weder das Vulkan SDK noch das CUDA Toolkit.

### Testdaten getrennt von der installierten App

Einstellungen, Modelle und Verlauf liegen in `%APPDATA%\com.rudariflow.app`. Damit ein Dev-Build neben einer installierten RudariFlow deren Daten nicht anfasst, einen anderen Ordner angeben:

```powershell
$env:RUDARIFLOW_DATA_DIR = "C:\t\rf-test-data"
```

Ohne diese Angabe nutzt ein Dev-Build die Daten der installierten App und schreibt in deren `startup.log`, oder er holt, solange die installierte App läuft, nur deren Fenster nach vorn und beendet sich. Ein Build, der startet, nimmt den Tastaturfokus: Starte keinen, während du woanders tippst. Arbeit nur am Frontend (TypeScript, CSS, der UI-Check, die Unit-Tests) braucht nur Node und keine laufende App.

### Benchmark

```powershell
cd src-tauri
cargo run --release --example bench -- "$env:APPDATA\com.rudariflow.app\ggml-large-v3-turbo.bin" pfad\zu\16khz-mono.wav
```

Misst Modell-Ladezeit und Transkription auf der ersten GPU mit und ohne Flash Attention sowie auf CPU.

### Konventionen

- Jeder Text der Oberfläche existiert auf Englisch und Deutsch: die des Fensters in `src/i18n.ts`, die der Pille in `NOTICE_TEXT` in `src/overlay.html`, die des Tray-Menüs in `src-tauri/src/main.rs`. Der UI-Check schlägt fehl, wenn ein Schlüssel in einer Sprache fehlt.
- Eine Commit-Nachricht besteht aus einem Betreff, der mit `feat:`, `fix:`, `docs:`, `test:` oder `build:` beginnt, einer Leerzeile und den Trailern. Ein Commit, der mit Claude Code entstanden ist, endet mit dessen `Co-Authored-By:`-Zeile; `git commit -F -` mit einem Heredoc hält die Leerzeile an ihrem Platz.

## Architektur

- **KI-Korrektur:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (Release b11100: der Vulkan-Build plus das CUDA-13.4-Backend `ggml-cuda.dll`, das die für Whisper mitgelieferte CUDA-Laufzeit nutzt) als eigener Prozess auf 127.0.0.1 mit zufälligem Port und API-Schlüssel, in einem Job-Objekt, das ihn mit RudariFlow beendet; Gemma-4-Modelle (Apache-2.0) von Hugging Face. Ein eigener Prozess ist nötig, weil whisper-rs seine eigene ggml-Kopie in `rudariflow.exe` einbindet
- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite auf einer `index.html`; Design-Tokens und gemeinsame Komponenten in `src/styles`, IBM Plex Sans über `@fontsource/ibm-plex-sans` mitgeliefert. Was das Fenster sich von der Ansicht merkt (den Ort, an dem es verlassen wurde, offene Bereiche), liegt im Local Storage des Webviews, Einstellungen bleiben in `config.json`
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (Cross-platform low-level audio I/O)
- **Transkription:** In-Process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust-Bindings) gebaut mit `cuda`- und `vulkan`-Feature; das Backend wird zur Laufzeit aus der ggml-Geräteliste gewählt, mit Fallback auf CPU
- **Dateien:** Windows Media Foundation liest Audio- und Videodateien; Ogg Opus (WhatsApp-Sprachnachrichten), das Windows nicht öffnen kann, läuft über [libopus](https://opus-codec.org) mit den Crates `opus` und `ogg`, und Ogg Vorbis über [lewton](https://github.com/RustAudio/lewton) (mit [rubato](https://github.com/HEnquist/rubato) umgetaktet)
- **Sprecher:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.12.9 (Pyannote-Segmentierung 3.0, 3D-Speaker ERes2Net), dynamisch gelinkte DLLs, die `rudariflow.exe` delay-lädt
- **Export:** Word über docx-rs, PDF über WebView2s PrintToPdf
- **Soundboard:** [cpal](https://github.com/RustAudio/cpal) über WASAPI im geteilten Modus: das Mikrofon hinein, das virtuelle Kabel und die Kopfhörer hinaus, jedes in seinem eigenen Format; das Mikrofon erreicht das Kabel über einen Puffer, der seine Verzögerung bei auseinanderlaufenden Takten um 20 ms hält. Sounds werden einmal von Media Foundation, Ogg Opus von libopus und Ogg Vorbis von [lewton](https://github.com/RustAudio/lewton) (mit [rubato](https://github.com/HEnquist/rubato) umgetaktet) in 48-kHz-WAV-Kopien umgewandelt, die ein Lese-Thread pro laufendem Sound etwa eine Sekunde im Voraus streamt
- **Meetings:** zwei cpal-Aufnahmestreams über WASAPI im geteilten Modus, das Mikrofon (der Windows-Standardeingang, wenn das gewählte fehlt) und Loopback des Windows-Standardausgangs, in 16 kHz Mono umgewandelt und jede Sekunde an zwei WAV-Dateien angehängt (Stille füllt eine Spur, bei der das Loopback nichts lieferte, damit beide im Takt bleiben); ein verlorenes Gerät wird alle 3 s neu geöffnet, während die andere Spur weiter aufnimmt. Ein Worker schneidet jede wachsende Spur in Stücke von 15–30 s, die in einer Pause enden, und transkribiert sie mit einem eigenen Whisper-Zustand; ein Tor lässt ein Diktat vor Meeting-Stücken und Meeting-Stücke vor den Blöcken von Dateien laufen. Nach „Beenden“ trennt sherpa-onnx die Spur der anderen, und das KI-Modell schreibt die Notizen unter drei festen Überschriften
- **Auto-Paste:** [enigo](https://github.com/enigo-rs/enigo) (Tastatur-Simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Lizenz / Credits

RudariFlow ist unter der **[MIT-Lizenz](LICENSE)** veröffentlicht — frei zur Nutzung, Modifikation, Weiterverbreitung und Einbindung in proprietäre Projekte, mit Namensnennung.

Basiert auf der initialen Tauri-Vorlage von [albertshiney/typr](https://github.com/albertshiney/typr).
Verwendet [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) für die Transkription.
Die Oberfläche ist in [IBM Plex Sans](https://github.com/IBM/plex) gesetzt (© IBM Corp., SIL Open Font License 1.1; die Lizenz liegt in [licenses/IBM-Plex-Sans-OFL.txt](licenses/IBM-Plex-Sans-OFL.txt)), ausgeliefert mit der App über [@fontsource/ibm-plex-sans](https://www.npmjs.com/package/@fontsource/ibm-plex-sans).

© 2026 [oggi](https://0ggi.ch).
